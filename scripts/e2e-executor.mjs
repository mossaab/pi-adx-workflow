/**
 * E2E smoke test: drive the full build-verify pipeline through AdxExecutor
 * with a fake pi (simulated LLM tool calls + simulated sub-agent children).
 *
 * Verifies: user-step choice → build agent step → nudge loop → verifier
 * sub-agent (failed → passed) → code reviewer sub-agent → finalize loop →
 * summarize → $done, with persistence and widget refreshes.
 */
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(
  '/Users/mossaab/.pi/agent/install/releases/1.5.1/node_modules/jiti/',
)
const { createJiti } = require('jiti')
const jiti = createJiti(import.meta.url, { cache: false, interopDefault: true })

const srcDir = '/Users/mossaab/projects/pi-adx-workflow/src'
const { AdxExecutor } = await jiti.import(join(srcDir, 'executor.ts'))
const { createFlowMetaTool } = await jiti.import(join(srcDir, 'tools.ts'))

// ------------------------------------------------------------------ scratch project
const scratch = mkdtempSync(join(tmpdir(), 'adx-e2e-'))
const scratchRepo = join(scratch, 'repo')
mkdirSync(scratchRepo, { recursive: true })
writeFileSync(join(scratchRepo, 'index.js'), 'export const x = 1\n')

const statePath = join(scratchRepo, '.pi', 'adx-flow', 'state.json')
const readState = () => JSON.parse(readFileSync(statePath, 'utf8'))
const stateDir = join(scratchRepo, '.pi', 'adx-flow')

// ------------------------------------------------------------------ fake pi
const userMessages = []
const userMessageOpts = [] // parallel to userMessages: the deliverAs options passed
const notifications = []
let widgetRefreshes = 0

function fakeCtx() {
  return {
    cwd: scratchRepo,
    ui: {
      notify: (msg, level) => notifications.push(`${level ?? 'info'}: ${msg}`),
      select: async (title, options) => {
        // Simulate user choices:
        // - "Where to work" → work in current workspace
        // - "Approve Fix Plan" → apply
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

const fakeSpawn = async (agent, task) => {
  spawnCalls.push(agent)
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
const fakeResume = async (agent, runId, message) => {
  spawnCalls.push(`${agent}:resume`)
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
  const res = await flowMeta.execute('t', args, undefined, undefined, { cwd: scratchRepo })
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
  userMessages.some((m) => m.includes('criteria remaining') && m.includes('Verification pass 1')),
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
  'verify→build re-entry (nudgePrompt) sent with deliverAs: followUp (busy-safe)',
  userMessageOpts[userMessages.findIndex((m) => m.includes('criteria remaining'))]?.deliverAs === 'followUp',
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

// Summarize agent step injected
check('summarize prompt injected', userMessages.some((m) => m.includes('What to test')))
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
// build↔verify loop burns maxIterations (12) → $blocked
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

// ------------------------------------------------------------------ report
console.log(`\nwidget refreshes: ${widgetRefreshes}`)
console.log(`user messages: ${userMessages.length}, notifications: ${notifications.length}`)
console.log(failures === 0 ? '\nALL CHECKS PASSED ✅' : `\n${failures} CHECKS FAILED ❌`)
process.exit(failures === 0 ? 0 : 1)
