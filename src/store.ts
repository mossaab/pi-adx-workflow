/**
 * adx-workflow: file-backed session store.
 *
 * Holds workflow metadata (criteria / todos / review_findings)
 * plus the workflow execution state. Persisted PER PI SESSION at
 * `<cwd>/.pi/adx-flow/state/<sessionId>.json` so each pi session has its
 * own plan/run — resuming a session (same id) restores its state, while a
 * new session starts fresh. Legacy state lives at
 * `<cwd>/.pi/adx-flow/state.json` (shared); on the first per-session load,
 * an in-flight legacy run (status ≠ done, not yet adopted) is adopted into
 * the new session's file so old in-flight runs keep working.
 *
 * Flow sub-agent children (ADX_CHILD=1) always read/write the PARENT's state
 * file, whose path is passed via the ADX_FLOW_STATE env var.
 */

import { constants as fsConstants } from 'node:fs'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// ============================================================================
// Metadata entries
// ============================================================================

export interface MetaEntry {
  id: string
  description: string
  status: string
  [key: string]: unknown
}

/** Known keys and their status ladders. */
export const META_SCHEMAS: Record<
  string,
  { description: string; fields: Record<string, string>; statuses: string[] }
> = {
  criteria: {
    description: 'Acceptance criteria that drive workflow transitions',
    fields: {
      id: 'string (auto-generated; numeric ids accepted and normalized)',
      description: 'string — what needs to be done and how to verify it',
      status: 'pending | completed | passed | failed',
    },
    statuses: ['pending', 'completed', 'passed', 'failed'],
  },
  todos: {
    description: 'Task tracking items for the builder',
    fields: {
      id: 'string (auto-generated)',
      description: 'string — task description',
      status: 'pending | in_progress | completed',
    },
    statuses: ['pending', 'in_progress', 'completed'],
  },
  review_findings: {
    description: 'Code review findings from the code_reviewer sub-agent',
    fields: {
      id: 'string (auto-generated)',
      description: 'string — finding description',
      status: 'open | resolved | dismissed',
      severity: 'minor | major | critical (optional)',
    },
    statuses: ['open', 'resolved', 'dismissed'],
  },
  resume: {
    description:
      'Resume notes: where the agent stopped mid-step and what to do next (latest note wins). Written by the agent before stopping; consumed by the auto-continue mechanism.',
    fields: {
      id: 'string (auto-generated)',
      description: 'string — where you stopped + the exact next action',
      status: 'pending (default)',
    },
    statuses: ['pending'],
  },
  progress: {
    description:
      'Display-only live progress feed written by sub-agents (verifier / code reviewer). The TUI activity widget shows the latest entry while the child runs. Never drives transitions; capped (oldest entries are pruned on add).',
    fields: {
      id: 'string (auto-generated)',
      description: 'string — one short line of what the sub-agent is doing',
      status: 'pending (default, unused)',
    },
    statuses: ['pending'],
  },
}

// ============================================================================
// Execution state
// ============================================================================

export type ExecutionStatus = 'running' | 'waiting' | 'blocked' | 'done'

export interface ExecutionState {
  workflowId: string
  workflowName: string
  status: ExecutionStatus
  /** Step the executor is currently on (or last on, when waiting/blocked/done) */
  currentStep: string
  /** Total state-machine iterations consumed (capped by maxIterations) */
  iteration: number
  /** Output map of the last executed step ({{stepOutput.*}}) */
  lastStepOutput: Record<string, string>
  /** Result string of the last executed step */
  lastStepResult: string
  /** Launch parameters (e.g. pr_number) */
  params: Record<string, string>
  /** Steps already entered in this run (drives nudge-on-re-entry semantics) */
  seenSteps?: string[]
  /** Set when the legacy shared state.json run was adopted into a per-session file. */
  migratedTo?: string
  /** Most recent sub-agent step run — drives the verifier re-run short-circuit
   * (code hash unchanged + gate met ⇒ skip the expensive re-run). */
  lastSubAgentStep?: { stepId: string; ok: boolean; hash?: string; at: string }
  /** Human-readable reason the last transition gate was unmet (shown in nudges). */
  lastNudgeReason?: string
  updatedAt: string
}

