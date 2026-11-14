/**
 * E2E smoke test: drive the full build-verify pipeline through AdxExecutor
 * with a fake pi (simulated LLM tool calls + simulated sub-agent children).
 *
 * Verifies: user-step choice → build agent step → nudge loop → verifier
 * sub-agent (failed → passed) → code reviewer sub-agent → finalize loop →
 * summarize → $done, with persistence and widget refreshes.
 */
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJitiFromPi } from './find-jiti.mjs'

// Hermetic: never inherit the flow-child env. ADX_CHILD=1 + ADX_FLOW_STATE would
// redirect the store's state-file resolution away from the scratch repo (and leak
// the test criteria into the parent session's store), breaking the scratch
// assertions. Strip both so the suite always resolves its own scratch state file.
delete process.env.ADX_CHILD
delete process.env.ADX_FLOW_STATE

const createJiti = createJitiFromPi()
const jiti = createJiti(import.meta.url, { cache: false, interopDefault: true })

const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
const { AdxExecutor } = await jiti.import(join(srcDir, 'executor.ts'))
const { createFlowMetaTool } = await jiti.import(join(srcDir, 'tools.ts'))

// ------------------------------------------------------------------ scratch project
const scratch = mkdtempSync(join(tmpdir(), 'adx-e2e-'))
const scratchRepo = join(scratch, 'repo')
mkdirSync(scratchRepo, { recursive: true })
writeFileSync(join(scratchRepo, 'index.js'), 'export const x = 1\n')

const statePath = join(scratchRepo, '.pi', 'adx-flow', 'state', 'e2e-session.json')
const readState = () => JSON.parse(readFileSync(statePath, 'utf8'))
const stateDir = join(scratchRepo, '.pi', 'adx-flow')

// ------------------------------------------------------------------ fake pi
const userMessages = []
const userMessageOpts = [] // parallel to userMessages: the deliverAs options passed
const notifications = []
const selects = [] // every ui.select call: { title, options }
let widgetRefreshes = 0

function fakeCtx() {
  return {
    cwd: scratchRepo,
    // Per-session state: the executor keys the state file by this session id.
    sessionManager: { getSessionId: () => 'e2e-session' },
    // Real ExtensionContext always exposes hasUI (true in TUI/RPC modes).
    hasUI: true,
    ui: {
      notify: (msg, level) => notifications.push(`${level ?? 'info'}: ${msg}`),
      select: async (title, options) => {
        // Simulate user choices:
        // - "Where to work" → work in current workspace
        // - "Commit changes?" → Commit & push (first option)
        // - "Approve Fix Plan" → apply
        selects.push({ title, options })
        if (title.includes('Where to work')) return 'Work in current workspace'
        return options[0]
      },
      setWidget: () => {},
      setStatus: () => {},
      // Identity theme (real interactive contexts always provide one).
      theme: {
        fg: (_color, text) => text,
        bold: (text) => text,
        strikethrough: (text) => text,
      },
    },
  }
}

// Sub-agent simulation: children update the store + write a report, then reply.
// The FIRST verify spawn fails (child "stopped") → the executor must resume it.
let verifyCount = 0
let firstVerifyFailed = false
let skipTestMode = false
let skipProbePass = 0

function applyVerifierEffect() {
  verifyCount += 1
  const state = readState()
  for (const c of state.metadata['criteria'] ?? []) {
    if (c.status === 'completed') {
      // "Unsat" always fails (drives the maxIterations block proof),
      // criterion 2 fails on the first pass only (nudge-loop proof),
      // everything else passes.
      if (c.description === 'Unsat') c.status = 'failed'
      else if (verifyCount === 1 && c.id === '2') c.status = 'failed'
      else c.status = 'passed'
      if (c.status === 'failed' && c.description !== 'Unsat') c.description += ' (missing edge case X)'
    }
  }
  // The real verifier logs display-only progress notes as it works.
  verifierWroteProgress = true
  state.metadata['progress'] = [
    { id: '1', description: `Verifying 1: … (pass ${verifyCount})`, status: 'pending' },
    { id: '2', description: '1 passed: ok', status: 'pending' },
  ]
  writeFileSync(statePath, JSON.stringify(state, null, 2))
  mkdirSync(join(stateDir, 'reports'), { recursive: true })
  writeFileSync(
    join(stateDir, 'reports', 'adx-verifier.md'),
    `Verification pass ${verifyCount}: criteria ${
      verifyCount === 1 ? '1 passed, 2 FAILED (missing edge case X)' : 'all passed'
    }`,
  )
}

// Fake spawner (in-house `pi -p` child-process propagation): the FIRST
// verify spawn fails ("child stopped") so the executor's never-stop resume
// path is exercised; everything else succeeds and applies its store effects.
const spawnCalls = []
const spawnOpts = []
let progressResetBeforeReview = false
let verifierWroteProgress = false

function applyReviewerEffect() {
  const state = readState()
  // The executor must have reset the progress feed for the fresh run, so no
  // stale verifier notes leak into the code_review activity widget.
  progressResetBeforeReview = state.metadata['progress'] === undefined
  state.metadata['review_findings'] = [
    {
      id: '1',
      description: 'Builder left a console.log in index.js',
      status: 'open',
      severity: 'minor',
    },
  ]
  writeFileSync(statePath, JSON.stringify(state, null, 2))
  mkdirSync(join(stateDir, 'reports'), { recursive: true })
  writeFileSync(
    join(stateDir, 'reports', 'adx-code-reviewer.md'),
    'Review: 1 finding (console.log in index.js)',
  )
}

