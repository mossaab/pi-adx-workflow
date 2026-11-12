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

// Command set: 8 canonical + 3 deprecated aliases = 11 registrations.
const expectedCommands = [
  'adx-plan', 'adx-spec', 'adx-approve', 'adx-run',
  'adx-status', 'adx-resume', 'adx-cancel', 'adx-config',
  // deprecated aliases
  'adx-build-mode', 'adx-build', 'adx-build-verify',
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
// Aliases must delegate to the exact canonical handler (same function
// reference), so behavior can never drift between the two names.
const aliasPairs = [
  ['adx-build-mode', 'adx-approve'],
  ['adx-build', 'adx-run'],
]
for (const [alias, canonical] of aliasPairs) {
  if (registered.commands.get(alias).handler !== registered.commands.get(canonical).handler) {
    console.error(`FAIL: alias /${alias} must share the /${canonical} handler (same reference)`)
    process.exit(1)
  }
}
// /adx-build-verify delegates to the generic /adx-run handler with
// "build-verify" prefixed (hardcoded workflow id + config defaults), so it
// is equivalent to /adx-run build-verify by construction — but keeps its
// own function reference (the alias must not share the canonical handler).
if (registered.commands.get('adx-build-verify').handler === registered.commands.get('adx-run').handler) {
  console.error('FAIL: /adx-build-verify must keep its own handler reference (delegating to /adx-run, not sharing it)')
  process.exit(1)
}
console.log('commands OK: 11 registered (8 canonical + 3 deprecated aliases, delegating)')

// Sub-agent spawning must be able to find the extension entry (self-resolution
// works for dev symlinks and git/npm package installs alike).
const { resolveExtensionPath } = await jiti.import(join(repoRoot, 'src', 'subagent.ts'))
const entry = resolveExtensionPath()
if (!entry || !existsSync(entry)) {
  console.error('FAIL: extension entry not resolvable for sub-agent spawning:', entry)
  process.exit(1)
}
console.log('extension entry:', entry)