export interface FlowState {
  version: 1
  metadata: Record<string, MetaEntry[]>
  execution: ExecutionState | null
  /** Persisted plan-mode flag: restored when the session is resumed. */
  planMode?: boolean
}

const STATE_DIR = '.pi/adx-flow'

/**
 * Resolve the state file to use:
 * - flow children (ADX_CHILD=1) always use the parent's file (ADX_FLOW_STATE);
 *   without it (older parent) they fall back to the legacy shared file;
 * - a pi session id → `<cwd>/.pi/adx-flow/state/<sessionId>.json`;
 * - no session id → legacy shared `<cwd>/.pi/adx-flow/state.json`.
 */
export function stateFileFor(cwd: string, sessionId?: string): string {
  if (process.env.ADX_CHILD === '1') {
    return process.env.ADX_FLOW_STATE ?? join(cwd, STATE_DIR, 'state.json')
  }
  if (sessionId) return join(cwd, STATE_DIR, 'state', `${sessionId}.json`)
  return join(cwd, STATE_DIR, 'state.json')
}

function legacyStatePath(cwd: string): string {
  return join(cwd, STATE_DIR, 'state.json')
}

async function readRaw(path: string): Promise<Partial<FlowState> | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Partial<FlowState>
  } catch {
    return undefined
  }
}

function normalizeState(parsed: Partial<FlowState> | undefined): FlowState {
  return {
    version: 1,
    metadata: parsed?.metadata ?? {},
    execution: parsed?.execution ?? null,
    planMode: parsed?.planMode ?? false,
  }
}

/** One-time legacy migration: adopt an in-flight shared run into a session file. */
async function adoptLegacy(cwd: string, sessionId: string): Promise<FlowState | undefined> {
  const legacy = (await readRaw(legacyStatePath(cwd))) as FlowState | undefined
  if (!legacy?.execution || legacy.execution.status === 'done') return undefined
  if (legacy.execution.migratedTo) return undefined // already adopted by another session
  legacy.execution.migratedTo = sessionId
  const adopted = normalizeState(legacy)
  await saveState(cwd, adopted, sessionId)
  // Mark the shared legacy file as adopted so no other session re-adopts it
  // (serialized through the same write chain, atomic like saveState).
  const run = saveChain.then(async () => {
    const path = legacyStatePath(cwd)
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(legacy, null, 2), 'utf8')
    await rename(tmp, path)
  })
  saveChain = run.catch(() => undefined)
  await run
  return adopted
}

export async function loadState(cwd: string, sessionId?: string): Promise<FlowState> {
  const parsed = await readRaw(stateFileFor(cwd, sessionId))
  if (parsed !== undefined) return normalizeState(parsed)
  // New per-session file: try to adopt a legacy in-flight run (shared state.json).
  if (sessionId && process.env.ADX_CHILD !== '1') {
    const adopted = await adoptLegacy(cwd, sessionId)
    if (adopted) return adopted
  }
  return normalizeState(undefined)
}

// Serialize writes (per process) and make them atomic (tmp + rename) so a
// concurrent reader can never observe a partially written file.
let saveChain: Promise<unknown> = Promise.resolve()

/**
 * Cross-process lock around the state file. The parent pi process and each
 * `pi -p` flow child (verifier / reviewer) have their own in-process
 * saveChain, so the chain alone cannot stop a parent persist() from racing a
 * child's flow_meta write (lost updates). A lock file (O_EXCL) serializes
 * writers across processes; a lock left behind by a crashed holder is stolen
 * after LOCK_STALE_MS.
 */
const LOCK_STALE_MS = 15_000
const LOCK_TIMEOUT_MS = 10_000
const LOCK_POLL_MS = 50

