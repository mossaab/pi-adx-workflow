/**
 * adx-workflow: plan ↔ build modes.
 *
 * Mode model (mode = agent definition: system prompt + tool
 * allowlist) onto pi primitives:
 * - plan mode  = read-only tool set + bash allowlist + planner prompt section
 * - build mode = full tool set + builder prompt section
 *
 * Mode switches are EXTERNAL (commands / shortcut) — the planner never asks
 * "may I switch?"; only the user (or a workflow) does.
 */
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

// ============================================================================
// Tool gating (port of examples/extensions/plan-mode)
// ============================================================================

export const PLAN_MODE_DISABLED_TOOLS = new Set<string>(['edit', 'write'])
/** Tools that stay available (or come back) in plan mode */
export const PLAN_MODE_TOOLS = ['read', 'bash', 'grep', 'find', 'ls']

export function getPlanModeTools(activeToolNames: string[]): string[] {
  return [
    ...new Set(
      [
        ...activeToolNames.filter((n) => !PLAN_MODE_DISABLED_TOOLS.has(n)),
        ...PLAN_MODE_TOOLS,
      ],
    ),
  ]
}

export function getBuildModeTools(restoredTools: string[]): string[] {
  return [...new Set(restoredTools)]
}

// ============================================================================
// Read-only bash allowlist (port of plan-mode/utils.ts isSafeCommand)
// ============================================================================

const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
]

const SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
  /^\s*curl\s/i,
  /^\s*wget\s+-O\s*-/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
]

export function isSafeCommand(command: string): boolean {
  const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command))
  const isSafe = SAFE_PATTERNS.some((p) => p.test(command))
  return !isDestructive && isSafe
}

/**
 * Extract the bash command from a bash tool call's args (pi's bash tool takes
 * a `command` string).
 */
export function bashCommandFromArgs(args: Record<string, unknown>): string {
  return typeof args?.command === 'string' ? args.command : ''
}

// ============================================================================
// Prompt sections (planner/builder agent definitions)
// ============================================================================

export const PLANNER_PROMPT_SECTION = `
# Plan Mode (adx-workflow)

CRITICAL: Plan mode ACTIVE - you are in a read-only phase.

You may only inspect, analyze, ask clarifying questions, and propose, refine and/or add acceptance criteria via the flow_meta tool (key "criteria").
You MUST NOT make any edits, implementations, commits, config changes, or other system modifications.

## Responsibility

- Understand the user's goal before locking in details.
- Explore the codebase with read-only actions when needed.
- Add each acceptance criterion with flow_meta (action "add", key "criteria"): a self-contained, verifiable description of what needs to be done AND how to verify it.
- Present the criteria plainly and stop there.
- Never ask "Do you approve these criteria and shall I switch to build?" — mode changes are driven externally by the user (/adx-build), not by your question.
- Do not call flow_step_done in plan mode; it is only used inside a running workflow step.
- If you must stop mid-step (for example context pressure), first record where you stopped and the exact next action with flow_meta (action "add", key "resume", description "..."), then stop. You will be auto-continued with that note.
`

export const BUILDER_PROMPT_SECTION = `
# Build Mode (adx-workflow)

CRITICAL: Build mode ACTIVE - implementation is now allowed.

You are no longer in read-only mode.
You may read files, edit files, run commands, and use tools as needed to satisfy the approved criteria.

## Responsibility

- Execute the approved work with focused changes.
- Follow TDD when fixing or refactoring: write or update the failing test first, then make it pass.
- Verify changes as you go.
- Finish criteria systematically instead of replanning from scratch.
- Mark each criterion as complete with flow_meta (key "criteria", action "update", status "completed"). Do NOT set status "passed" — that status is set by the verifier, not by you.
- When the current workflow step prompt is fully satisfied, call flow_step_done.
- **Never leave a step half-finished.** If you must stop mid-step (for example context pressure), first record where you stopped and the exact next action with flow_meta (action "add", key "resume", description "..."), then stop. The workflow auto-continues you with that note — do not ask the user to press continue.
`

/**
 * Guard bash tool calls while in plan mode: block non-read-only commands.
 * Returns an error message to inject, or undefined when allowed.
 */
export function planModeBashGuard(
  args: Record<string, unknown>,
  notify: (msg: string) => void,
): string | undefined {
  const command = bashCommandFromArgs(args)
  if (!command) return undefined
  if (!isSafeCommand(command)) {
    const msg = `Plan mode is read-only: bash command not on the read-only allowlist: ${command.slice(0, 120)}`
    notify(msg)
    return msg
  }
  return undefined
}

/** Convenience: apply the plan-mode tool set from an ExtensionContext's active tools. */
export function activatePlanModeTools(activeTools: string[]): string[] {
  return getPlanModeTools(activeTools)
}

export type { ExtensionContext }
