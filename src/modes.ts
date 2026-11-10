/**
 * adx-workflow: plan ↔ build modes.
 *
 * Mode model (mode = agent definition: system prompt + tool
 * allowlist) onto pi primitives:
 * - plan mode  = read-only tool set + bash allowlist + planner prompt section
 * - build mode = full tool set + builder prompt section
 *
 * Mode switches are EXTERNAL (commands / shortcut) — the planner never asks
 * "may I switch?"; only the user (or a workflow) does.
 */
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

// ============================================================================
// Tool gating (port of examples/extensions/plan-mode)
// ============================================================================

export const PLAN_MODE_DISABLED_TOOLS = new Set<string>(['edit', 'write'])
/** Tools that stay available (or come back) in plan mode */
export const PLAN_MODE_TOOLS = ['read', 'bash', 'grep', 'find', 'ls']

export function getPlanModeTools(activeToolNames: string[]): string[] {
  return [
    ...new Set(
      [
        ...activeToolNames.filter((n) => !PLAN_MODE_DISABLED_TOOLS.has(n)),
        ...PLAN_MODE_TOOLS,
      ],
    ),
  ]
}

export function getBuildModeTools(restoredTools: string[]): string[] {
  return [...new Set(restoredTools)]
}

// ============================================================================
// Read-only bash allowlist (port of plan-mode/utils.ts isSafeCommand)
// ============================================================================

const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  // Output redirects — but `2>&1` (stderr to stdout) is not destructive:
  // a `>` followed by `&` is allowed, real file redirects ("> file", "2> /dev/null") are not.
  /(^|[^<])>(?!&)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash\s+(push|pop|drop|apply|clear)|cherry-pick|revert|tag\s+\S+|init|clone)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  // kill/pkill are destructive except the exact diagnostic forms allowed by
  // SAFE_PATTERNS (`kill <pid>`, `pkill -f <pattern>`) — used to stop a
  // dev server the planner started for a screenshot.
  /^\s*kill\s+(?!\d)/,
  /^\s*pkill\s+(?!-f\s+(".*"|\S+)\s*$)/,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
]

const SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  // Tooling version probes
  /^\s*npm\s+--version/i,
  /^\s*npm\s+config\s+(list|get)\b/i,
  /^\s*pnpm\s+--version/i,
  /^\s*pip3?\s+(list|show|config)\b/i,
  /^\s*yarn\s+--version/i,
  /^\s*go\s+version/i,
  /^\s*java\s+-version/i,
  /^\s*rustc\s+--version/i,
  /^\s*cargo\s+--version/i,
  /^\s*docker\s+--version/i,
  /^\s*make\s+--version/i,
  // Quick interpreter probes (arbitrary -c/-e code is a known hole, accepted
  // for read-only environment checks like `python3 -c "import PIL; ..."`)
  /^\s*python3?\s+-c\s+/i,
  /^\s*python3?\s+-(\s|$)/, // stdin script: python3 - <<'EOF' ... EOF
  /^\s*node\s+-e\s+/i,
  // Process / port / container diagnostics
  /^\s*lsof\s+/i,
  /^\s*netstat\s+/i,
  /^\s*ss\s+/i,
  /^\s*pgrep\s+/i,
  /^\s*docker\s+(ps|images|inspect|logs)\b/i,
  // git read-only extras
  /^\s*git\s+(stash\s+list|tag|blame|reflog|shortlog|ls-files|worktree\s+list|describe)\b/i,
  // Project & web diagnostics
  /^\s*npx\s+tsc\s+--noEmit\b/i,
  /^\s*npx\s+playwright\s+(screenshot|open|show-trace)\b/i,
  /^\s*npm\s+run\s+(dev|start|preview)\b/i,
  // Stopping a diagnostic server started above (exact forms only)
  /^\s*kill\s+-?\d+\s*$/,
  /^\s*pkill\s+-f\s+(".*"|\S+)/,
  /^\s*node\s+--version/i,
  /^\s*python3?\s+--version/i,
  /^\s*curl\s/i,
  /^\s*wget\s+-O\s*-/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
]

