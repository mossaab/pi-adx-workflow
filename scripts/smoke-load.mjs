// Smoke-load the adx-workflow extension via jiti (same loader pi uses).
import { existsSync } from 'node:fs'
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

// Fake a minimal ExtensionAPI to exercise registration paths
const registered = { tools: [], commands: new Map(), shortcuts: [], events: [], flags: [] }
const pi = {
  registerTool: (t) => registered.tools.push(t.name),
  registerCommand: (name, def) => registered.commands.set(name, def),
  registerShortcut: (s) => registered.shortcuts.push(s),
  registerFlag: (name) => registered.flags.push(name),
  on: (e) => registered.events.push(e),
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
