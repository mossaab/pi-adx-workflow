/**
 * adx-workflow: sub-agent propagation (in-house, child-process based).
 *
 * Spawns flow sub-agents (adx-verifier, adx-code-reviewer) as isolated
 * `pi -p` child processes:
 *
 *   pi -p --mode json
 *      --extension <adx-workflow>      (child registers flow_meta via ADX_CHILD=1)
 *      --no-extensions --no-mcp --no-skills
 *      --tools "read,bash,flow_meta"
 *      --session-dir <cwd>/.pi/adx-flow/sessions
 *      --session-id <runId>           (fresh run)   |  --session <runId> (resume)
 *      --append-system-prompt <agent role prompt>
 *      "<task>"
 *
 * Why child processes (instead of pi-subagents retained children):
 * - fresh session per run → no retained in-process agent state → the
 *   "Agent is already processing" jam (stuck child session blocking all
 *   subsequent spawns) is structurally impossible;
 * - process-level timeout + kill → provider hangs are bounded;
 * - the child loads only our extension (flow_meta) → no crosstalk with
 *   other extensions' retained children.
 *
 * Result contract (unchanged): the child updates the shared store via
 * flow_meta (verifier → criteria status; reviewer → review_findings) and
 * writes a short report to `.pi/adx-flow/reports/<agent>.md`.
 *
 * Resume (never-stop): re-spawn with `--session <runId>` + a continue note.
 * The child session file persists, so the child picks up its own context.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// ============================================================================
// Agent definitions
// ============================================================================
const VERIFIER_PROMPT = `You are an independent acceptance-criteria verifier.
You will be given:
- A task summary
- Criteria to verify (with status markers)
- Modified files
## YOUR TASK
For each criterion marked [NEEDS VERIFICATION]:
1. Consider the task summary and criterion description
2. If the criterion requires code changes, read the modified files and verify the implementation
3. If the criterion is conceptual or doesn't require code (e.g., test/placeholder criteria), verify based on the description alone
4. Run tests or commands only if applicable to the criterion — keep the effort PROPORTIONAL to the project size (for a small project, a focused read plus one smoke run of the main flows is enough; do not build an exhaustive test suite)
Then record the results with a SINGLE flow_meta call: action "update_batch", key "criteria", items: one {"id", "status"} object per verified criterion — "passed" if the criterion is satisfied, "failed" if it is NOT (explain why clearly in your report). The batch call is atomic; do NOT issue parallel single-item updates (they can lose writes).
## LIVE PROGRESS (display-only)
So the user's UI can show you working, log short notes with flow_meta (action "add", key "progress"):
- When you START verifying a criterion: "Verifying <id>: <short name>…"
- When you FINISH one: "<id> passed: <one-line why>" or "<id> failed: <one-line why>"
Keep each note to a single short line. The "progress" key is display-only: it never affects workflow transitions and does not need cleanup.
## IMPORTANT
- Start by analyzing what each criterion actually requires
- For trivial or non-code criteria, pass them immediately without exploring the codebase
- For code-related criteria, focus on the modified files provided
- Be thorough but efficient — don't explore unnecessarily
- Only fail criteria that genuinely don't meet the requirement
- Provide clear, actionable feedback when failing
- Do not re-verify criteria already marked [PASSED]
- Do NOT edit source files. You may run read-only commands and tests.
- **Never leave the task half-finished.** If you must stop (for example context pressure), write a progress note in your report file (what you verified so far, what remains) before stopping — the parent may resume you to finish.
- When done, write a short report (what you verified, what passed, what failed and why) to the report file named in your task, and stop.`
const REVIEWER_PROMPT = `You are a code reviewer. Review the **git diff** of the modified files rather than reading the full files.
You're mostly interested in:
1. **For the user (UX interaction)** — does this feel good to use? Any rough edges, confusing behavior, or unnecessary friction?
2. **For the project (code quality + guidelines)** — does it follow project conventions? Is it maintainable? Does it bloat the software?
You're not looking for 100% perfection. Just something that feels good to use and doesn't bloat the software.
## Managing Findings
Use the flow_meta tool to track your findings under key "review_findings":
- **First review**: Create findings with action "add", key "review_findings". Set status to "open" and include a clear, actionable description of the issue (the builder must know exactly what to fix).
- **Re-review** (findings already exist): Check existing "review_findings" with action "get". If a finding has been addressed, update its status to "resolved". If it is no longer relevant, update to "dismissed". Create new findings for any new issues.
Each finding should have a clear, actionable description.
## LIVE PROGRESS (display-only)
Log short notes with flow_meta (action "add", key "progress") so the user's UI shows you working: one note when you start ("Reviewing diff…"), one per finding you create or update ("Finding <short summary>"), and one when you finish ("Review complete: N findings").
Keep each note to a single short line. The "progress" key is display-only: it never affects workflow transitions and does not need cleanup.
Do NOT edit source files. You may run read-only commands (git diff, tests, lints).
**Never leave the review half-finished.** If you must stop (for example context pressure), record in the report file which findings were created/updated and which checks remain — the parent may resume you to finish.
When done, write a short report (findings created/updated, overall assessment) to the report file named in your task, and stop.`
export const FLOW_AGENTS = [
  {
    name: 'adx-verifier',
    description:
      'Independent acceptance-criteria verifier (adx-workflow). Checks criteria against the code, sets passed/failed via flow_meta.',
    tools: ['read', 'bash', 'flow_meta'],
    systemPrompt: VERIFIER_PROMPT,
  },
  {
    name: 'adx-code-reviewer',
    description:
      'Code reviewer (adx-workflow). Reviews the git diff for UX + code-quality issues, manages review_findings via flow_meta.',
    tools: ['read', 'bash', 'flow_meta'],
    systemPrompt: REVIEWER_PROMPT,
  },
] as const
export type FlowAgentName = (typeof FLOW_AGENTS)[number]['name']

// ============================================================================
// Result / options types
// ============================================================================
export interface SpawnResult {
  ok: boolean
  /** Session id of the child run — usable with resumeFlowAgent (never-stop). */
  runId?: string
  error?: string
  /** Tail of the child's final output (informational; the real contract is
   * the flow_meta updates + the report file). */
  output?: string
}
export interface SpawnOptions {
  /** Project directory — the child runs here and writes .pi/adx-flow there. */
  cwd: string
  /** Default 15 min. On timeout the process group is killed; runId is kept so
   * the parent can resume the (persisted) child session. */
  timeoutMs?: number
  /** Resume an existing child session (never-stop). */
  resume?: { sessionId: string; message: string }
  /** Parent's adx state file — the child's flow_meta updates must land in the
   * PARENT's per-session state, so it is passed through ADX_FLOW_STATE. */
  statePath?: string
  /** Per-step model override (provider/model, e.g. a faster/cheaper model for
   * verify/review). Takes precedence over the ADX_FLOW_MODEL env var. */
  model?: string
}

