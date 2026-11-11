/**
 * Cross-process lock check (child side): performs N parallel flow_meta-style
 * additions to the SAME state file as sibling processes. Without the
 * cross-process lock, read-modify-write interleaves across processes lose
 * updates (the kanban regression: the verifier's "passed" writes were lost
 * against the parent's writes).
 *
 * Usage: node scripts/lock-child.mjs <adds>  (cwd must be the scratch project)
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createJitiFromPi } from './find-jiti.mjs'

const createJiti = createJitiFromPi()
const jiti = createJiti(import.meta.url, { cache: false, interopDefault: true })
const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
const { mutateState } = await jiti.import(join(srcDir, 'store.ts'))

const adds = Number(process.argv[2] ?? 25)
const cwd = process.cwd()
const sessionId = 'lock-test'

await Promise.all(
  Array.from({ length: adds }, (_, i) =>
    mutateState(cwd, sessionId, (state) => {
      const list = state.metadata['criteria'] ?? []
      list.push({ id: String(list.length + 1), description: `child-${process.pid}-${i}`, status: 'pending' })
      state.metadata['criteria'] = list
    }),
  ),
)
console.log('child done')