const fakeSpawn = async (agent, task, opts) => {
  spawnCalls.push(agent)
  spawnOpts.push(opts)
  if (agent === 'adx-verifier' && skipTestMode) {
    // Re-verification short-circuit scenario: the first pass fails the probe
    // criterion; the (simulated) builder then fixes the store by hand, so a
    // full re-spawn must NOT happen.
    skipProbePass += 1
    const st = readState()
    const probe = (st.metadata['criteria'] ?? []).find((c) => c.description === 'SkipProbe')
    if (probe) probe.status = skipProbePass === 1 ? 'failed' : 'passed'
    writeFileSync(statePath, JSON.stringify(st, null, 2))
    return { ok: true, runId: 'skip-run' }
  }
  if (agent === 'adx-verifier' && !firstVerifyFailed) {
    // Child "stopped" before finishing (e.g. context pressure):
    // failure with a run id so the executor can resume it.
    firstVerifyFailed = true
    return { ok: false, runId: 'run-1', error: 'child stopped (context pressure)' }
  }
  if (agent === 'adx-verifier') applyVerifierEffect()
  if (agent === 'adx-code-reviewer') applyReviewerEffect()
  return { ok: true, runId: 'run-1' }
}
const fakeResume = async (agent, runId, message, opts) => {
  spawnCalls.push(`${agent}:resume`)
  spawnOpts.push(opts)
  // The revived child finishes the job: apply the verifier effect, success.
  if (agent === 'adx-verifier') applyVerifierEffect()
  return { ok: true, runId }
}

const fakePi = {
  sendUserMessage: (msg, opts) => {
    userMessages.push(msg)
    userMessageOpts.push(opts)
  },
}

// ------------------------------------------------------------------ executor
const executor = new AdxExecutor({
  pi: fakePi,
  notify: (msg, level) => notifications.push(`${level ?? 'info'}: ${msg}`),
  updateWidget: () => {
    widgetRefreshes++
  },
  spawn: fakeSpawn,
  resume: fakeResume,
})

// flow_meta tool bound to the scratch repo (simulates the LLM calling it)
const flowMeta = createFlowMetaTool()
const fm = async (args) => {
  const res = await flowMeta.execute('t', args, undefined, undefined, {
    cwd: scratchRepo,
    sessionManager: { getSessionId: () => 'e2e-session' },
  })
  return res.content.map((c) => c.text).join('\n')
}