// ============================================================================
// Resolution helpers
// ============================================================================
/** The `pi` CLI: ADX_PI_BIN → managed install (~/.pi/agent/bin/pi) → PATH. */
function resolvePiBin(): string | undefined {
  if (process.env.ADX_PI_BIN && existsSync(process.env.ADX_PI_BIN)) {
    return process.env.ADX_PI_BIN
  }
  const managed = join(homedir(), '.pi', 'agent', 'bin', 'pi')
  if (existsSync(managed)) return managed
  return 'pi'
}
/** Our extension entry (the child loads it with -e to get flow_meta). */
export function resolveExtensionPath(): string | undefined {
  if (process.env.ADX_EXTENSION_PATH) return process.env.ADX_EXTENSION_PATH
  // Own entry: works for dev symlinks, git/npm package installs, and local paths.
  const self = join(dirname(fileURLToPath(import.meta.url)), 'index.ts')
  if (existsSync(self)) return self
  // Legacy dev symlink
  const legacy = join(homedir(), '.pi', 'agent', 'extensions', 'adx-workflow', 'src', 'index.ts')
  return existsSync(legacy) ? legacy : undefined
}

// ============================================================================
// Spawn / resume
// ============================================================================
/**
 * Spawn (or resume) a flow sub-agent as an isolated `pi -p` child process.
 * Async-only. Resolves with a SpawnResult; never throws.
 */
