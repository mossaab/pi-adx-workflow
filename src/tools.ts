/**
 * adx-workflow: custom tools (flow_meta + flow_step_done).
 *
 * Tool definition objects, registered by index.ts via pi.registerTool().
 * - flow_meta: shared workflow metadata store (criteria/todos/review_findings).
 * - flow_step_done: the agent-step "step_done()" — ends the current step turn;
 *   the executor (via the onStepDone callback) evaluates transitions and
 *   injects the next prompt / nudge / sub-agent spawn.
 */

import { Type } from 'typebox'
import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import {
  META_SCHEMAS,
  loadState,
  metaAdd,
  metaRemove,
  metaUpdate,
  mutateState,
  normalizeId,
} from './store.js'
import { composeSpecMarkdown, defaultSpecPath, resolveSpecPath, specPathError, writeSpecFile } from './spec.js'
import type { FlowState, MetaEntry } from './store.js'
/** Cap for the display-only "progress" feed (widget shows only the latest). */
const PROGRESS_CAP = 20

// ============================================================================
// flow_meta
// ============================================================================

export function createFlowMetaTool(onChange?: () => void) {
  return {
    name: 'flow_meta',
    label: 'Flow Metadata',
    description:
      'Manage structured workflow data (acceptance criteria, todos, review findings). ' +
      'Each key holds items with id (auto), description, and status. ' +
      'Known keys: criteria, todos, review_findings, resume (auto-continue notes), progress (display-only live feed). ' +
      'Writes are atomic (cross-process lock); for multi-item writes prefer the batch actions ' +
      '(add_batch with descriptions / update_batch with items) over parallel single-item calls. ' +
      'Use action=schema to see the expected shape for a key.',
    promptSnippet:
      'Manage workflow acceptance criteria, todos, and review findings (structured session data)',
    promptGuidelines: [
      'Use flow_meta with key "criteria" to add/update acceptance criteria; only set status "completed" when the work is done — "passed"/"failed" are set by the verifier, not by you.',
      'Use flow_meta with key "review_findings" to resolve or dismiss code review findings.',
    ],
    parameters: Type.Object({
      action: StringEnum([
        'get',
        'list',
        'add',
        'add_batch',
        'update',
        'update_batch',
        'remove',
        'schema',
      ] as const),
      key: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      descriptions: Type.Optional(
        Type.Array(Type.String(), {
          description: 'For add_batch: descriptions to add atomically in one write',
        }),
      ),
      items: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String(),
            description: Type.Optional(Type.String()),
            status: Type.Optional(Type.String()),
          }),
          {
            description: 'For update_batch: items to update atomically in one write',
          },
        ),
      ),
    }),

    async execute(
      _toolCallId: string,
      args: {
        action: string
        key?: string
        id?: string
        description?: string
        status?: string
        descriptions?: string[]
        items?: Array<{ id: string; description?: string; status?: string }>
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: {
        cwd: string
        sessionManager?: { getSessionId?(): string | undefined }
      },
    ) {
      const sessionId = ctx.sessionManager?.getSessionId?.()
      const state: FlowState = await loadState(ctx.cwd, sessionId)
      const entries = state.metadata

      const ok = (text: string) => ({
        content: [{ type: 'text' as const, text }],
        details: {},
      })
      const fail = (text: string) => ({
        content: [{ type: 'text' as const, text }],
        details: {},
        isError: true,
      })

      switch (args.action) {
        case 'list': {
          const keys = Object.keys(entries)
          if (keys.length === 0) return ok('No metadata keys defined.')
          return ok(
            `Metadata keys:\n${keys
              .map((k) => `- ${k} (${entries[k]?.length ?? 0} items)`)
              .join('\n')}`,
          )
        }

        case 'schema': {
          if (!args.key) return fail('Missing required field: key')
          const schema = META_SCHEMAS[args.key]
          if (!schema)
            return ok(
              `No schema defined for key "${args.key}". Items have id, description, and status fields.`,
            )
          return ok(
            `Key: ${args.key}\nDescription: ${schema.description}\nFields:\n${Object.entries(
              schema.fields,
            )
              .map(([f, t]) => `  ${f}: ${t}`)
              .join('\n')}`,
          )
        }

        case 'get': {
          if (!args.key) return fail('Missing required field: key')
          const keyEntries = entries[args.key]
          if (!keyEntries || keyEntries.length === 0)
            return ok(`No entries for key "${args.key}".`)
          return ok(JSON.stringify(keyEntries, null, 2))
        }

        case 'add': {
          if (!args.key) return fail('Missing required field: key')
          if (!args.description) return fail('Missing required field: description')
          // Atomic read-modify-write: parallel adds (e.g. the planner firing
          // 11 adds in one turn) must not lose writes to a last-write-wins race.
          let entry: MetaEntry | undefined
          let total = 0
          await mutateState(ctx.cwd, sessionId, (state) => {
            entry = metaAdd(state, args.key!, args.description!, args.status)
            // Cap the display-only progress feed so it cannot grow unbounded
            // across long runs (the widget only ever shows the latest entry).
            if (args.key === 'progress') {
              const all = state.metadata['progress']!
              if (all.length > PROGRESS_CAP) state.metadata['progress'] = all.slice(-PROGRESS_CAP)
            }
            total = state.metadata[args.key!]!.length
          })
          onChange?.()
          return ok(
            `Added item "${entry!.id}" to "${args.key}". Total: ${total} items.`,
          )
        }

        case 'add_batch': {
          if (!args.key) return fail('Missing required field: key')
          if (!args.descriptions || args.descriptions.length === 0)
            return fail('Missing required field: descriptions (non-empty array)')
          let added = 0
          let total = 0
          await mutateState(ctx.cwd, sessionId, (state) => {
            for (const d of args.descriptions!) {
              if (!d) continue
              metaAdd(state, args.key!, d, args.status)
              added += 1
            }
            if (args.key === 'progress') {
              const all = state.metadata['progress']!
              if (all.length > PROGRESS_CAP) state.metadata['progress'] = all.slice(-PROGRESS_CAP)
            }
            total = state.metadata[args.key!]!.length
          })
          onChange?.()
          return ok(`Added ${added} items to "${args.key}" atomically. Total: ${total} items.`)
        }

        case 'update': {
          if (!args.key) return fail('Missing required field: key')
          const id = normalizeId(args.id)
          if (id === undefined) return fail('Missing required field: id')
          let updated: MetaEntry | undefined
          await mutateState(ctx.cwd, sessionId, (state) => {
            updated = metaUpdate(state, args.key!, id, {
              ...(args.description !== undefined ? { description: args.description } : {}),
              ...(args.status !== undefined ? { status: args.status } : {}),
            })
          })
          if (!updated) return fail(`Item "${id}" not found in "${args.key}".`)
          onChange?.()
          return ok(`Updated item "${id}" in "${args.key}".`)
        }

        case 'update_batch': {
          if (!args.key) return fail('Missing required field: key')
          if (!args.items || args.items.length === 0)
            return fail('Missing required field: items (non-empty array of {id, description?, status?})')
          const updatedIds: string[] = []
          const missing: string[] = []
          await mutateState(ctx.cwd, sessionId, (state) => {
            for (const item of args.items!) {
              const id = normalizeId(item.id)
              if (id === undefined) {
                missing.push(String(item.id))
                continue
              }
              const updated = metaUpdate(state, args.key!, id, {
                ...(item.description !== undefined ? { description: item.description } : {}),
                ...(item.status !== undefined ? { status: item.status } : {}),
              })
              if (updated) updatedIds.push(id)
              else missing.push(id)
            }
          })
          if (updatedIds.length === 0)
            return fail(`None of the items were found in "${args.key}": ${missing.join(', ')}.`)
          onChange?.()
          return ok(
            `Updated ${updatedIds.length} items in "${args.key}" atomically.` +
              (missing.length > 0 ? ` (not found: ${missing.join(', ')})` : ''),
          )
        }

        case 'remove': {
          if (!args.key) return fail('Missing required field: key')
          const id = normalizeId(args.id)
          if (id === undefined) return fail('Missing required field: id')
          let removed = false
          let remaining = 0
          await mutateState(ctx.cwd, sessionId, (state) => {
            removed = metaRemove(state, args.key!, id)
            remaining = (state.metadata[args.key!] ?? []).length
          })
          if (!removed) return fail(`Item "${id}" not found in "${args.key}".`)
          onChange?.()
          return ok(`Removed item "${id}" from "${args.key}". ${remaining} items remaining.`)
        }

        default:
          return fail(`Unknown action "${args.action}"`)
      }
    },
  }
}

