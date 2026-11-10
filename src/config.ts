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

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AdxConfig {
  /** Enter plan mode automatically at session start (default: false) */
  defaultPlanMode?: boolean
  /** Show the bottom flow/criteria widget (default: true) */
  showWidget?: boolean
  /** Unattended pipeline, same as the `--adx-auto` CLI flag (default: false).
   *  The CLI flag wins when passed. */
  autoMode?: boolean
  /** Default `skip_review=true` when launching the build-verify pipeline
   *  (picker + /adx-build-verify), unless the caller already set it
   *  (default: false) */
  skipReview?: boolean
  /** Workflow launched by /adx-build (default: "build") */
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