export function isSafeCommand(command: string): boolean {
  const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command))
  const isSafe = SAFE_PATTERNS.some((p) => p.test(command))
  return !isDestructive && isSafe
}

/**
 * Extract the bash command from a bash tool call's args (pi's bash tool takes
 * a `command` string).
 */
export function bashCommandFromArgs(args: Record<string, unknown>): string {
  return typeof args?.command === 'string' ? args.command : ''
}

// ============================================================================
// Prompt sections (planner/builder agent definitions)
// ============================================================================

export const PLANNER_PROMPT_SECTION = `
# Plan Mode (adx-workflow)

CRITICAL: Plan mode ACTIVE - you are in a read-only phase.

You may only inspect, analyze, ask clarifying questions, and propose, refine and/or add acceptance criteria via the flow_meta tool (key "criteria").
You MUST NOT make any edits, implementations, commits, config changes, or other system modifications.

## Responsibility

- Understand the user's goal before locking in details.
- Explore the codebase with read-only actions when needed.
- Web & system diagnostics: you may start a dev server (npm run dev in the background), take a headless screenshot (npx playwright screenshot <url> /tmp/shot.png), probe ports (lsof -i :PORT), then stop only the processes you started (kill <pid> / pkill -f <pattern>). Keep all artifacts in /tmp — plan mode must not modify the project.
- If a bash command is rejected by the plan-mode allowlist, it is NOT fatal: retry with a simpler read-only variant (plain ls without flags, no && chains, pipes, or file redirects) or proceed with what you already know. Never stop your turn because of a blocked command.
- Add each acceptance criterion with flow_meta (action "add", key "criteria"): a self-contained, verifiable description of what needs to be done AND how to verify it.
- Present the criteria plainly and stop there.
- Never ask "Do you approve these criteria and shall I switch to build?" — mode changes are driven externally by the user (/adx-build), not by your question.
- Do not call flow_step_done in plan mode; it is only used inside a running workflow step.
- If you must stop mid-step (for example context pressure), first record where you stopped and the exact next action with flow_meta (action "add", key "resume", description "..."), then stop. You will be auto-continued with that note.
`

export const BUILDER_PROMPT_SECTION = `
# Build Mode (adx-workflow)

CRITICAL: Build mode ACTIVE - implementation is now allowed.

You are no longer in read-only mode.
You may read files, edit files, run commands, and use tools as needed to satisfy the approved criteria.

## Responsibility

- Execute the approved work with focused changes.
- Follow TDD when fixing or refactoring: write or update the failing test first, then make it pass.
- Verify changes as you go.
- Finish criteria systematically instead of replanning from scratch.
- Mark each criterion as complete with flow_meta (key "criteria", action "update", status "completed"). Do NOT set status "passed" — that status is set by the verifier, not by you.
- When the current workflow step prompt is fully satisfied, call flow_step_done.
- **Never leave a step half-finished.** If you must stop mid-step (for example context pressure), first record where you stopped and the exact next action with flow_meta (action "add", key "resume", description "..."), then stop. The workflow auto-continues you with that note — do not ask the user to press continue.
`

/**
 * Guard bash tool calls while in plan mode: block non-read-only commands.
 * Returns an error message to inject, or undefined when allowed.
 */
export function planModeBashGuard(
  args: Record<string, unknown>,
  notify: (msg: string) => void,
): string | undefined {
  const command = bashCommandFromArgs(args)
  if (!command) return undefined
  if (!isSafeCommand(command)) {
    const msg = `Plan mode is read-only: bash command not on the read-only allowlist: ${command.slice(0, 120)}`
    notify(msg)
    return msg
  }
  return undefined
}

/** Convenience: apply the plan-mode tool set from an ExtensionContext's active tools. */
export function activatePlanModeTools(activeTools: string[]): string[] {
  return getPlanModeTools(activeTools)
}

export type { ExtensionContext }