// ============================================================================
// flow_step_done
// ============================================================================

export interface StepDoneInfo {
  /** Result string for step_result transitions (default "completed") */
  result?: string
  /** Free-form content captured into {{stepOutput.content}} */
  content?: string
}

export interface FlowPlanDoneDeps {
  /** Whether the unattended auto pipeline is active (--adx-auto / autoMode). */
  autoMode: () => boolean
  /** Launch a workflow (bound to the current session's ctx). */
  launch: (workflow: 'build' | 'build-verify', args: string) => Promise<void>
  /** Apply the config's skipReview default to launch args. */
  withConfigDefaults: (rawArgs: string) => string
  /** Exit plan mode (restore build tools, clear badge) + notify. */
  exitPlanMode: () => void
  /**
   * "Spec only — stop": compose a spec markdown from the stored criteria,
   * write it to the default .pi/specs/<slug>.md, return the written path.
   * No workflow is launched.
   */
  specOnly: () => Promise<string>
  notify: (msg: string, level?: 'info' | 'warning' | 'error') => void
}

export function createFlowPlanDoneTool(deps: FlowPlanDoneDeps) {
  return {
    name: 'flow_plan_done',
    label: 'Plan Done',
    description:
      'Signal that planning is complete: every final acceptance criterion has been added with flow_meta (key "criteria"). ' +
      'In auto mode the workflow continues automatically to build; in interactive mode the user is offered a picker ' +
      '(build + verify / build simple / choose workspace / spec only — stop, which exports the criteria as a spec file and launches nothing). ' +
      'Without a dialog UI (print/json modes) plan mode stays on and the turn ends — start the pipeline with /adx-build or /adx-build-verify. ' +
      'Call it once, after the complete criteria recap is presented.',
    promptSnippet: 'Mark planning complete so the workflow can continue to build',
    promptGuidelines: [
      'Call flow_plan_done only after all final acceptance criteria are added with flow_meta (key "criteria").',
    ],
    parameters: Type.Object({}),
    async execute(
      _toolCallId: string,
      _args: Record<string, never>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ) {
      if (deps.autoMode()) {
        // Unattended pipeline: straight into build-verify, no dialogs.
        deps.exitPlanMode()
        deps.notify('adx: auto mode — planning complete, launching build-verify (no review)', 'info')
        await deps.launch('build-verify', 'auto=true skip_review=true')
        return {
          content: [
            { type: 'text' as const, text: 'Planning complete. Auto pipeline: build-verify launched.' },
          ],
          details: {},
        }
      }
      // The interactive picker needs a dialog-capable UI (TUI/RPC). In
      // print/json modes (ctx.hasUI === false) fall back to a command: plan
      // mode (read-only) stays on and the turn ends — the user starts the
      // pipeline explicitly with /adx-build or /adx-build-verify.
      if (!ctx.hasUI) {
        deps.notify(
          'adx: planning complete — no interactive UI; plan mode stays on, run /adx-build or /adx-build-verify to start',
          'info',
        )
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Planning complete (no interactive UI — plan mode stays on; run /adx-build or /adx-build-verify to start).',
            },
          ],
          details: {},
          // End the turn: no workflow is launched, so the model should not
          // keep working (and plan mode keeps it read-only).
          terminate: true,
        }
      }
      // Picker cancelled (user dismissed a prompt): stay in plan mode.
      const cancelled = () => {
        deps.notify('adx: planning complete — run /adx-build or /adx-build-verify to start', 'info')
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Planning complete (picker cancelled — run /adx-build or /adx-build-verify to start).',
            },
          ],
          details: {},
        }
      }
      const mode = await ctx.ui.select('adx: planning complete — how to proceed?', [
        'Build + verify (full pipeline)',
        'Build (simple)',
        'Choose workspace',
        'Spec only — stop',
      ])
      if (mode === undefined) return cancelled()
      if (mode === 'Spec only — stop') {
        // Export the stored criteria as a spec document and stop here:
        // exit plan mode, launch nothing.
        const path = await deps.specOnly()
        deps.exitPlanMode()
        deps.notify(`adx: spec saved to ${path} — no build launched`, 'info')
        return {
          content: [
            {
              type: 'text' as const,
              text: `Planning complete. Spec saved to ${path} (no build launched).`,
            },
          ],
          details: {},
          // End the turn: nothing is launched, plan mode is off.
          terminate: true,
        }
      }
      let workflow: 'build' | 'build-verify' = mode.startsWith('Build + verify') ? 'build-verify' : 'build'
      let args = workflow === 'build-verify' ? deps.withConfigDefaults('') : ''
      if (mode === 'Choose workspace') {
        const loc = await ctx.ui.select('adx: where to work?', [
          'Work in current workspace',
          'Start a new workspace (worktree)',
        ])
        if (loc === undefined) return cancelled()
        const which = await ctx.ui.select('adx: which pipeline?', [
          'Build + verify (full pipeline)',
          'Build (simple)',
        ])
        if (which === undefined) return cancelled()
        workflow = which.startsWith('Build + verify') ? 'build-verify' : 'build'
        const locArg = `worklocation=${loc.startsWith('Work in current') ? 'current' : 'new'}`
        args = workflow === 'build-verify' ? deps.withConfigDefaults(locArg) : locArg
      }
      deps.exitPlanMode()
      deps.notify(`adx: launching ${workflow}${args ? ` (${args})` : ''}`, 'info')
      await deps.launch(workflow, args)
      return {
        content: [
          { type: 'text' as const, text: `Planning complete. ${workflow} workflow launched.` },
        ],
        details: {},
      }
    },
  }
}