const ctx = fakeCtx()
let failures = 0
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`)
  if (!cond) failures++
}

// ------------------------------------------------------------------ run the pipeline
await executor.launch('build-verify', ctx)

// --- user step "work_location" resolved → agent step "build" prompt injected
check('user step skipped to build (no new workspace)', userMessages.length === 1)
check('build prompt mentions criteria', userMessages[0]?.includes('criteria'))
check(
  'step prompt sent with deliverAs: followUp (busy-safe)',
  userMessageOpts[0]?.deliverAs === 'followUp',
)

// LLM (builder): add 2 criteria and mark them completed
await fm({ action: 'add', key: 'criteria', description: 'Implement feature X' })
await fm({ action: 'add', key: 'criteria', description: 'Handle edge case X' })
await fm({ action: 'update', key: 'criteria', id: '1', status: 'completed' })
await fm({ action: 'update', key: 'criteria', id: '2', status: 'completed' })

// LLM calls flow_step_done → verify sub-agent runs (1st pass: criterion 2 fails)
await executor.onStepDone({})
check(
  'verifier failed a criterion → nudged back to build',
  userMessages.some((m) => m.includes('1 criteria not yet passed') && m.includes('Verification pass 1')),
)
check(
  'stopped sub-agent was resumed (never-stop)',
  notifications.some((n) => n.includes('adx-verifier') && n.includes('resuming')),
)
check(
  'resume re-spawns the persisted child session (runId carried over)',
  spawnCalls.includes('adx-verifier:resume'),
)
check(
  'sub-agent children get the parent per-session state file (ADX_FLOW_STATE)',
  spawnOpts.length > 0 && spawnOpts.every((o) => o?.statePath === statePath),
)
check(
  'verify→build re-entry (nudgePrompt) sent with deliverAs: followUp (busy-safe)',
  userMessageOpts[userMessages.findIndex((m) => m.includes('1 criteria not yet passed'))]?.deliverAs === 'followUp',
)

// LLM fixes, marks completed again
const s1 = readState()
for (const c of s1.metadata['criteria']) {
  if (c.status === 'failed') c.status = 'completed'
}
writeFileSync(statePath, JSON.stringify(s1, null, 2))
await executor.onStepDone({})

// 2nd verify pass: all passed → code_review sub-agent → finalize agent step
check(
  'after 2nd verify + review, finalize prompt injected with findings',
  userMessages.some((m) => m.includes('Code Review Findings') && m.includes('console.log')),
)

// LLM resolves the finding
const s2 = readState()
for (const f of s2.metadata['review_findings']) f.status = 'resolved'
writeFileSync(statePath, JSON.stringify(s2, null, 2))
await executor.onStepDone({})

// commit_changes user step: no commit param in this run → the picker is
// offered; the simulated user picks "Commit & push" (options[0]).
const commitPicker = selects.find((s) => s.title.includes('Commit changes?'))
check(
  'commit picker offered "Commit & push" / "Leave uncommitted"',
  commitPicker?.options?.[0] === 'Commit & push' && commitPicker?.options?.[1] === 'Leave uncommitted',
)
check(
  'commit_push prompt injected (worktree: push adx/<slug> only, merge stays manual)',
  userMessages.some(
    (m) =>
      m.includes('git push -u origin adx/') &&
        m.includes('Do NOT merge the branch into the base branch'),
  ),
)

// LLM finishes the commit step (result "pushed" satisfies the step_result gate)
await executor.onStepDone({ result: 'pushed' })

// Summarize agent step injected
check('summarize prompt injected', userMessages.some((m) => m.includes('What to test')))
check(
  'summarize prompt carries the commit-state section',
  userMessages.some((m) => m.includes('Commit state')),
)
// Live progress feed: the verifier logged notes, and the executor reset the
// feed before the code_review sub-agent step (no stale notes in the widget).
check('verifier wrote display-only progress notes', verifierWroteProgress)
check('progress feed reset before code_review step', progressResetBeforeReview)
// Cap: the display-only progress feed prunes oldest entries beyond 20.
{
  for (let i = 0; i < 25; i++) await fm({ action: 'add', key: 'progress', description: `cap-test ${i}` })
  const prog = readState().metadata['progress'] ?? []
  check(
    'progress feed capped at 20 (oldest pruned)',
    prog.length === 20 && prog[0].description === 'cap-test 5',
  )
}

// LLM finishes the summary
await executor.onStepDone({})
const final = readState()
check('execution finished ($done)', final.execution?.status === 'done')

// Nudge-loop guard: re-run with an unsatisfiable criterion; nudges keep the
// run on the build step
await executor.launch('build-verify', ctx)
// user step auto-resolves to build again
await fm({ action: 'add', key: 'criteria', description: 'Unsat' })
let nudges = 0
const origSend = fakePi.sendUserMessage
fakePi.sendUserMessage = (m, o) => {
  userMessages.push(m)
  userMessageOpts.push(o)
  if (m.includes('criteria remaining')) nudges++
}
for (let i = 0; i < 3; i++) await executor.onStepDone({})
check('nudge re-entry stays on build step', readState().execution?.currentStep === 'build')
fakePi.sendUserMessage = origSend

// Auto-continue (never-stop): the agent stopped mid-step without
// flow_step_done → the executor produces a continuation message that carries
// the resume note + criteria status; with continue:true (agent_before_settle)
// pi runs the next provider request automatically.
await fm({ action: 'add', key: 'resume', description: 'Stopped after editing index.js; next: add the edge-case test' })
const cont = await executor.autoContinue()
check('auto-continue returns a continuation message', cont?.message?.includes('Continue the current adx workflow step'))
check('auto-continue includes the resume note', cont?.message?.includes('Stopped after editing index.js'))
check('auto-continue includes criteria status', cont?.message?.includes('[NOT COMPLETED]'))

// Cap: after 8 consecutive auto-continues the run blocks (safety)
for (let i = 0; i < 8; i++) await executor.autoContinue()
check('auto-continue cap blocks the run', readState().execution?.status === 'blocked')

// /adx-resume: back to running at the build step
await executor.resume(ctx)
check(
  'resume after cap re-enters the build step',
  readState().execution?.status === 'running' && readState().execution?.currentStep === 'build',
)

// Blocked path: the unsatisfiable criterion keeps verify failing → the
// build↔verify loop burns maxIterations (50) → $blocked
for (let i = 0; i < 30 && readState().execution?.status === 'running'; i++) {
  const st = readState()
  for (const c of st.metadata['criteria']) {
    if (c.description === 'Unsat') c.status = 'completed'
  }
  writeFileSync(statePath, JSON.stringify(st, null, 2))
  await executor.onStepDone({})
}
check('maxIterations cap blocks the run', readState().execution?.status === 'blocked')

// /adx-resume after a maxIterations block: a resume gets a fresh iteration
// budget, so the block is not permanent.
await executor.resume(ctx)
check(
  'resume after maxIterations block re-enters running (fresh budget)',
  readState().execution?.status === 'running' &&
    readState().execution?.currentStep === 'build' &&
    (readState().execution?.iteration ?? 0) <= 1,
)
check(
  'resume injects a neutral prompt (no failure-flavored nudge)',
  userMessages.at(-1)?.includes('was resumed at step') &&
    !userMessages.at(-1)?.includes('transition condition not met'),
)

// Nudge re-entry path: a step whose transitions are ALL unmet stays on the
// step and injects a steered nudge (delivered mid-run, before next LLM call).
// The build-verify workflow never reaches this path (every step has an
// "always" fallback goto), so exercise it with a dedicated mini workflow.
mkdirSync(join(scratchRepo, '.pi', 'adx-workflows'), { recursive: true })
writeFileSync(
  join(scratchRepo, '.pi', 'adx-workflows', 'nudge-test.workflow.json'),
  JSON.stringify(
    {
      metadata: { id: 'nudge-test', name: 'Nudge Test' },
      entryStep: 'work',
      steps: [
        {
          id: 'work',
          type: 'agent',
          prompt: 'Do the thing.',
          nudgePrompt: 'Still not done: {{reason}}. Keep going.',
          transitions: [
            {
              when: { type: 'metadata_all_in', key: 'criteria', field: 'status', values: ['passed'] },
              goto: '$done',
            },
          ],
        },
      ],
      startCondition: { type: 'always' },
    },
    null,
    2,
  ),
)
await executor.launch('nudge-test', ctx)
check(
  'nudge-test step prompt injected with deliverAs: followUp',
  userMessages.at(-1)?.includes('Do the thing.') &&
    userMessageOpts.at(-1)?.deliverAs === 'followUp',
)
await executor.onStepDone({}) // criteria not all "passed" → no transition matches
check(
  'unmet transition nudges in place with deliverAs: steer',
  userMessages.at(-1)?.includes('Still not done') &&
    userMessageOpts.at(-1)?.deliverAs === 'steer',
)
check(
  'steered nudge keeps the run on the same step',
  readState().execution?.currentStep === 'work' && readState().execution?.status === 'running',
)

// ------------------------------------------------------------------ flow_meta atomicity (kanban regression)
// Parallel single-item adds must not lose writes (the kanban session lost 10
// of 11 planning adds to a last-write-wins race), and update_batch must
// apply a whole multi-item update in one atomic write.
{
  const parallelAdds = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      flowMeta.execute(
        `par-${i}`,
        { action: 'add', key: 'todos', description: `parallel item ${i}` },
        undefined,
        undefined,
        { cwd: scratchRepo, sessionManager: { getSessionId: () => 'e2e-session' } },
      ),
    ),
  )
  check(
    'parallel flow_meta adds keep every item (no lost updates)',
    parallelAdds.every((r) => !r.isError) &&
      (readState().metadata['todos'] ?? []).length === 12,
  )
  const batchRes = await fm({
    action: 'update_batch',
    key: 'todos',
    items: [
      { id: '1', status: 'completed' },
      { id: '6', status: 'in_progress' },
      { id: '12', status: 'completed' },
    ],
  })
  const todos = readState().metadata['todos'] ?? []
  check(
    'update_batch updates all items in one atomic call',
    batchRes.includes('3 items') &&
      todos[0].status === 'completed' &&
      todos[5].status === 'in_progress' &&
      todos[11].status === 'completed',
  )
  const addBatchRes = await fm({
    action: 'add_batch',
    key: 'todos',
    descriptions: ['batch one', 'batch two'],
  })
  check(
    'add_batch adds all items in one atomic call',
    addBatchRes.includes('2 items') &&
      (readState().metadata['todos'] ?? []).length === 14,
  )
}

// ------------------------------------------------------------------ verifier re-run short-circuit (kanban regression)
// Unchanged code + gate now met ⇒ the expensive verifier pass is skipped
// instead of re-running (kanban paid 4 full verifier passes for one small file).
{
  const verifSpawnsBefore = spawnCalls.filter((c) => c.startsWith('adx-verifier')).length
  writeFileSync(
    join(scratchRepo, '.pi', 'adx-workflows', 'skip-test.workflow.json'),
    JSON.stringify(
      {
        metadata: { id: 'skip-test', name: 'Skip Test' },
        entryStep: 'b',
        steps: [
          {
            id: 'b',
            name: 'Build',
            type: 'agent',
            prompt: 'Build it.',
            nudgePrompt: 'Nudge: {{reason}}. Keep going.',
            transitions: [{ when: { type: 'always' }, goto: 'v' }],
          },
          {
            id: 'v',
            name: 'Verify',
            type: 'sub_agent',
            subAgentType: 'adx-verifier',
            prompt: 'Verify it.',
            transitions: [
              {
                when: { type: 'metadata_all_match', key: 'criteria', field: 'status', value: 'passed' },
                goto: '$done',
              },
              { when: { type: 'always' }, goto: 'b' },
            ],
          },
        ],
        startCondition: { type: 'always' },
      },
      null,
      2,
    ),
  )
  // Fresh criteria: one probe, completed (needs verification).
  const stSkip = readState()
  stSkip.metadata['criteria'] = [{ id: '1', description: 'SkipProbe', status: 'completed' }]
  writeFileSync(statePath, JSON.stringify(stSkip, null, 2))
  skipTestMode = true
  await executor.launch('skip-test', ctx)
  // Build done → first verify pass runs (probe fails → gate unmet → nudge back to build).
  await executor.onStepDone({})
  check(
    'skip-test: first verify pass ran and fell through to build',
    readState().execution?.currentStep === 'b' &&
      (readState().metadata['criteria'] ?? [])[0]?.status === 'failed',
  )
  check(
    'skip-test: nudge carries the actionable gate reason',
    userMessages.at(-1)?.includes('1 criteria not yet passed'),
  )
  // Simulated builder "fixes" the store by hand (the kanban case: the store
  // caught up after a lost write) — no project files changed.
  const stFix = readState()
  stFix.metadata['criteria'][0].status = 'passed'
  writeFileSync(statePath, JSON.stringify(stFix, null, 2))
  await executor.onStepDone({})
  check(
    'skip-test: verifier re-run skipped (code unchanged + gate met) → $done',
    readState().execution?.status === 'done',
  )
  check(
    'skip-test: exactly ONE verifier spawn for the whole scenario',
    spawnCalls.filter((c) => c.startsWith('adx-verifier')).length === verifSpawnsBefore + 1,
  )
  check(
    'skip-test: skip notification emitted',
    notifications.some((n) => n.includes('verifier re-run skipped')),
  )
  skipTestMode = false
}

// ------------------------------------------------------------------ worktree collision (setup_workspace pre-check)
// A colliding folder AND branch are pre-created; launching with
// worklocation=new must route to setup_workspace, and the (simulated) agent
// must pick the next free numeric suffix per the updated step prompt — no
// overwrites, no git errors.
{
  const { execSync } = await import('node:child_process')
  const scratch2 = mkdtempSync(join(tmpdir(), 'adx-e2e-collision-'))
  const repo2 = join(scratch2, 'repo')
  mkdirSync(repo2, { recursive: true })
  writeFileSync(join(repo2, 'index.js'), 'export const x = 1\n')
  let gitFailures = 0
  const git = (args) => {
    try {
      return execSync(`git ${args}`, {
        cwd: repo2,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'e2e',
          GIT_AUTHOR_EMAIL: 'e2e@e2e.test',
          GIT_COMMITTER_NAME: 'e2e',
          GIT_COMMITTER_EMAIL: 'e2e@e2e.test',
        },
      }).trim()
    } catch {
      gitFailures++
      return ''
    }
  }
  git('init -q')
  git('add index.js')
  git('commit -qm init')

  // Collision targets: the folder and the branch are both already taken.
  const wtDir = join(scratch2, '.adx-worktrees')
  mkdirSync(join(wtDir, 'dark-theme'), { recursive: true })
  writeFileSync(join(wtDir, 'dark-theme', 'marker.txt'), 'do not touch\n')
  git('branch adx/dark-theme')

  // Isolated harness: fresh scratch repo + session so the main scenario's
  // state does not leak into this one.
  const userMessages2 = []
  const fakePi2 = { sendUserMessage: (m) => userMessages2.push(m) }
  const ctx2 = {
    cwd: repo2,
    sessionManager: { getSessionId: () => 'e2e-collision' },
    hasUI: true,
    ui: {
      notify: () => {},
      select: async () => undefined,
      setWidget: () => {},
      setStatus: () => {},
      theme: { fg: (_c, t) => t, bold: (t) => t, strikethrough: (t) => t },
    },
  }
  const executor2 = new AdxExecutor({
    pi: fakePi2,
    notify: () => {},
    updateWidget: () => {},
    spawn: async () => {
      throw new Error('no sub-agent steps in collision scenario')
    },
    resume: async () => {
      throw new Error('no sub-agent steps in collision scenario')
    },
  })
  const readState2 = () =>
    JSON.parse(readFileSync(join(repo2, '.pi', 'adx-flow', 'state', 'e2e-collision.json'), 'utf8'))

  await executor2.launch('build-verify', ctx2, 'worklocation=new')
  check(
    'worklocation=new routes to setup_workspace (collision pre-check prompt injected)',
    userMessages2.at(-1)?.includes('Check for name collisions BEFORE creating') &&
      userMessages2.at(-1)?.includes("git branch --list 'adx/<slug>'"),
  )

  // Simulate the agent following the step prompt: deterministic
  // check → numeric suffix → create.
  const branchTaken = (s) => git(`branch --list "adx/${s}"`) !== ''
  let slug = 'dark-theme'
  let n = 2
  while (existsSync(join(wtDir, slug)) || branchTaken(slug)) {
    slug = `dark-theme-${n}`
    n += 1
  }
  check('collision pre-check picks the next free suffix (-2)', slug === 'dark-theme-2')
  git(`worktree add ../.adx-worktrees/${slug} -b adx/${slug} HEAD`)

  // Report the final slug via flow_step_done content, then advance the run.
  await executor2.onStepDone({ content: `final-slug=${slug}` })
  check(
    'setup step reported final slug and advanced to build',
    readState2().execution?.currentStep === 'build',
  )
  check(
    'reported slug is the suffixed one',
    readState2().execution?.lastStepOutput?.content === 'final-slug=dark-theme-2',
  )

  // The collision targets are untouched; the new worktree is registered.
  check(
    'colliding folder left untouched',
    readFileSync(join(wtDir, 'dark-theme', 'marker.txt'), 'utf8') === 'do not touch\n',
  )
  check('colliding branch still exists', branchTaken('dark-theme'))
  check('new worktree folder created', existsSync(join(wtDir, 'dark-theme-2')))
  check('new worktree registered in git', git('worktree list').includes('dark-theme-2'))
  check('no git errors propagated', gitFailures === 0)
}

// ------------------------------------------------------------------ commit param routing (commit=true / commit=false)
// The simple `build` workflow has no sub-agent steps, so the spawn fake throws.
{
  const { execSync } = await import('node:child_process')
  const scratch3 = mkdtempSync(join(tmpdir(), 'adx-e2e-commit-'))
  const repo3 = join(scratch3, 'repo')
  mkdirSync(repo3, { recursive: true })
  writeFileSync(join(repo3, 'index.js'), 'export const x = 1\n')
  const gitEnv3 = {
    ...process.env,
    GIT_AUTHOR_NAME: 'e2e',
    GIT_AUTHOR_EMAIL: 'e2e@e2e.test',
    GIT_COMMITTER_NAME: 'e2e',
    GIT_COMMITTER_EMAIL: 'e2e@e2e.test',
  }
  const git3 = (args) => execSync(`git ${args}`, { cwd: repo3, encoding: 'utf8', env: gitEnv3 }).trim()
  git3('init -q')
  git3('add index.js')
  git3('commit -qm init')

  const makeCommitCtx = (session) => ({
    cwd: repo3,
    sessionManager: { getSessionId: () => session },
    hasUI: true,
    ui: {
      notify: () => {},
      select: async (_title, options) => options[0],
      setWidget: () => {},
      setStatus: () => {},
      theme: { fg: (_c, t) => t, bold: (t) => t, strikethrough: (t) => t },
    },
  })
  const mkCommitExec = (msgs, notes) =>
    new AdxExecutor({
      pi: { sendUserMessage: (m) => msgs.push(m) },
      notify: (m) => notes.push(m),
      updateWidget: () => {},
      spawn: async () => {
        throw new Error('no sub-agent steps in commit scenarios')
      },
      resume: async () => {
        throw new Error('no sub-agent steps in commit scenarios')
      },
    })
  const readState3 = (session) =>
    JSON.parse(readFileSync(join(repo3, '.pi', 'adx-flow', 'state', `${session}.json`), 'utf8'))

  // (a) commit=true → the "Commit changes?" picker is auto-skipped and the
  // commit_push prompt (with the worktree push-only instructions) is injected.
  {
    const msgs = []
    const notes = []
    const exec = mkCommitExec(msgs, notes)
    await exec.launch('build', makeCommitCtx('e2e-commit-true'), 'commit=true')
    check('commit=true: build prompt injected', msgs.some((m) => m.includes('Implement the task')))
    await exec.onStepDone({}) // build done → commit_changes auto-skip
    check(
      'commit=true: "Commit changes?" picker auto-skipped',
      notes.some((n) => n.includes('auto-skipping user step "Commit changes?" (commit=true)')),
    )
    check(
      'commit=true: commit_push prompt injected (worktree instructions: push adx/<slug>, no auto-merge)',
      msgs.at(-1)?.includes('git push -u origin adx/') &&
        msgs.at(-1)?.includes('Do NOT merge the branch into the base branch') &&
        msgs.at(-1)?.includes('git rev-parse --abbrev-ref HEAD'),
    )
    // A failed push does not satisfy the step_result gate → the nudgePrompt
    // re-fires on the same step (the gate keeps the run until a success result).
    await exec.onStepDone({ result: 'push-failed: remote rejected (non-fast-forward)' })
    check(
      'commit=true: failed push re-nudges the commit step (nudgePrompt injected)',
      msgs.at(-1)?.includes('The push has not succeeded yet') &&
        readState3('e2e-commit-true').execution?.currentStep === 'commit_push',
    )
    await exec.onStepDone({ result: 'pushed' }) // push succeeded → summarize
    check('commit=true: summarize prompt injected after the commit step', msgs.at(-1)?.includes('What to test'))
    await exec.onStepDone({})
    check('commit=true: run finished ($done)', readState3('e2e-commit-true').execution?.status === 'done')
  }

  // (b) commit=false → the picker is auto-skipped straight to summarize,
  // and no commit_push prompt is ever injected.
  {
    const msgs = []
    const notes = []
    const exec = mkCommitExec(msgs, notes)
    await exec.launch('build', makeCommitCtx('e2e-commit-false'), 'commit=false')
    await exec.onStepDone({}) // build done → commit_changes auto-skip
    check(
      'commit=false: "Commit changes?" picker auto-skipped to summarize',
      notes.some((n) => n.includes('auto-skipping user step "Commit changes?" (commit=false)')) &&
        msgs.at(-1)?.includes('What to test'),
    )
    check('commit=false: no commit_push prompt injected', !msgs.some((m) => m.includes('git push -u origin adx/')))
    await exec.onStepDone({})
    check('commit=false: run finished ($done)', readState3('e2e-commit-false').execution?.status === 'done')
  }
}

// ------------------------------------------------------------------ spec uniqueness (no silent overwrite)
// Two specs written "in the same second" (same generated slug) must produce
// distinct files; the first one stays intact.
{
  const spec = await jiti.import(join(srcDir, 'spec.ts'))
  const specDir = join(scratchRepo, '.pi', 'specs')
  const first = join(specDir, 'spec-20250101-000000.md')
  const p1 = await spec.writeSpecFile(scratchRepo, first, '# spec one\n')
  const p2 = await spec.writeSpecFile(scratchRepo, first, '# spec two\n')
  check('2nd same-second spec gets a unique suffix', p1 === first && p2 === join(specDir, 'spec-20250101-000000-2.md'))
  check(
    'first spec left intact (no silent overwrite)',
    readFileSync(p1, 'utf8') === '# spec one\n' && readFileSync(p2, 'utf8') === '# spec two\n',
  )
  check(
    'uniqueSpecPath reports a free path unchanged',
    spec.uniqueSpecPath(join(specDir, 'spec-20250101-000001.md')) === join(specDir, 'spec-20250101-000001.md'),
  )
}

// ------------------------------------------------------------------ multi-session: /new starts 100% clean, resume keeps never-stop
// The extension factory is driven with a fake pi: session_start (reason
// new/fork/resume) + before_agent_start sections + /adx-run command.
// (a) a stale legacy in-flight state.json must NOT auto-execute in a new
// session; (b) resuming an in-flight session re-enters the step (never-stop);
// (c) after /new, /adx-run writes the NEW session's state file; (d) a
// finished run leaves planMode=false in its state file (launch-path race).
{
  const extMod = await jiti.import(join(srcDir, 'index.ts'))
  const adxExtension = extMod.default

  // Hermetic project config (project > user precedence): no auto plan mode,
  // no widget (the extension's updateWidget early-returns without UI calls).
  writeFileSync(
    join(scratchRepo, '.pi', 'adx-workflow.json'),
    JSON.stringify({ defaultPlanMode: false, showWidget: false, autoMode: false }),
  )

  const freshMsgs = []
  const extHandlers = {}
  const extCommands = {}
  const fakePiExt = {
    on: (event, handler) => {
      ;(extHandlers[event] ??= []).push(handler)
    },
    registerTool: () => {},
    registerCommand: (name, def) => {
      extCommands[name] = def
    },
    registerFlag: () => {},
    registerShortcut: () => {},
    getFlag: () => false,
    getActiveTools: () => ['bash', 'read'],
    setActiveTools: () => {},
    sendUserMessage: (m) => {
      freshMsgs.push(m)
    },
  }
  adxExtension(fakePiExt)

  const multiCtx = (sessionId, notes = []) => ({
    cwd: scratchRepo,
    sessionManager: { getSessionId: () => sessionId },
    hasUI: true,
    ui: {
      notify: (m, l) => notes.push(`${l ?? 'info'}: ${m}`),
      select: async (_t, options) => options[0],
      setWidget: () => {},
      setStatus: () => {},
      theme: { fg: (_c, t) => t, bold: (t) => t, strikethrough: (t) => t },
    },
  })
  const startSession = (reason, sessionId) =>
    extHandlers.session_start[0]({ type: 'session_start', reason }, multiCtx(sessionId))
  const sectionsOf = () => {
    const sections = {}
    extHandlers.before_agent_start[0]({ systemPromptOptions: { sections } })
    return sections
  }
  const multiState = (sessionId) =>
    JSON.parse(readFileSync(join(scratchRepo, '.pi', 'adx-flow', 'state', `${sessionId}.json`), 'utf8'))

  // (a) A stale legacy shared file with an in-flight run (pre-per-session era).
  const legacyPath = join(scratchRepo, '.pi', 'adx-flow', 'state.json')
  writeFileSync(
    legacyPath,
    JSON.stringify(
      {
        version: 1,
        metadata: { criteria: [{ id: '1', description: 'Legacy criterion', status: 'completed' }] },
        execution: {
          workflowId: 'build-verify',
          workflowName: 'Build & Verify',
          status: 'running',
          currentStep: 'build',
          iteration: 2,
          lastStepOutput: {},
          lastStepResult: '',
          params: {},
          updatedAt: new Date().toISOString(),
          seenSteps: ['work_location', 'build'],
        },
      },
      null,
      2,
    ),
  )
  const legacyBefore = readFileSync(legacyPath, 'utf8')
  freshMsgs.length = 0
  await startSession('new', 'multi-a')
  check('(a) new session with legacy in-flight run: no step prompt auto-injected', freshMsgs.length === 0)
  check('(a) new session: legacy file untouched (no migratedTo mark)', readFileSync(legacyPath, 'utf8') === legacyBefore)
  check('(a) new session: no builder prompt section (executor inactive)', !('adx-impl' in sectionsOf()))
  // (a) is done with the legacy file: remove it so later scenarios' widget
  // "active" check (legacy fallback in widgets.readState) isn't disturbed.
  rmSync(legacyPath)

  // (b) Resuming the SAME session with an in-flight run re-enters the step
  // (never-stop preserved for genuine resumes).
  const bPath = join(scratchRepo, '.pi', 'adx-flow', 'state', 'multi-b.json')
  writeFileSync(
    bPath,
    JSON.stringify(
      {
        version: 1,
        metadata: { criteria: [{ id: '1', description: 'Resume criterion', status: 'completed' }] },
        execution: {
          workflowId: 'build-verify',
          workflowName: 'Build & Verify',
          status: 'running',
          currentStep: 'build',
          iteration: 1,
          lastStepOutput: {},
          lastStepResult: '',
          params: {},
          updatedAt: new Date().toISOString(),
          seenSteps: ['work_location', 'build'],
        },
      },
      null,
      2,
    ),
  )
  freshMsgs.length = 0
  await startSession('resume', 'multi-b')
  check('(b) resume of in-flight session: step prompt auto-injected (never-stop)', freshMsgs.length === 1 && freshMsgs[0].includes('flow_step_done'))
  check('(b) resume: builder prompt section active', 'adx-impl' in sectionsOf())

  // (c) /new after that session: /adx-run writes the NEW session's file; the
  // old session's in-flight run stays intact in its own file.
  freshMsgs.length = 0
  await startSession('new', 'multi-c')
  check('(c) after /new: executor state reset (no builder section from the old run)', !('adx-impl' in sectionsOf()))
  await extCommands['adx-run'].handler('build-verify worklocation=current', multiCtx('multi-c'))
  check('(c) /adx-run after /new writes the NEW session state file', multiState('multi-c').execution?.status === 'running' && multiState('multi-c').execution?.currentStep === 'build')
  check('(c) old session file untouched (in-flight run stays there)', multiState('multi-b').execution?.status === 'running' && multiState('multi-b').execution?.currentStep === 'build')

  // (d) Finished run leaves planMode=false: emulate the fixed launch path —
  // an AWAITED planMode=false persist (exitPlanMode) must not be clobbered
  // by the executor's launch persist (the old fire-and-forget race wrote it
  // back, leaving done runs with planMode=true).
  const dPath = join(scratchRepo, '.pi', 'adx-flow', 'state', 'multi-d.json')
  writeFileSync(
    dPath,
    JSON.stringify(
      {
        version: 1,
        metadata: { criteria: [{ id: '1', description: 'Race criterion', status: 'completed' }] },
        execution: null,
        planMode: true,
      },
      null,
      2,
    ),
  )
  const storeMod = await jiti.import(join(srcDir, 'store.ts'))
  await storeMod.mutateState(scratchRepo, 'multi-d', (s) => {
    s.planMode = false
  })
  const dMsgs = []
  const dExec = new AdxExecutor({
    pi: { sendUserMessage: (m) => dMsgs.push(m) },
    notify: () => {},
    updateWidget: () => {},
    spawn: async () => {
      throw new Error('no sub-agent steps in the plan-mode race scenario')
    },
    resume: async () => {
      throw new Error('no sub-agent steps in the plan-mode race scenario')
    },
  })
  await dExec.launch('build', multiCtx('multi-d'), 'worklocation=current commit=false')
  check('(d) build step prompt injected (race scenario run started)', dMsgs.length === 1 && dMsgs[0].includes('criteria'))
  await dExec.onStepDone({}) // build done → commit auto-skipped → summarize
  check('(d) summarize prompt injected after auto-skip', dMsgs.at(-1)?.includes('What to test'))
  await dExec.onStepDone({})
  check('(d) finished run leaves planMode=false in its state file', multiState('multi-d').execution?.status === 'done' && multiState('multi-d').planMode === false)

  // (e) Re-entering plan mode AFTER a completed run (execution stays done)
  // and stopping mid-plan must restore plan mode on resume — the guard must
  // not treat the stale done execution as "plan finished".
  writeFileSync(
    join(scratchRepo, '.pi', 'adx-flow', 'state', 'multi-e.json'),
    JSON.stringify(
      {
        version: 1,
        metadata: { criteria: [{ id: '1', description: 'Next iteration', status: 'completed' }] },
        execution: {
          workflowId: 'build',
          workflowName: 'Build',
          status: 'done',
          currentStep: 'summarize',
          iteration: 3,
          lastStepOutput: {},
          lastStepResult: '',
          params: {},
          updatedAt: new Date().toISOString(),
          seenSteps: ['work_location', 'build', 'summarize'],
        },
        planMode: true,
      },
      null,
      2,
    ),
  )
  const eNotes = []
  const eCtx = multiCtx('multi-e', eNotes)
  await extHandlers.session_start[0]({ type: 'session_start', reason: 'resume' }, eCtx)
  check('(e) plan re-entered after a done run is restored on resume', 'adx-plan' in sectionsOf())
  check('(e) "plan mode restored" notification emitted', eNotes.some((n) => n.includes('plan mode restored')))

  // (f) plan→spec switch: the fire-and-forget exitPlanMode continuation
  // must not clear the SPEC badge it was superseded by (badge writes are
  // observed via ctx.ui.setStatus; the last write must be the spec badge).
  // Badge writes are suppressed with showWidget=false, so flip the scratch
  // project config back on and re-load it via a fresh session_start.
  writeFileSync(
    join(scratchRepo, '.pi', 'adx-workflow.json'),
    JSON.stringify({ defaultPlanMode: false, showWidget: true, autoMode: false }),
  )
  await extHandlers.session_start[0]({ type: 'session_start', reason: 'new' }, multiCtx('multi-f'))
  const statusWrites = []
  const fBase = multiCtx('multi-f')
  const fCtx = {
    ...fBase,
    ui: {
      ...fBase.ui,
      setStatus: (key, value) => {
        statusWrites.push(value)
      },
    },
  }
  await extCommands['adx-plan'].handler('', fCtx)
  await extCommands['adx-spec'].handler('', fCtx)
  // Let the pending exit continuation (post-persist) settle.
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
  check('(f) plan→spec switch keeps the SPEC badge (no clobber)', statusWrites.at(-1)?.includes('[SPEC]') === true)

  // (g) /new after a plan-mode session: in-memory mode state must not leak
  // into the new session (the extension closure + widget badge survive for
  // the whole pi process) — no adx-plan prompt section, no [PLAN] badge.
  const gBase = multiCtx('multi-g')
  const gStatus = []
  const gCtx = {
    ...gBase,
    ui: {
      ...gBase.ui,
      setStatus: (key, value) => {
        gStatus.push(value)
      },
    },
  }
  await extCommands['adx-plan'].handler('', gCtx)
  check('(g) [PLAN] badge set before /new', gStatus.at(-1)?.includes('[PLAN]') === true)
  await extHandlers.session_start[0]({ type: 'session_start', reason: 'new' }, gCtx)
  check('(g) /new after plan mode: no adx-plan section (in-memory state reset)', !('adx-plan' in sectionsOf()))
  check('(g) /new clears the [PLAN] badge', gStatus.at(-1) === undefined)
}

// ------------------------------------------------------------------ report
console.log(`\nwidget refreshes: ${widgetRefreshes}`)
console.log(`user messages: ${userMessages.length}, notifications: ${notifications.length}`)
console.log(failures === 0 ? '\nALL CHECKS PASSED ✅' : `\n${failures} CHECKS FAILED ❌`)
process.exit(failures === 0 ? 0 : 1)
