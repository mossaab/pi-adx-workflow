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
  /** Persisted spec-mode flag (read-only brainstorm/research; spec file pending). */
  specMode?: boolean
  /** Spec file location pinned for the in-progress spec (relative to cwd). */
  specPath?: string
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
  // Sanitize the id before it reaches a file path (pi session ids are UUIDs
  // today; a future id containing '/' or other path characters must not be
  // able to escape the state directory).
  if (sessionId) {
    const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_')
    return join(cwd, STATE_DIR, 'state', `${safe}.json`)
  }
  return join(cwd, STATE_DIR, 'state.json')
}

function legacyStatePath(cwd: string): string {
  return join(cwd, STATE_DIR, 'state.json')
}

let corruptNotified = false

/**
 * Optional sink for state-file warnings (corrupt reset, version mismatch).
 * The store is a pure module with no UI access — index.ts registers a hook
 * that forwards warnings to the TUI, so a state reset is visible, not just
 * a console.warn.
 */
let stateWarning: ((msg: string) => void) | undefined
export function onStateWarning(fn: (msg: string) => void): void {
  stateWarning = fn
}
function warnState(msg: string): void {
  stateWarning?.(msg)
  console.warn(msg)
}

async function readRaw(
  path: string,
  opts?: { locked?: boolean },
): Promise<Partial<FlowState> | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined // file absent — a fresh state is expected
  }
  try {
    return JSON.parse(raw) as Partial<FlowState>
  } catch {
    // Corrupt file (torn write, manual edit): preserve it as a traceable
    // artifact instead of silently losing the plan, and start fresh.
    const recover = async (): Promise<Partial<FlowState> | undefined> => {
      // Re-read first: a concurrent writer's atomic tmp+rename may have
      // already replaced the corrupt file while we were parsing it.
      let current: string
      try {
        current = await readFile(path, 'utf8')
      } catch {
        return undefined // vanished in the meantime
      }
      try {
        return JSON.parse(current) as Partial<FlowState>
      } catch {
        const corrupt = `${path}.corrupt-${Date.now()}`
        await rename(path, corrupt).catch(() => undefined)
        if (!corruptNotified) {
          corruptNotified = true
          warnState(
            `adx-flow: state file "${path}" was unreadable — preserved as "${corrupt}" and reset to empty state`,
          )
        }
        return undefined
      }
    }
    // If we don't already hold this file's lock, take it so the recovery
    // rename is ordered with concurrent writers' atomic renames (a writer
    // can no longer have its fresh good file moved into .corrupt).
    if (opts?.locked) return recover()
    let recovered: Partial<FlowState> | undefined
    try {
      await withFileLock(`${path}.lock`, async () => {
        recovered = await recover()
      })
    } catch {
      recovered = await recover() // lock unavailable — best effort
    }
    return recovered
  }
}

function normalizeState(parsed: Partial<FlowState> | undefined): FlowState {
  return {
    version: 1,
    metadata: parsed?.metadata ?? {},
    execution: parsed?.execution ?? null,
    planMode: parsed?.planMode ?? false,
    specMode: parsed?.specMode ?? false,
    specPath: parsed?.specPath,
  }
}

/** One-time legacy migration: adopt an in-flight shared run into a session file. */
async function adoptLegacy(cwd: string, sessionId: string): Promise<FlowState | undefined> {
  const legacyPath = legacyStatePath(cwd)
  let legacy: FlowState | undefined
  // Read → check → mark → write the shared legacy file inside ONE lock
  // acquisition: the migratedTo check and the write-back must be atomic
  // together, otherwise two sessions in the same cwd can both read the same
  // un-adopted in-flight run and both adopt it (TOCTOU).
  await withFileLock(`${legacyPath}.lock`, async () => {
    legacy = (await readRaw(legacyPath, { locked: true })) as FlowState | undefined
    if (!legacy?.execution || legacy.execution.status === 'done') return
    if (legacy.execution.migratedTo) return // already adopted by another session
    legacy.execution.migratedTo = sessionId
    const tmp = `${legacyPath}.tmp`
    await writeFile(tmp, JSON.stringify(legacy, null, 2), 'utf8')
    await rename(tmp, legacyPath)
  })
  if (!legacy?.execution || legacy.execution.status === 'done') return undefined
  if (legacy.execution.migratedTo !== sessionId) return undefined // someone else adopted it
  // Persist the adopted run into this session's own state file (per-session —
  // no cross-process race, which is why it stays outside the legacy lock).
  const adopted = normalizeState(legacy)
  await saveState(cwd, adopted, sessionId)
  return adopted
}

let versionNotified = false

export async function loadState(cwd: string, sessionId?: string): Promise<FlowState> {
  const parsed = await readRaw(stateFileFor(cwd, sessionId))
  if (parsed !== undefined) {
    // Format guard: no migration path yet — warn once when a file carries an
    // unknown version so a future format change is diagnosable, not silent.
    if (parsed.version !== undefined && parsed.version !== 1 && !versionNotified) {
      versionNotified = true
      warnState(
        `adx-flow: state file version ${String(parsed.version)} differs from the supported version 1 — loading without migration`,
      )
    }
    return normalizeState(parsed)
  }
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

async function withFileLock(lockPath: string, fn: () => Promise<void>): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true })
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

async function withStateLock(
  cwd: string,
  sessionId: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  await withFileLock(`${stateFileFor(cwd, sessionId)}.lock`, fn)
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
      const state = normalizeState(await readRaw(stateFileFor(cwd, sessionId), { locked: true }))
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
  // Highest existing numeric id + 1 (not length + 1) so removed items' ids are
  // never reused — references in nudges/reports stay unambiguous.
  const nextId = Math.max(0, ...current.map((e) => Number(e.id) || 0)) + 1
  const entry: MetaEntry = {
    id: String(nextId),
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