export function createFlowStepDoneTool(onStepDone: (info: StepDoneInfo) => Promise<void>) {
  return {
    name: 'flow_step_done',
    label: 'Step Done',
    description:
      'Signal that the current workflow step is complete. The workflow executor evaluates ' +
      'transitions and injects the next step (or a nudge to keep working). ' +
      'Call it only when the step prompt\'s goal is fully reached.',
    promptSnippet: 'Mark the current workflow step as done so the workflow can advance',
    promptGuidelines: [
      'Call flow_step_done when the current workflow step prompt is fully satisfied; do not call it mid-step.',
    ],
    parameters: Type.Object({
      result: Type.Optional(
        Type.String({
          description:
            'Optional result string for step_result transitions (defaults to "completed")',
        }),
      ),
      content: Type.Optional(
        Type.String({
          description:
            'Optional free-form output captured as {{stepOutput.content}} for later steps',
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      args: { result?: string; content?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: { cwd: string },
    ) {
      await onStepDone({
        ...(args.result !== undefined ? { result: args.result } : {}),
        ...(args.content !== undefined ? { content: args.content } : {}),
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Step marked done. The workflow executor will advance (or nudge you to continue).',
          },
        ],
        details: {},
        // End this turn; the executor queues the next prompt (next step or nudge).
        terminate: true,
      }
    },
  }
}

// ============================================================================
// spec_write (spec mode only)
// ============================================================================

export interface SpecWriteDeps {
  /** cwd the spec path is resolved against (the active session's cwd). */
  cwd: () => string | undefined
  /** Spec path pinned via `/adx-spec <path>` (wins over the default). */
  pinnedPath: () => string | undefined
  notify: (msg: string, level?: 'info' | 'warning' | 'error') => void
  /** Called after the file is written (index.ts ends spec mode here). */
  onWritten?: (absPath: string) => void
}

export function createSpecWriteTool(deps: SpecWriteDeps) {
  return {
    name: 'spec_write',
    label: 'Spec Write',
    // Inactive by default: spec mode activates it explicitly (setActiveTools),
    // so it never leaks into plan/build modes.
    defaultActive: false,
    description:
      'Write the brainstorming/research spec document (markdown) to a file — the single write channel in spec mode while the workspace stays read-only. '
      + 'Target: args.path (a .md path inside the project), else the path pinned via /adx-spec, else .pi/specs/<slug>.md. '
      + 'Call it EXACTLY ONCE, at the end of spec mode, with the complete spec markdown. No build is launched afterwards.',
    promptSnippet: 'Write the final spec markdown document (spec mode only; call once, at the end)',
    promptGuidelines: [
      'Call spec_write exactly once, at the end of spec mode, with the full spec markdown (context & goal, research notes, decisions & assumptions, acceptance-criteria checklist).',
    ],
    parameters: Type.Object({
      content: Type.String({ description: 'The complete spec markdown document' }),
      path: Type.Optional(
        Type.String({
          description: 'Target .md path inside the project (default: the /adx-spec pinned path, else .pi/specs/<slug>.md)',
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      args: { content?: string; path?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionToolContext,
    ) {
      const cwd = deps.cwd()
      if (!cwd) {
        return {
          content: [
            { type: 'text' as const, text: 'spec_write: no active session (cwd unknown) — re-run /adx-spec first.' },
          ],
          details: {},
        }
      }
      const content = typeof args.content === 'string' ? args.content : ''
      if (!content.trim()) {
        return {
          content: [
            { type: 'text' as const, text: 'spec_write: content is empty — pass the complete spec markdown.' },
          ],
          details: {},
        }
      }
      const chosen = args.path?.trim() || deps.pinnedPath()
      const fallback = defaultSpecPath(cwd)
      const target = chosen ? resolveSpecPath(cwd, chosen) : resolveSpecPath(cwd, fallback)
      if (!target) {
        const problem = specPathError(cwd, chosen ?? fallback) ?? 'Spec path could not be resolved.'
        deps.notify(`adx: ${problem}`, 'warning')
        return {
          content: [{ type: 'text' as const, text: `spec_write: ${problem}` }],
          details: {},
        }
      }
      let written: string
      try {
        written = await writeSpecFile(cwd, target, content)
      } catch (err) {
        const msg = `adx: failed to write spec — ${err instanceof Error ? err.message : String(err)}`
        deps.notify(msg, 'error')
        return { content: [{ type: 'text' as const, text: msg }], details: {} }
      }
      deps.notify(`adx: spec saved to ${written}`, 'info')
      deps.onWritten?.(written)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Spec saved to ${written}. Spec mode is complete — the session is now in normal build mode (no build launched).`,
          },
        ],
        details: {},
        // End the turn: the spec is saved and spec mode has ended.
        terminate: true,
      }
    },
  }
}
