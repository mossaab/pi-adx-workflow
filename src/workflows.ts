/**
 * adx-workflow: workflow loading.
 *
 * Precedence (project > user > default):
 * 1. `<cwd>/.pi/adx-workflows/{id}.workflow.json`  (project)
 * 2. `~/.pi/agent/workflows/{id}.workflow.json`    (user)
 * 3. Bundled `workflows/{id}.workflow.json` shipped with the extension
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkflowDefinition } from './types.js'

/**
 * Bundled workflows live in <extension>/workflows (one up from src/).
 * `import.meta.url` is available under pi's jiti loader (same precedent as
 * subagent.ts) — resolve from this module's own location, never from cwd.
 */
function bundledWorkflowsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows')
}

function readWorkflowFile(path: string): WorkflowDefinition | undefined {
  try {
    const raw = readFileSync(path, 'utf8')
    const def = JSON.parse(raw) as WorkflowDefinition
    // Minimum validity: id set + non-empty steps
    if (!def?.metadata?.id || !Array.isArray(def.steps) || def.steps.length === 0) {
      return undefined
    }
    return def
  } catch {
    return undefined
  }
}

export function loadWorkflow(cwd: string, workflowId: string): WorkflowDefinition | undefined {
  const candidates: string[] = []

  // 1. project
  const projectDir = join(cwd, '.pi', 'adx-workflows')
  if (existsSync(projectDir)) {
    for (const f of readdirSync(projectDir)) {
      if (f.endsWith('.workflow.json')) candidates.push(join(projectDir, f))
    }
  }

  // 2. user
  const userDir = join(homedir(), '.pi', 'agent', 'workflows')
  if (existsSync(userDir)) {
    for (const f of readdirSync(userDir)) {
      if (f.endsWith('.workflow.json')) candidates.push(join(userDir, f))
    }
  }

  // 3. bundled (lowest precedence)
  const bundled = bundledWorkflowsDir()
  if (existsSync(bundled)) {
    for (const f of readdirSync(bundled)) {
      if (f.endsWith('.workflow.json')) candidates.push(join(bundled, f))
    }
  }

  // Later entries (higher precedence) override earlier ones by metadata.id
  let found: WorkflowDefinition | undefined
  for (const candidate of candidates) {
    const def = readWorkflowFile(candidate)
    if (def && def.metadata.id === workflowId) found = def
  }
  return found
}

/** Parse "key=value key2=value2" launch args into a params record. */
export function parseLaunchParams(rawArgs?: string): Record<string, string> {
  const params: Record<string, string> = {}
  if (!rawArgs) return params
  for (const token of rawArgs.trim().split(/\s+/)) {
    const eq = token.indexOf('=')
    if (eq > 0) {
      params[token.slice(0, eq)] = token.slice(eq + 1)
    }
  }
  return params
}
