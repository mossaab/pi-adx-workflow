/**
 * adx-workflow: TUI widgets.
 *
 * - Criteria checklist with status icons (✅ passed · ⏳ completed/needs
 *   verification · ❌ failed · ☐ pending)
 * - Current step + phase + iteration counter
 * - Open findings counter
 * - Footer status line
 *
 * User-step choice prompts are handled by the executor via ctx.ui.select
 * (choices derived from step_result transitions + "Continue").
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { FlowState } from './store.js'

const WIDGET_KEY = 'adx-flow'
const STATUS_KEY = 'adx-flow'

/** Spinner frames for the sub-agent activity widget. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_INTERVAL_MS = 120

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h${m}m`
  if (m > 0) return `${m}m${s}s`
  return `${s}s`
}

function readState(cwd: string): FlowState | undefined {
  try {
    const raw = readFileSync(join(cwd, '.pi', 'adx-flow', 'state.json'), 'utf8')
    return JSON.parse(raw) as FlowState
  } catch {
    return undefined
  }
}

const STATUS_ICON: Record<string, string> = {
  passed: '✅',
  completed: '⏳',
  failed: '❌',
  pending: '☐',
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/** Theme fallback for contexts without `ui.theme` (non-interactive modes, tests). */
const PLAIN_THEME = {
  fg: (_color: string, text: string): string => text,
  bold: (text: string): string => text,
  strikethrough: (text: string): string => text,
}

/** Render the adx-flow widget (criteria + step) or clear it when idle. */
export function refreshFlowWidget(ctx: ExtensionContext): void {
  const state = readState(ctx.cwd)
  const ui = ctx.ui

  if (!state || (!state.execution && Object.keys(state.metadata).length === 0)) {
    ui.setWidget(WIDGET_KEY, undefined)
    ui.setStatus(STATUS_KEY, undefined)
    return
  }

  const lines: string[] = []
  const theme = ui.theme ?? PLAIN_THEME

  // Header: workflow + step + iteration
  if (state.execution) {
    const exec = state.execution
    const statusIcon =
      exec.status === 'running'
        ? theme.fg('accent', '▶')
        : exec.status === 'waiting'
          ? theme.fg('warning', '⏸')
          : exec.status === 'blocked'
            ? theme.fg('warning', '⛔')
            : theme.fg('success', '✅')
    lines.push(
      statusIcon +
        ' ' +
        theme.fg('accent', exec.workflowName) +
        ' — ' +
        theme.fg('muted', `"${exec.currentStep}" (iter ${exec.iteration})`) +
        (exec.status !== 'running' && exec.status !== 'done' ? theme.fg('muted', ` [${exec.status}]`) : ''),
    )
  }

  // Criteria checklist
  const criteria = state.metadata['criteria'] ?? []
  if (criteria.length > 0) {
    for (const c of criteria) {
      const icon = STATUS_ICON[c.status] ?? '☐'
      const text = truncate(c.description, 60)
      const body =
        c.status === 'passed'
          ? theme.strikethrough(text)
          : text
      lines.push(`  ${icon} ${theme.fg('muted', c.id)} ${body}`)
    }
  }

  // Open findings
  const findings = state.metadata['review_findings'] ?? []
  const open = findings.filter((f) => f.status === 'open')
  if (open.length > 0) {
    lines.push(
      '  ' + theme.fg('warning', `⚠ ${open.length} open review finding${open.length > 1 ? 's' : ''}`),
    )
  }

  ui.setWidget(WIDGET_KEY, lines)

  // Footer status line (compact)
  if (state.execution) {
    const passed = criteria.filter((c) => c.status === 'passed').length
    const footer =
      state.execution.status === 'done'
        ? `✅ adx: ${state.execution.workflowName} done`
        : `adx: ${state.execution.workflowName} · ${state.execution.currentStep} · ${passed}/${criteria.length || 0} criteria`
    ui.setStatus(STATUS_KEY, footer)
  } else {
    ui.setStatus(STATUS_KEY, undefined)
  }
}

/** Clear the widget + status (e.g. on /adx-cancel). */
export function clearFlowWidget(ctx: ExtensionContext): void {
  ctx.ui.setWidget(WIDGET_KEY, undefined)
  ctx.ui.setStatus(STATUS_KEY, undefined)
}

// ============================================================================
// Sub-agent activity widget (animated)
//
// While a sub_agent step (verifier / code reviewer, …) is running, the parent
// session is idle and the static criteria widget looks dead for minutes.
// `setSubAgentActivity` swaps the widget for an animated component: a spinning
// indicator + agent/step name + live elapsed time + a one-line task summary.
// The TUI only re-renders on invalidation, so the component drives itself with
// a timer that advances the spinner frame and requests a render; `dispose()`
// (called by the TUI when the widget is replaced or cleared) stops it.
// ============================================================================

export interface SubAgentActivity {
  /** Sub-agent name, e.g. "adx-code-reviewer". */
  agent: string
  /** Workflow step name, e.g. "Code Review". */
  step: string
  /** Task prompt sent to the child (flattened + truncated for display). */
  task: string
  startedAt: number
}

/**
 * Show the animated sub-agent activity widget (replaces the static
 * criteria/step widget on the same key). Call `refreshFlowWidget` (or
 * `clearFlowWidget`) when the child finishes to restore the static widget.
 */
export function setSubAgentActivity(ctx: ExtensionContext, activity: SubAgentActivity): void {
  const ui = ctx.ui
  const taskOneLine = truncate(
    activity.task.replace(/\s+/g, ' ').trim(),
    110,
  )

  ui.setWidget(WIDGET_KEY, (tui, theme) => {
    const t = theme ?? PLAIN_THEME
    let frame = 0
    let disposed = false
    const timer = setInterval(() => {
      frame = (frame + 1) % SPINNER_FRAMES.length
      tui.requestRender()
    }, SPINNER_INTERVAL_MS)

    return {
      render(): string[] {
        const spin = t.fg('accent', SPINNER_FRAMES[frame] ?? '●')
        const head =
          spin +
          ' ' +
          t.fg('accent', activity.agent) +
          ' — ' +
          t.fg('muted', `"${activity.step}"`) +
          ' · ' +
          t.fg('muted', formatElapsed(Date.now() - activity.startedAt))
        if (!taskOneLine) return [head]
        return [head, '  ' + t.fg('muted', taskOneLine)]
      },
      // No cached render state (theme is applied per render); nothing to reset.
      invalidate(): void {},
      dispose(): void {
        if (disposed) return
        disposed = true
        clearInterval(timer)
      },
    }
  })

  ui.setStatus(
    STATUS_KEY,
    `adx: ${activity.agent} · "${activity.step}" running…`,
  )
}
