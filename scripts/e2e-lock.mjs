/**
 * E2E: cross-process state-lock test.
 *
 * Spawns two child processes that both hammer the SAME per-session state file
 * with parallel flow_meta-style additions. Asserts zero lost updates —
 * the failure mode that made the kanban run pay 3 redundant verifier passes
 * (the verifier's "passed" writes were lost against the parent's writes).
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PER_CHILD = 25
const CHILDREN = 2

const scratch = mkdtempSync(join(tmpdir(), 'adx-lock-'))
// The state file only exists after the first save — create the dir tree.
mkdirSync(join(scratch, '.pi', 'adx-flow', 'state'), { recursive: true })

// Spawn ALL children concurrently (sequential spawning would serialize the
// cross-process access and hide the race).
const children = Array.from({ length: CHILDREN }, (_, c) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'scripts', 'lock-child.mjs'), String(PER_CHILD)], {
      cwd: scratch,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let err = ''
    child.stderr?.on('data', (d) => (err += d))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`child ${c} failed: ${err}`))
    })
  }),
)
const settled = await Promise.allSettled(children)
for (let c = 0; c < CHILDREN; c++) {
  if (settled[c].status === 'rejected') {
    console.log(settled[c].reason.message)
    process.exit(1)
  }
}

const state = JSON.parse(readFileSync(join(scratch, '.pi', 'adx-flow', 'state', 'lock-test.json'), 'utf8'))
const count = (state.metadata?.['criteria'] ?? []).length
const ok = count === PER_CHILD * CHILDREN
console.log(`entries after ${CHILDREN} concurrent processes × ${PER_CHILD} parallel adds: ${count} (expected ${PER_CHILD * CHILDREN})`)
console.log(ok ? 'CROSS-PROCESS LOCK OK ✅' : 'LOST UPDATES ❌')
process.exit(ok ? 0 : 1)