async function withStateLock(
  cwd: string,
  sessionId: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const path = stateFileFor(cwd, sessionId)
  await mkdir(dirname(path), { recursive: true })
  const lockPath = `${path}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const fh = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY)
      await fh.writeFile(String(process.pid))
      try {
        await fn()
      } finally {
        await fh.close()
        await unlink(lockPath).catch(() => undefined)
      }
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Steal a stale lock (crashed holder) instead of waiting for it.
      const st = await stat(lockPath).catch(() => undefined)
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => undefined)
        continue
      }
      if (Date.now() > deadline)
        throw new Error(
          `adx-flow: state lock "${lockPath}" not acquired within ${LOCK_TIMEOUT_MS}ms`,
        )
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS))
    }
  }
}

async function writeAtomic(
  cwd: string,
  state: FlowState,
  sessionId: string | undefined,
): Promise<void> {
  const path = stateFileFor(cwd, sessionId)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await rename(tmp, path)
}

export function saveState(cwd: string, state: FlowState, sessionId?: string): Promise<void> {
  const run = saveChain.then(() =>
    withStateLock(cwd, sessionId, () => writeAtomic(cwd, state, sessionId)),
  )
  saveChain = run.catch(() => undefined)
  return run
}

/**
 * Atomic read-modify-write under the write chain AND the cross-process lock:
 * `mutate` sees the latest persisted state and the result is written
 * atomically — no lost updates when parallel tool calls interleave, or when
 * a parent persist() races a flow child's flow_meta write.
 */
export function mutateState(
  cwd: string,
  sessionId: string | undefined,
  mutate: (state: FlowState) => void | Promise<void>,
): Promise<void> {
  const run = saveChain.then(() =>
    withStateLock(cwd, sessionId, async () => {
      const state = normalizeState(await readRaw(stateFileFor(cwd, sessionId)))
      await mutate(state)
      await writeAtomic(cwd, state, sessionId)
    }),
  )
  saveChain = run.catch(() => undefined)
  return run
}

// ============================================================================
// Metadata operations
// ============================================================================

function normalizeId(id: unknown): string | undefined {
  if (typeof id === 'string' && id !== '') return id
  if (typeof id === 'number') return String(id)
  return undefined
}

export function metaAdd(
  state: FlowState,
  key: string,
  description: string,
  status?: string,
): MetaEntry {
  const current = state.metadata[key] ?? []
  const entry: MetaEntry = {
    id: (current.length + 1).toString(),
    description,
    status: status || 'pending',
  }
  state.metadata[key] = [...current, entry]
  return entry
}

export function metaUpdate(
  state: FlowState,
  key: string,
  id: string,
  patch: { description?: string; status?: string },
): MetaEntry | undefined {
  const current = state.metadata[key]
  if (!current) return undefined
  const idx = current.findIndex((e) => e.id === id)
  if (idx === -1) return undefined
  const entry = current[idx]!
  current[idx] = {
    ...entry,
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
  }
  return current[idx]
}

export function metaRemove(state: FlowState, key: string, id: string): boolean {
  const current = state.metadata[key]
  if (!current) return false
  const next = current.filter((e) => e.id !== id)
  if (next.length === current.length) return false
  state.metadata[key] = next
  return true
}

/**
 * Evaluate metadata transition conditions:
 * - metadata_all_match: every entry's field === value (empty list ⇒ true)
 * - metadata_all_in: every entry's field is one of values (empty list ⇒ true)
 */
export function metaConditionMet(
  state: FlowState,
  condition:
    | { type: 'metadata_all_match'; key: string; field: string; value: string }
    | { type: 'metadata_all_in'; key: string; field: string; values: string[] },
): boolean {
  const entries = state.metadata[condition.key]
  if (!entries || entries.length === 0) return true
  if (condition.type === 'metadata_all_match') {
    return entries.every((e) => e[condition.field] === condition.value)
  }
  return entries.every((e) => condition.values.includes(e[condition.field] as string))
}

/** Count criteria that are not yet passed (pending/completed/failed). */
export function pendingCriteriaCount(state: FlowState): number {
  const entries = state.metadata['criteria'] ?? []
  return entries.filter((e) => e.status !== 'passed').length
}

export { normalizeId }
