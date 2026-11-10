// Smoke-load the adx-workflow extension via jiti (same loader pi uses).
import { createRequire } from 'node:module'

const require = createRequire(
  '/Users/mossaab/.pi/agent/install/releases/1.5.1/node_modules/jiti/',
)
const { createJiti } = require('jiti')
const jiti = createJiti(import.meta.url, { cache: false, interopDefault: true })

const mod = await jiti.import('/Users/mossaab/projects/pi-adx-workflow/src/index.ts')
const ext = mod.default ?? mod
if (typeof ext !== 'function') {
  console.error('FAIL: default export is not a function:', typeof ext)
  process.exit(1)
}

// Fake a minimal ExtensionAPI to exercise registration paths
const registered = { tools: [], commands: [], shortcuts: [], events: [] }
const pi = {
  registerTool: (t) => registered.tools.push(t.name),
  registerCommand: (name) => registered.commands.push(name),
  registerShortcut: (s) => registered.shortcuts.push(s),
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
console.log('commands:', registered.commands.join(', '))
console.log('shortcuts:', registered.shortcuts.join(', '))
console.log('events:', registered.events.join(', '))
