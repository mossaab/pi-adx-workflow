// Smoke-load the adx-workflow extension via jiti (same loader pi uses).
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createJitiFromPi } from './find-jiti.mjs'

// Clear ambient child mode so the FULL (parent) registration paths always run,
// even when the smoke test is launched from inside a pi child session.
delete process.env.ADX_CHILD

const createJiti = createJitiFromPi()
const jiti = createJiti(import.meta.url, { cache: false, interopDefault: true })

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const mod = await jiti.import(join(repoRoot, 'src', 'index.ts'))
const ext = mod.default ?? mod
if (typeof ext !== 'function') {
  console.error('FAIL: default export is not a function:', typeof ext)
  process.exit(1)
}

// Fake a minimal ExtensionAPI to exercise registration paths. `on` captures
// the handlers so the tool_call guard can be exercised below.
const registered = { tools: [], commands: new Map(), shortcuts: [], events: [], flags: [] }
const handlers = new Map()
const pi = {
  registerTool: (t) => registered.tools.push(t.name),
  registerCommand: (name, def) => registered.commands.set(name, def),
  registerShortcut: (s) => registered.shortcuts.push(s),
  registerFlag: (name) => registered.flags.push(name),
  on: (event, handler) => {
    registered.events.push(event)
    handlers.set(event, handler)
  },
  events: {
    on: () => {},
    off: () => {},
    emit: (name) => {
      if (String(name).startsWith('pi-subagents:')) {
        // pretend pi-subagents is not installed → extension should warn, not throw
      }
      return true
    },
  },
  getActiveTools: () => ['read', 'bash', 'edit', 'write'],
  setActiveTools: () => {},
  sendUserMessage: () => {},
}

ext(pi)
console.log('LOADED OK')
console.log('tools:', registered.tools.join(', '))
console.log('commands:', [...registered.commands.keys()].join(', '))
console.log('shortcuts:', registered.shortcuts.join(', '))
console.log('flags:', registered.flags.join(', '))
console.log('events:', registered.events.join(', '))

// Command set: 8 canonical commands.
const expectedCommands = [
  'adx-plan', 'adx-spec', 'adx-approve', 'adx-run',
  'adx-status', 'adx-resume', 'adx-cancel', 'adx-config',
]
if (registered.commands.size !== expectedCommands.length) {
  console.error(`FAIL: expected ${expectedCommands.length} commands, got ${registered.commands.size}:`, [...registered.commands.keys()].join(', '))
  process.exit(1)
}
for (const name of expectedCommands) {
  if (!registered.commands.has(name)) {
    console.error('FAIL: missing command registration:', name)
    process.exit(1)
  }
}
console.log('commands OK: 8 registered')

// Sub-agent spawning must be able to find the extension entry (self-resolution
// works for dev symlinks and git/npm package installs alike).
const { resolveExtensionPath } = await jiti.import(join(repoRoot, 'src', 'subagent.ts'))
const entry = resolveExtensionPath()
if (!entry || !existsSync(entry)) {
  console.error('FAIL: extension entry not resolvable for sub-agent spawning:', entry)
  process.exit(1)
}
console.log('extension entry:', entry)

// ------------------------------------------------------------------ plan-mode exec guard
// Enter plan mode via the registered /adx-plan command handler (it needs only
// a ctx with ui.notify + a session id + cwd), then exercise the tool_call
// guard: read-only calls pass, code-executing / non-read-only calls are blocked
// with a read-only reason (block without terminate).
const smokeCwd = mkdtempSync(join(tmpdir(), 'adx-smoke-'))
const fakeCtx = {
  cwd: smokeCwd,
  sessionManager: { getSessionId: () => 'smoke-test' },
  ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
}
const adxPlan = registered.commands.get('adx-plan')
if (!adxPlan?.handler) {
  console.error('FAIL: adx-plan command handler missing')
  process.exit(1)
}
await adxPlan.handler('', fakeCtx)

const toolCall = handlers.get('tool_call')
if (typeof toolCall !== 'function') {
  console.error('FAIL: tool_call handler not registered')
  process.exit(1)
}
const call = (toolName, input) => toolCall({ toolName, input })
const isBlocked = (r) => r && r.block === true && typeof r.reason === 'string'
const isAllowed = (r) => r === undefined
let guardChecks = 0
function check(label, ok) {
  guardChecks++
  if (!ok) {
    console.error(`FAIL (plan-mode guard): ${label}`)
    process.exit(1)
  }
}

try {
  // ctx_execute: read-only shell passes
  check('ctx_execute shell read-only allowed', isAllowed(call('ctx_execute', { language: 'shell', code: 'git log --oneline -3' })))
  // ctx_execute: python / javascript / typescript blocked (full FS access)
  for (const language of ['python', 'javascript', 'typescript']) {
    check(`ctx_execute ${language} blocked`, isBlocked(call('ctx_execute', { language, code: 'print(1)' })))
  }
  // ctx_execute: missing language → fail-safe block
  check('ctx_execute without language blocked', isBlocked(call('ctx_execute', { code: 'ls' })))
  // ctx_execute: shell with && chains / file redirects blocked
  check('ctx_execute shell && blocked', isBlocked(call('ctx_execute', { language: 'shell', code: 'ls && rm x' })))
  check('ctx_execute shell redirect blocked', isBlocked(call('ctx_execute', { language: 'shell', code: 'ls > /tmp/out' })))
  // codemode: always blocked (can invoke any tool, incl. write tools)
  check('codemode blocked', isBlocked(call('codemode', { code: 'console.log(1)' })))
  // ctx_batch: all-safe commands allowed, one unsafe command blocks
  check('ctx_batch safe commands allowed', isAllowed(call('ctx_batch', { commands: ['git log --oneline -3', 'ls -la'] })))
  check('ctx_batch unsafe command blocked', isBlocked(call('ctx_batch', { commands: ['ls', 'rm -rf /tmp/x'] })))
  // bash regression: read-only allowed, destructive blocked
  check('bash read-only allowed', isAllowed(call('bash', { command: 'git log --oneline -3' })))
  check('bash destructive blocked', isBlocked(call('bash', { command: 'npm install' })))
} finally {
  rmSync(smokeCwd, { recursive: true, force: true })
}

console.log(`plan-mode guard OK: ${guardChecks} checks passed`)
process.exit(0)
