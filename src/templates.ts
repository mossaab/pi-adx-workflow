/**
 * adx-workflow: template variables.
 *
 * Template resolution (resolveTemplate) + executor helpers
 * (formatCriteriaList / formatModifiedFiles).
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface TemplateContext {
  workdir: string
  reason: string
  /** @deprecated Use stepOutput.content instead */
  verifierFindings: string
  /** @deprecated Use stepOutput.stdout instead */
  previousStepOutput: string
  criteriaCount: number
  pendingCount: number
  criteriaList: string
  modifiedFiles: string
  /** Total line count of the project's source files (for proportional verification). */
  projectLines: number
  /** Number of the project's source files (for proportional verification). */
  projectFileCount: number
  stepOutput: Record<string, string>
  /** User-supplied parameters from workflow launch (e.g. /adx-run args) */
  params: Record<string, string>
}

const BUILT_IN_NAMES = [
  'workdir',
  'reason',
  'criteriaCount',
  'pendingCount',
  'criteriaList',
  'modifiedFiles',
  'projectLines',
  'projectFileCount',
] as const

/**
 * Format the criteria list with status markers:
 * formatCriteriaList: [PASSED], [NEEDS VERIFICATION], [FAILED], [NOT COMPLETED].
 */
export function formatCriteriaList(
  entries: Array<{ id: string; description: string; status?: string; [k: string]: unknown }>,
): string {
  if (entries.length === 0) return '(none)'
  return entries
    .map((e) => {
      const status =
        e.status === 'passed'
          ? '[PASSED]'
          : e.status === 'completed'
            ? '[NEEDS VERIFICATION]'
            : e.status === 'failed'
              ? '[FAILED]'
              : '[NOT COMPLETED]'
      return `- **${e.id}** ${status}: ${e.description}`
    })
    .join('\n')
}

/** List of files modified in the working tree (git diff, staged + unstaged). */
export function getModifiedFiles(workdir: string): string {
  try {
    const out = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: workdir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
    return out || '(no modifications)'
  } catch {
    return '(not a git repository)'
  }
}

// ============================================================================
// Project size / content hash (proportional verification + re-run short-circuit)
// ============================================================================

/** Directories never counted/hashed: VCS, deps, adx's own state, build output. */
const PROJECT_EXCLUDES = new Set([
  '.git',
  '.pi',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.svelte-kit',
  'coverage',
  '.DS_Store',
])
const MAX_PROJECT_FILES = 5000
const MAX_FILE_BYTES = 5 * 1024 * 1024

function collectProjectFiles(dir: string, out: string[], depth: number): void {
  if (depth > 8) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (PROJECT_EXCLUDES.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) collectProjectFiles(full, out, depth + 1)
    else if (e.isFile()) out.push(full)
  }
}

/**
 * Short-TTL cache for the sync project scans. Both functions walk up to
 * 5,000 files synchronously (blocking the event loop / TUI); the executor
 * calls projectStats on EVERY agent-step entry and projectHash on every
 * verifier re-entry. Within TTL_MS the cached value is reused — a sub-agent
 * run takes far longer than the TTL, so the verifier short-circuit hash is
 * always computed fresh, while repeated step entries seconds apart stop
 * re-scanning the whole tree.
 */
const SCAN_CACHE_TTL_MS = 5_000
let statsCache: { at: number; key: string; value: { lines: number; files: number } } | undefined
let hashCache: { at: number; key: string; value: string | undefined } | undefined

/**
 * Total line count + file count of the project's source files. Drives the
 * {{projectLines}} / {{projectFileCount}} template variables so verify prompts
 * can keep the effort proportional to the project size.
 */
export function projectStats(workdir: string): { lines: number; files: number } {
  const now = Date.now()
  if (statsCache && statsCache.key === workdir && now - statsCache.at < SCAN_CACHE_TTL_MS) {
    return statsCache.value
  }
  const files: string[] = []
  collectProjectFiles(workdir, files, 0)
  let lines = 0
  let count = 0
  for (const f of files) {
    if (count >= MAX_PROJECT_FILES) break
    try {
      if (statSync(f).size > MAX_FILE_BYTES) continue
      const buf = readFileSync(f)
      if (buf.subarray(0, 8192).includes(0)) continue // binary — not source
      lines += buf.toString('latin1').split('\n').length
      count += 1
    } catch {
      /* unreadable file — skip */
    }
  }
  const value = { lines, files: count }
  statsCache = { at: now, key: workdir, value }
  return value
}

/**
 * Stable content hash of the project's source files (path + bytes, sha256).
 * Used by the executor to skip an expensive verifier re-run when the code has
 * not changed since the last (successful) verification. Returns undefined if
 * the walk fails (the short-circuit is then simply not applied).
 */
export function projectHash(workdir: string): string | undefined {
  const now = Date.now()
  if (hashCache && hashCache.key === workdir && now - hashCache.at < SCAN_CACHE_TTL_MS) {
    return hashCache.value
  }
  let value: string | undefined
  try {
    const files: string[] = []
    collectProjectFiles(workdir, files, 0)
    files.sort()
    const h = createHash('sha256')
    let count = 0
    for (const f of files) {
      if (count >= MAX_PROJECT_FILES) break
      const rel = f.slice(workdir.length + 1)
      if (statSync(f).size > MAX_FILE_BYTES) continue
      h.update(rel)
      h.update('\0')
      h.update(readFileSync(f))
      count += 1
    }
    value = h.digest('hex')
  } catch {
    value = undefined
  }
  hashCache = { at: now, key: workdir, value }
  return value
}

export function resolveTemplate(template: string, ctx: TemplateContext): string {
  let result = template
  // Resolve built-in variables first
  for (const name of BUILT_IN_NAMES) {
    const value = String(ctx[name])
    result = result.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), value)
  }
  // Flat dotted keys: {{stepOutput.<key>}}
  result = result.replace(/\{\{stepOutput\.([\w.-]+)\}\}/g, (_, key) => ctx.stepOutput[key] ?? '')
  // Deprecated aliases
  result = result.replace(/\{\{verifierFindings\}\}/g, ctx.stepOutput['content'] ?? '')
  result = result.replace(/\{\{previousStepOutput\}\}/g, ctx.stepOutput['stdout'] ?? '')
  // Resolve user-supplied params (lower priority — can't override built-ins)
  for (const [key, value] of Object.entries(ctx.params)) {
    result = result.replaceAll(`{{${key}}}`, value)
  }
  return result
}