export function spawnFlowAgent(
  agent: FlowAgentName | string,
  task: string,
  opts: SpawnOptions,
): Promise<SpawnResult> {
  const def = FLOW_AGENTS.find((a) => a.name === agent)
  const piBin = resolvePiBin()
  const extPath = resolveExtensionPath()
  const runId = opts.resume?.sessionId ?? randomUUID()
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000
  const prompt = opts.resume ? opts.resume.message : task

  if (!extPath) {
    return Promise.resolve({
      ok: false,
      runId,
      error: `adx extension entry not found (looked for ADX_EXTENSION_PATH, the extension's own entry, or ${join(
        homedir(),
        '.pi/agent/extensions/adx-workflow/src/index.ts',
      )})`,
    })
  }

  const sessionDir = join(opts.cwd, '.pi', 'adx-flow', 'sessions')
  mkdirSync(sessionDir, { recursive: true })

  const args = [
    '-p',
    '--mode',
    'json',
    '--extension',
    extPath,
    '--no-extensions',
    '--no-mcp',
    '--no-skills',
    '--tools',
    (def?.tools ?? ['read', 'bash', 'flow_meta']).join(','),
    '--session-dir',
    sessionDir,
    '--name',
    `adx-${agent}-${runId.slice(0, 8)}`,
  ]
  if (opts.resume) args.push('--session', opts.resume.sessionId)
  else args.push('--session-id', runId)
  if (def?.systemPrompt) args.push('--append-system-prompt', def.systemPrompt)
  // Model: per-step override (SubAgentStep.model) > ADX_FLOW_MODEL env > the
  // user's default model (same as the parent session).
  const model = opts.model ?? process.env.ADX_FLOW_MODEL
  if (model) args.push('--model', model)
  args.push(prompt)

  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(piBin ?? 'pi', args, {
        cwd: opts.cwd,
        env: {
          ...process.env,
          ADX_CHILD: '1',
          ...(opts.statePath ? { ADX_FLOW_STATE: opts.statePath } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        // detached → child is a process-group leader; the timeout kills the
        // whole group (pi -p may spawn its own helpers).
        detached: true,
      })
    } catch (e) {
      resolve({ ok: false, runId, error: `subagent "${agent}" spawn failed: ${(e as Error).message}` })
      return
    }

    let out = ''
    child.stdout?.on('data', (d) => {
      out += d
    })
    let settled = false
    const finish = (r: SpawnResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Best-effort group kill (no-op if the child already exited).
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        /* already gone */
      }
      resolve(r)
    }
    const timer = setTimeout(() => {
      finish({
        ok: false,
        runId,
        error: `subagent "${agent}" did not finish within ${Math.round(timeoutMs / 1000)}s`,
      })
    }, timeoutMs)

    child.on('error', (e) => {
      finish({ ok: false, runId, error: `subagent "${agent}" failed to start: ${e.message}` })
    })
    child.on('close', (code) => {
      // --mode json emits a JSONL stream. Success = exit 0 AND the final
      // turn_end has no provider error (pi -p exits 0 even on model 400s).
      const lines = out.split('\n').filter(Boolean)
      let lastTurn: Record<string, unknown> | undefined
      for (const l of lines) {
        try {
          const j = JSON.parse(l) as Record<string, unknown>
          if (j['type'] === 'turn_end') lastTurn = j
        } catch {
          /* not JSONL — ignore */
        }
      }
      const providerError =
        lastTurn && lastTurn['message']
          ? ((lastTurn['message'] as Record<string, unknown>)['stopReason'] as string) === 'error'
          : false
      const errorMessage = lastTurn
        ? ((lastTurn['message'] as Record<string, unknown>)['errorMessage'] as string | undefined) ?? ''
        : ''
      if (code === 0 && !providerError) {
        let output = ''
        if (lastTurn) {
          const msg = lastTurn['message'] as Record<string, unknown>
          const content = msg['content']
          if (Array.isArray(content)) {
            output = content
              .map((c) => (c && typeof c === 'object' && typeof c['text'] === 'string' ? c['text'] : ''))
              .join('\n')
          }
        }
        finish({ ok: true, runId, output: (output || out).slice(-4000) })
      } else {
        finish({
          ok: false,
          runId,
          error: providerError
            ? `subagent "${agent}" provider error: ${errorMessage.slice(0, 300)}`
            : `subagent "${agent}" exited with code ${code}: ${out.slice(-500)}`,
        })
      }
    })
  })
}

/**
 * Revive a stopped sub-agent run (never-stop): re-spawn with
 * `--session <runId>` so the child continues from its persisted session.
 */
export function resumeFlowAgent(
  agent: FlowAgentName | string,
  runId: string,
  message: string,
  opts: Omit<SpawnOptions, 'resume'>,
): Promise<SpawnResult> {
  return spawnFlowAgent(agent, '', { ...opts, resume: { sessionId: runId, message } })
}
