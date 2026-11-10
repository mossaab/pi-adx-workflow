/**
 * adx-workflow extension entry point.
 *
 * plan → build/verify → review → summarize workflow for
 * pi-coding-agent. Flow sub-agents (verifier / code reviewer) are spawned
 * as isolated `pi -p` child processes (in-house propagation — see
 * subagent.ts); no pi-subagents dependency.
 *
 * Commands:
 *   /adx-plan    enter plan mode (read-only; planner proposes criteria)
 *   /adx-build   switch to build mode + launch the build-verify workflow
 *   /adx-status  show current workflow state
 *   /adx-resume  resume a blocked/waiting workflow
 *   /adx-cancel  cancel the current workflow run
 * Shortcut:
 *   Ctrl+Alt+P   toggle plan mode
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { createFlowMetaTool, createFlowStepDoneTool } from './tools.js'
import {
  PLANNER_PROMPT_SECTION,
  BUILDER_PROMPT_SECTION,
  activatePlanModeTools,
  getBuildModeTools,
  planModeBashGuard,
} from './modes.js'
import { loadState } from './store.js'
import { refreshFlowWidget, clearFlowWidget } from './widgets.js'

// The executor is wired in step 6; keep a mutable handle so index.ts can
// forward commands/tools without a circular import.
import { AdxExecutor } from './executor.js'

export default function adxWorkflowExtension(pi: ExtensionAPI): void {
  // ------------------------------------------------------------------ child mode
  // When spawned by the executor (ADX_CHILD=1), the child session only needs
  // the flow_meta tool — no executor, commands, widgets or events, so nothing
  // in the child can advance (or corrupt) the parent's workflow state.
  if (process.env.ADX_CHILD === '1') {
    pi.registerTool(createFlowMetaTool())
    return
  }
  let planMode = false
  let toolsBeforePlanMode: string[] | undefined
  let ctx: ExtensionContext | undefined

  // ------------------------------------------------------------------ executor
  const executor = new AdxExecutor({
    pi,
    notify: (msg, level) => ctx?.ui.notify(msg, level ?? 'info'),
    updateWidget: () => {
      if (ctx) refreshFlowWidget(ctx)
    },
    // Filled in once a ctx is available (session_start)
  })

  // ------------------------------------------------------------------ tools
  pi.registerTool(
    createFlowMetaTool(() => {
      if (ctx) refreshFlowWidget(ctx)
    }),
  )
  pi.registerTool(
    createFlowStepDoneTool(async (info) => {
      executor.markStepDoneCalled()
      await executor.onStepDone(info)
    }),
  )

  // ------------------------------------------------------------------ mode helpers
  function enterPlanMode(notify: (msg: string, level?: 'info' | 'warning' | 'error') => void) {
    if (planMode) return
    planMode = true
    toolsBeforePlanMode = pi.getActiveTools()
    pi.setActiveTools(activatePlanModeTools(pi.getActiveTools()))
    notify('adx: plan mode ON (read-only). Propose acceptance criteria with flow_meta.', 'info')
  }

  function exitPlanMode(notify: (msg: string, level?: 'info' | 'warning' | 'error') => void) {
    if (!planMode) return
    planMode = false
    pi.setActiveTools(getBuildModeTools(toolsBeforePlanMode ?? pi.getActiveTools()))
    toolsBeforePlanMode = undefined
    notify('adx: plan mode OFF (build mode).', 'info')
  }

  // ------------------------------------------------------------------ commands
  pi.registerCommand('adx-plan', {
    description: 'Enter plan mode (read-only; planner proposes acceptance criteria)',
    handler: async (_args, c) => {
      ctx = c
      enterPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
    },
  })

  pi.registerCommand('adx-build', {
    description: 'Switch to build mode and launch the build-verify workflow',
    handler: async (args, c) => {
      ctx = c
      exitPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
      await executor.launch('build-verify', c, args)
    },
  })

  pi.registerCommand('adx-status', {
    description: 'Show the current adx workflow state',
    handler: async (_args, c) => {
      ctx = c
      await executor.showStatus(c)
    },
  })

  pi.registerCommand('adx-resume', {
    description: 'Resume a blocked or waiting adx workflow',
    handler: async (_args, c) => {
      ctx = c
      await executor.resume(c)
    },
  })

  pi.registerCommand('adx-cancel', {
    description: 'Cancel the current adx workflow run',
    handler: async (_args, c) => {
      ctx = c
      await executor.cancel(c)
      clearFlowWidget(c)
    },
  })

  pi.registerShortcut('ctrl+alt+p', {
    description: 'Toggle adx plan mode',
    handler: async (c) => {
      ctx = c
      if (planMode) exitPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
      else enterPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
    },
  })

  // ------------------------------------------------------------------ events
  pi.on('session_start', async (_event, c) => {
    ctx = c
    // Restore any persisted run (e.g. after a pi restart)
    const state = await loadState(c.cwd)
    if (state.execution && state.execution.status !== 'done') {
      c.ui.notify(`adx: restoring workflow "${state.execution.workflowName}" (status: ${state.execution.status})`, 'info')
      await executor.restore(state, c)
    }
  })

  pi.on('session_shutdown', () => {
    ctx = undefined
  })

  /**
   * Inject the mode prompt section (planner in plan mode, builder while a
   * workflow is running). `systemPromptOptions.sections` is a keyed record;
   * pi diffs it and only patches changed sections (cache-friendly).
   */
  pi.on('before_agent_start', (event) => {
    const sections = event.systemPromptOptions.sections
    if (planMode) {
      sections['adx-plan'] = PLANNER_PROMPT_SECTION.trim()
      delete sections['adx-build']
    } else if (executor.isActive()) {
      sections['adx-build'] = BUILDER_PROMPT_SECTION.trim()
      delete sections['adx-plan']
    } else {
      delete sections['adx-plan']
      delete sections['adx-build']
    }
  })

  /** Plan mode: guard bash tool calls against non-read-only commands. */
  pi.on('tool_call', (event) => {
    if (!planMode || event.toolName !== 'bash') return
    const args = (event.input ?? {}) as Record<string, unknown>
    const problem = planModeBashGuard(args, (msg) =>
      ctx?.ui.notify(msg, 'warning'),
    )
    if (problem) {
      // Block the call and hand the reason back to the model as a tool result —
      // WITHOUT terminate: the turn continues so the model can adapt (simpler
      // read-only variant, another tool, or proceed with the plan). Plan mode
      // itself stays on; only this one command is refused.
      return { block: true, reason: problem }
    }
  })

  // ------------------------------------------------------------------ never-stop (auto-continue)
  //
  // When a run ends on an active agent step without flow_step_done (context
  // pressure, stream stop, model pausing mid-reflection…), append a
  // continuation message (with the agent's resume note + criteria status) and
  // request one more provider request. The user never has to press continue.
  // Explicit user aborts (Escape) are respected — /adx-resume is available.
  pi.on('agent_before_settle', async (event) => {
    if (event.outcome === 'aborted') return
    const continuation = await executor.autoContinue()
    if (!continuation) return
    return {
      entries: [
        ...event.entries,
        {
          type: 'custom_message',
          customType: 'adx-continue',
          content: continuation.message,
          display: true,
        },
      ],
      continue: true,
    }
  })

  /** Surface aborts: a settled-aborted run is resumable via /adx-resume. */
  pi.on('agent_settled', (event) => {
    if (event.aborted && executor.isActive()) {
      ctx?.ui.notify('adx: run aborted — the workflow is resumable with /adx-resume', 'info')
    }
  })
}
