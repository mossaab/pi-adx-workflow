/**
 * adx-workflow: user/project configuration.
 *
 * Precedence (project > user):
 * 1. `<cwd>/.pi/adx-workflow.json`    (project)
 * 2. `~/.pi/agent/adx-workflow.json`  (user)
 *
 * All keys are optional; missing keys keep the built-in defaults. Unknown keys
 * are ignored (forward compatibility).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface AdxConfig {
  /** Enter plan mode automatically at session start (default: false) */
  defaultPlanMode?: boolean
  /** Show the bottom flow/criteria widget (default: true) */
  showWidget?: boolean
  /** Unattended pipeline, same as the `--adx-auto` CLI flag (default: false).
   *  The CLI flag wins when passed. */
  autoMode?: boolean
  /** Default `skip_review=true` when launching the build-verify pipeline
   *  (picker + /adx-run build-verify), unless the caller already set it
   *  (default: false) */
  skipReview?: boolean
  /** Workflow launched by /adx-run (default: "build") */
  defaultBuildWorkflow?: 'build' | 'build-verify'
}

function readConfigFile(path: string): AdxConfig {
  try {
    if (!existsSync(path)) return {}
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as AdxConfig) : {}
  } catch {
    // Malformed config must never break the extension: fall back to defaults.
    return {}
  }
}

export function loadConfig(cwd: string): AdxConfig {
  const user = readConfigFile(join(homedir(), '.pi', 'agent', 'adx-workflow.json'))
  const project = readConfigFile(join(cwd, '.pi', 'adx-workflow.json'))
  return { ...user, ...project }
}

// ============================================================================
// Paths + dynamic management (auto-create on first run, /adx-config set …)
// ============================================================================

export const DEFAULT_CONFIG: Required<AdxConfig> = {
  defaultPlanMode: false,
  showWidget: true,
  autoMode: false,
  skipReview: false,
  defaultBuildWorkflow: 'build',
}

export function userConfigPath(): string {
  return join(homedir(), '.pi', 'agent', 'adx-workflow.json')
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, '.pi', 'adx-workflow.json')
}

/**
 * First-run: create the user config file with the defaults so the user has a
 * ready-to-edit file. Returns the created path, or undefined (already exists /
 * write failed). Project files are never auto-created (repo pollution).
 */
export function ensureUserConfig(): string | undefined {
  const path = userConfigPath()
  if (existsSync(path)) return undefined
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`)
    return path
  } catch {
    return undefined
  }
}

/** Update one key in the user (default) or project config file. */
export function setConfigValue(
  cwd: string,
  key: keyof AdxConfig,
  value: unknown,
  scope: 'user' | 'project' = 'user',
): AdxConfig {
  const path = scope === 'project' ? projectConfigPath(cwd) : userConfigPath()
  let current: AdxConfig = {}
  if (existsSync(path)) current = readConfigFile(path)
  ;(current as Record<string, unknown>)[key] = value
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`)
  } catch {
    /* read-only fs: the in-memory value still applies for this session */
  }
  return { ...DEFAULT_CONFIG, ...current } as AdxConfig
}
