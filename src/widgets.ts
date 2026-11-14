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
import { stateFileFor, legacyAdoptionEnabled, type FlowState } from './store.js'

const ADX_KEY = 'adx-flow' // single shared key (widget + status line) — was two identical constants

/** Read-only mode the footer badge advertises. */
export type ModeKind = 'plan' | 'auto' | 'spec'
/**
 * Footer mode badge, stored as a spec (mode + detail) rather than a
 * pre-cooked ANSI string, so it re-renders with the *current* theme on
 * every widget refresh — a mid-session theme switch leaves no stale colors.
 */
export interface ModeBadgeSpec {
  mode: ModeKind
  /** Rest of the badge line, e.g. "read-only · /adx-approve to exit". */
  detail: string
}
/**
 * Per-mode chip styling: theme token pair (foreground text + background
 * fill). The bg tokens are optional in user themes — a missing/empty token
 * degrades the chip to bold colored text (graceful, still distinct).
 */
const MODE_CHIP_STYLES: Record<ModeKind, { tag: string; fg: string; bg: string }> = {
  plan: { tag: '[PLAN]', fg: 'warning', bg: 'toolPendingBg' },
  auto: { tag: '[AUTO]', fg: 'accent', bg: 'selectedBg' },
  spec: { tag: '[SPEC]', fg: 'success', bg: 'toolSuccessBg' },
}
/** Current mode badge shown in the footer (set by the extension on mode changes). */
let modeBadge: ModeBadgeSpec | undefined

/** Spinner frames for the sub-agent activity widget. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
/** How often the activity widget re-reads the shared store for live criteria
 *  statuses + the display-only "progress" feed (child writes it via flow_meta). */
const STATE_REFRESH_MS = 2_000
/** Collapse the per-criterion list into a single summary line past this count. */
const MAX_CRITERIA_LINES = 8
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

function readRaw(path: string): FlowState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<FlowState>
    return {
      version: 1,
      metadata: parsed.metadata ?? {},
      execution: parsed.execution ?? null,
      planMode: parsed.planMode ?? false,
    }
  } catch {
    return undefined
  }
}

/**
 * Read the widget-relevant state for a session.
 * - parent session: the per-session file `<cwd>/.pi/adx-flow/state/<sid>.json`;
 *   if it doesn't exist yet (new session), fall back to the legacy shared file
 *   when it holds an in-flight run (mirrors the store's one-time adoption);
 * - flow children (ADX_CHILD=1): the parent's file via ADX_FLOW_STATE.
 */
function readState(cwd: string, sessionId?: string): FlowState | undefined {
  const state = readRaw(stateFileFor(cwd, sessionId))
  if (state) return state
  if (sessionId && process.env.ADX_CHILD !== '1' && legacyAdoptionEnabled()) {
    const legacy = readRaw(join(cwd, '.pi', 'adx-flow', 'state.json'))
    if (legacy?.execution && legacy.execution.status !== 'done' && !legacy.execution.migratedTo) {
      return legacy
    }
  }
  return undefined
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

/** Minimal theme surface used for footer styling (full Theme in the TUI,
 *  PLAIN_THEME fallback elsewhere). `bg` is optional: test fakes and
 *  older contexts may lack it. */
interface ThemeLike {
  // `any` color: the real Theme takes a ThemeColor token union, the plain
  // fallback takes anything — `any` keeps both assignable.
  fg: (color: any, text: string) => string
  bold: (text: string) => string
  strikethrough: (text: string) => string
  bg?: (color: any, text: string) => string
}
/** Theme fallback for contexts without `ui.theme` (non-interactive modes, tests). */
const PLAIN_THEME: ThemeLike = {
  fg: (_color, text) => text,
  bold: (text) => text,
  strikethrough: (text) => text,
  bg: (_color, text) => text,
}
/** Current theme, or the plain-text fallback. */
function themeFor(ui: { theme?: ThemeLike }): ThemeLike {
  return ui.theme ?? PLAIN_THEME
}
/**
 * Render the footer mode badge: a themed chip (bold colored tag on a
 * background fill, per mode) + muted detail text. Plain text when the
 * theme is absent. The literal tag ([PLAN]/[AUTO]/[SPEC]) is preserved
 * around the ANSI codes (e2e checks rely on it).
 */
function renderModeBadge(theme: ThemeLike, spec: ModeBadgeSpec): string {
  const s = MODE_CHIP_STYLES[spec.mode]
  const inner = ` ${theme.fg(s.fg, theme.bold(s.tag))} `
  const chip = theme.bg ? theme.bg(s.bg, inner) : inner
  return `adx: ${chip}${spec.detail ? ` ${theme.fg('muted', spec.detail)}` : ''}`
}

/** Render the adx-flow widget (criteria + step) or clear it when idle. */
export function refreshFlowWidget(ctx: ExtensionContext, sessionId?: string): void {
  const state = readState(ctx.cwd, sessionId)
  const ui = ctx.ui
  const theme = themeFor(ui)

  if (!state || (!state.execution && Object.keys(state.metadata).length === 0)) {
    ui.setWidget(ADX_KEY, undefined)
    ui.setStatus(ADX_KEY, modeBadge ? renderModeBadge(theme, modeBadge) : undefined)
    return
  }

  const lines: string[] = []

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

  ui.setWidget(ADX_KEY, lines)

  // Footer status line (compact, theme-styled)
  if (state.execution) {
    const passed = criteria.filter((c) => c.status === 'passed').length
    const name = theme.fg('accent', state.execution.workflowName)
    const footer =
      state.execution.status === 'done'
        ? `${theme.fg('success', '✅')} adx: ${name} ${theme.fg('muted', 'done')}`
        : `adx: ${name} ${theme.fg('muted', `· ${state.execution.currentStep} · ${passed}/${criteria.length || 0} criteria`)}`
    ui.setStatus(ADX_KEY, footer)
  } else if (modeBadge) {
    ui.setStatus(ADX_KEY, renderModeBadge(theme, modeBadge))
  } else {
    ui.setStatus(ADX_KEY, undefined)
  }
}

/**
 * Set (or clear) the footer mode badge, e.g. the `[PLAN]` chip +
 * "read-only · /adx-approve to exit". The spec is stored and re-rendered
 * with the current theme on every refresh (theme switches stay in sync).
 * The badge survives widget refreshes while no workflow is running; an
 * active workflow's status line takes precedence over it (a finished run
 * does not block the badge).
 */
export function setModeBadge(ctx: ExtensionContext, badge: ModeBadgeSpec | undefined, sessionId?: string): void {
  modeBadge = badge
  const state = readState(ctx.cwd, sessionId)
  const active =
    state?.execution != null && state.execution.status !== 'done'
  if (badge === undefined) {
    if (!active) ctx.ui.setStatus(ADX_KEY, undefined)
    return
  }
  if (!active) ctx.ui.setStatus(ADX_KEY, renderModeBadge(themeFor(ctx.ui), badge))
}

/** Clear the widget + status (e.g. on /adx-cancel). */
export function clearFlowWidget(ctx: ExtensionContext, sessionId?: string): void {
  void sessionId // widget keys are TUI-scoped; parameter kept for call-site symmetry
  modeBadge = undefined
  ctx.ui.setWidget(ADX_KEY, undefined)
  ctx.ui.setStatus(ADX_KEY, undefined)
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
 *
 * While the child runs, the widget stays live:
 * - criteria checklist updates as the child flips statuses via flow_meta
 *   (✅ passed / ❌ failed / ⏳ completed-pending-verification);
 * - a "what is it doing now" line shows the latest display-only progress
 *   note the child logged under the "progress" metadata key.
 */
export function setSubAgentActivity(
  ctx: ExtensionContext,
  activity: SubAgentActivity,
  sessionId?: string,
): void {
  const ui = ctx.ui
  const taskOneLine = truncate(
    activity.task.replace(/\s+/g, ' ').trim(),
    110,
  )

  ui.setWidget(ADX_KEY, (tui, theme) => {
    const t = theme ?? PLAIN_THEME
    let frame = 0
    let disposed = false
    let liveState: FlowState | undefined
    let lastStateReadAt = 0
    const timer = setInterval(() => {
      frame = (frame + 1) % SPINNER_FRAMES.length
      tui.requestRender()
    }, SPINNER_INTERVAL_MS)

    return {
      render(): string[] {
        const now = Date.now()
        // Throttled re-read of the shared store: the child updates criteria
        // statuses (and the display-only "progress" feed) via flow_meta while
        // it works, so the widget stays live without re-reading every frame.
        if (now - lastStateReadAt >= STATE_REFRESH_MS) {
          lastStateReadAt = now
          liveState = readState(ctx.cwd, sessionId)
        }
        const spin = t.fg('accent', SPINNER_FRAMES[frame] ?? '●')
        const head =
          spin +
          ' ' +
          t.fg('accent', activity.agent) +
          ' — ' +
          t.fg('muted', `"${activity.step}"`) +
          ' · ' +
          t.fg('muted', formatElapsed(now - activity.startedAt))
        const lines: string[] = [head]
        if (taskOneLine) lines.push('  ' + t.fg('muted', taskOneLine))
        // "What is it doing now" — latest display-only progress note.
        const progress = liveState?.metadata['progress']
        if (progress && progress.length > 0) {
          const latest = progress[progress.length - 1]
          if (latest)
            lines.push('  ' + t.fg('warning', `▸ ${truncate(latest.description, 100)}`))
        }
        // Live criteria checklist (icons flip as the child verifies).
        const criteria = liveState?.metadata['criteria'] ?? []
        if (criteria.length > 0) {
          const passed = criteria.filter((c) => c.status === 'passed').length
          const failed = criteria.filter((c) => c.status === 'failed').length
          if (criteria.length <= MAX_CRITERIA_LINES) {
            for (const c of criteria) {
              const icon = STATUS_ICON[c.status] ?? '☐'
              const body = truncate(c.description, 52)
              lines.push(`  ${icon} ${t.fg('muted', `${c.id} ${body}`)}`)
            }
          }
          lines.push(
            '  ' +
              t.fg(
                passed === criteria.length ? 'success' : 'muted',
                `criteria: ${passed}/${criteria.length} passed` +
                  (failed > 0 ? ` · ${failed} failed` : ''),
              ),
          )
        }
        return lines
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
    ADX_KEY,
    `adx: ${themeFor(ui).fg('accent', activity.agent)} ${themeFor(ui).fg('muted', `· "${activity.step}" running…`)}`,
  )
}
