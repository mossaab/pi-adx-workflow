/**
 * adx-workflow extension entry point.
 *
 * plan → build/verify → review → summarize workflow for
 * pi-coding-agent. Flow sub-agents (verifier / code reviewer) are spawned
 * as isolated `pi -p` child processes (in-house propagation — see
 * subagent.ts); no pi-subagents dependency.
 *
 * Commands:
 *   /adx-plan          enter plan mode (read-only; planner proposes criteria)
 *   /adx-build         switch to build mode + launch the simple build workflow
 *   /adx-build-verify  switch to build mode + launch the full build-verify workflow
 *   /adx-status        show current workflow state
 *   /adx-resume        resume a blocked/waiting workflow
 *   /adx-cancel        cancel the current workflow run
 *   /adx-config        show config / "edit" opens a menu / "set key=value [project]"
 * Shortcut:
 *   Ctrl+Alt+A   toggle plan mode
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { createFlowMetaTool, createFlowStepDoneTool, createFlowPlanDoneTool } from './tools.js'
import {
  PLANNER_PROMPT_SECTION,
  AUTO_PLANNER_PROMPT_SECTION,
  BUILDER_PROMPT_SECTION,
  activatePlanModeTools,
  getBuildModeTools,
  planModeBashGuard,
} from './modes.js'
import { loadState } from './store.js'
import { refreshFlowWidget, clearFlowWidget } from './widgets.js'
import { createAskUserTool } from './ask-user.js'
import { loadConfig, type AdxConfig } from './config.js'
import {
  DEFAULT_CONFIG,
  ensureUserConfig,
  projectConfigPath,
  setConfigValue,
  userConfigPath,
} from './config.js'

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
  let autoMode = false
  let toolsBeforePlanMode: string[] | undefined
  let ctx: ExtensionContext | undefined
  /** User/project config (loaded at session_start; defaults until then). */
  let config: AdxConfig = {}

  // ------------------------------------------------------------------ flag
  // `pi --adx-auto "goal: point 1, point 2, ..."` runs the whole pipeline
  // unattended: plan (refine the provided points) → build → verify → recap.
  pi.registerFlag('adx-auto', {
    description: 'adx auto mode: plan → build → verify → recap without approvals (provide the acceptance points in the message)',
    type: 'boolean',
    default: false,
  })

  // ------------------------------------------------------------------ executor
  const executor = new AdxExecutor({
    pi,
    notify: (msg, level) => ctx?.ui.notify(msg, level ?? 'info'),
    updateWidget: () => {
      if (config.showWidget === false) return
      if (ctx) refreshFlowWidget(ctx)
    },
    widgetEnabled: () => config.showWidget !== false,
    // Filled in once a ctx is available (session_start)
  })

  // ------------------------------------------------------------------ tools
  pi.registerTool(
    createFlowMetaTool(() => {
      if (config.showWidget === false) return
      if (ctx) refreshFlowWidget(ctx)
    }),
  )
  pi.registerTool(
    createFlowStepDoneTool(async (info) => {
      executor.markStepDoneCalled()
      await executor.onStepDone(info)
    }),
  )
  // OpenFox-style structured question tool (plan-mode clarification):
  // choice / confirm / text dialogs pause the turn until the user answers
  // (a dismissed prompt = skip → proceed with best judgment).
  pi.registerTool(createAskUserTool())

  /** Apply the config's skipReview default to launch args (explicit args win). */
  function withConfigDefaults(rawArgs: string): string {
    if (config.skipReview !== true) return rawArgs
    if (rawArgs.includes('skip_review')) return rawArgs
    return rawArgs ? `skip_review=true ${rawArgs}` : 'skip_review=true'
  }

  // Planning-complete hand-off: in auto mode it exits plan mode and launches
  // the full build-verify pipeline (no review); in interactive mode the user
  // picks the pipeline/workspace via a picker.
  pi.registerTool(
    createFlowPlanDoneTool(async () => {
      const c = ctx
      if (!c) return
      if (autoMode) {
        exitPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
        c.ui.notify('adx: auto mode — planning complete, launching build-verify (no review)', 'info')
        await executor.launch('build-verify', c, 'auto=true skip_review=true')
        return
      }
      // Interactive mode: pick the next step (pipeline + workspace).
      const mode = await c.ui.select('adx: planning complete — how to proceed?', [
        'Build + verify (full pipeline)',
        'Build (simple)',
        'Choose workspace',
      ])
      if (mode === undefined) {
        c.ui.notify('adx: planning complete — run /adx-build or /adx-build-verify to start', 'info')
        return
      }
      let workflow = mode.startsWith('Build + verify') ? 'build-verify' : 'build'
      let args = workflow === 'build-verify' ? withConfigDefaults('') : ''
      if (mode === 'Choose workspace') {
        const loc = await c.ui.select('adx: where to work?', [
          'Work in current workspace',
          'Start a new workspace (worktree)',
        ])
        if (loc === undefined) {
          c.ui.notify('adx: planning complete — run /adx-build or /adx-build-verify to start', 'info')
          return
        }
        const which = await c.ui.select('adx: which pipeline?', [
          'Build + verify (full pipeline)',
          'Build (simple)',
        ])
        if (which === undefined) {
          c.ui.notify('adx: planning complete — run /adx-build or /adx-build-verify to start', 'info')
          return
        }
        workflow = which.startsWith('Build + verify') ? 'build-verify' : 'build'
        const locArg = `worklocation=${loc.startsWith('Work in current') ? 'current' : 'new'}`
        args = workflow === 'build-verify' ? withConfigDefaults(locArg) : locArg
      }
      exitPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
      c.ui.notify(`adx: launching ${workflow === 'build-verify' ? 'build-verify' : 'build'}${args ? ` (${args})` : ''}`, 'info')
      await executor.launch(workflow, c, args)
    }),
  )

  // ------------------------------------------------------------------ mode helpers
  function enterPlanMode(notify: (msg: string, level?: 'info' | 'warning' | 'error') => void) {
    if (planMode) return
    planMode = true
    toolsBeforePlanMode = pi.getActiveTools()
    let tools = activatePlanModeTools(pi.getActiveTools())
    // Auto mode is unattended: no interactive question tool.
    if (autoMode) tools = tools.filter((t) => t !== 'ask_user')
    pi.setActiveTools(tools)
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
    description: 'Switch to build mode and launch the simple build workflow (no verify/review)',
    handler: async (args, c) => {
      ctx = c
      exitPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
      const workflow = config.defaultBuildWorkflow === 'build-verify' ? 'build-verify' : 'build'
      await executor.launch(workflow, c, workflow === 'build-verify' ? withConfigDefaults(args) : args)
    },
  })
  pi.registerCommand('adx-build-verify', {
    description: 'Switch to build mode and launch the full build-verify workflow (verify + code review; add skip_review=true to skip the review)',
    handler: async (args, c) => {
      ctx = c
      exitPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
      await executor.launch('build-verify', c, withConfigDefaults(args))
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
      if (config.showWidget !== false) clearFlowWidget(c)
    },
  })

  pi.registerCommand('adx-config', {
    description: 'Show effective adx config; "edit" opens a menu; "set <key>=<value> [project]" updates the config file',
    handler: async (args, c) => {
      ctx = c
      const raw = (args ?? '').trim()
      const effective = { ...DEFAULT_CONFIG, ...config }
      const keys = Object.keys(DEFAULT_CONFIG) as (keyof AdxConfig)[]
      const valuesFor = (k: keyof AdxConfig): string[] =>
        k === 'defaultBuildWorkflow' ? ['build', 'build-verify'] : ['true', 'false']
      const toValue = (v: string): boolean | string => (v === 'true' ? true : v === 'false' ? false : v)

      // ------------------------------------------------------------------ menu
      if (raw === 'edit' || raw === '') {
        const scopeLabel = await c.ui.select('adx config: which file to edit?', [
          'User (all projects) — ~/.pi/agent/adx-workflow.json',
          'Project (this repo) — .pi/adx-workflow.json',
        ])
        if (scopeLabel === undefined) {
          c.ui.notify('adx config: cancelled', 'info')
          return
        }
        const scope: 'user' | 'project' = scopeLabel.startsWith('User') ? 'user' : 'project'
        // Loop: after each change, back to the setting menu (updated values).
        // "Done" exits the menu.
        let changed = 0
        const DONE = 'Done (save & exit)'
        while (true) {
          const keyLabel = await c.ui.select(
            'adx config: which setting?',
            [...keys.map((k) => `${k} = ${String(effective[k])}`), DONE],
          )
          if (keyLabel === undefined || keyLabel === DONE) break
          const key = keyLabel.split(' = ')[0] as keyof AdxConfig
          const valLabel = await c.ui.select(`adx config: value for ${key}?`, valuesFor(key))
          if (valLabel === undefined) continue // cancelled the value picker → pick again
          const value = toValue(valLabel)
          ;(effective as Record<string, boolean | string>)[key] = value
          setConfigValue(c.cwd, key, value, scope)
          config = loadConfig(c.cwd)
          changed += 1
          c.ui.notify(`adx: ${scope} config: ${key}=${String(value)}`, 'info')
        }
        if (changed > 0) {
          c.ui.notify(
            `adx: ${scope} config updated (${changed} change${changed > 1 ? 's' : ''}) — showWidget/skipReview/defaultBuildWorkflow apply now; plan/auto modes next session`,
            'info',
          )
        } else {
          c.ui.notify('adx config: no changes', 'info')
        }
        return
      }

      // ------------------------------------------------------------------ one-shot set
      if (raw.startsWith('set ')) {
        const kv = raw.slice(4).trim()
        const scope: 'user' | 'project' = kv.endsWith(' project') ? 'project' : 'user'
        const body = scope === 'project' ? kv.slice(0, -8).trim() : kv
        const eq = body.indexOf('=')
        if (eq <= 0) {
          c.ui.notify('usage: /adx-config set <key>=<value> [project]', 'warning')
          return
        }
        const key = body.slice(0, eq).trim()
        const valRaw = body.slice(eq + 1).trim()
        const allowed = Object.keys(DEFAULT_CONFIG) as (keyof AdxConfig)[]
        if (!allowed.includes(key as keyof AdxConfig)) {
          c.ui.notify(`adx: unknown config key "${key}" (valid: ${allowed.join(', ')})`, 'warning')
          return
        }
        const value = toValue(valRaw)
        setConfigValue(c.cwd, key as keyof AdxConfig, value, scope)
        config = loadConfig(c.cwd)
        c.ui.notify(
          `adx: ${scope} config updated (${key}=${String(value)}) — showWidget/skipReview/defaultBuildWorkflow apply now; plan/auto modes apply next session`,
          'info',
        )
        return
      }

      // ------------------------------------------------------------------ show
      if (raw !== 'show') {
        c.ui.notify('usage: /adx-config [edit | show | set <key>=<value> [project]]', 'warning')
        return
      }
      c.ui.notify(
        [
          'adx config (effective):',
          JSON.stringify(effective, null, 2),
          `user file:    ${userConfigPath()}`,
          `project file: ${projectConfigPath(c.cwd)}`,
          'update: /adx-config edit (menu) or /adx-config set <key>=<value> [project]',
        ].join('\n'),
        'info',
      )
    },
  })

  pi.registerShortcut('ctrl+alt+a', {
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
    // First run: give the user a ready-to-edit config file with the defaults.
    const created = ensureUserConfig()
    if (created) c.ui.notify(`adx: created default config at ${created} (edit to customize)`, 'info')
    config = loadConfig(c.cwd)
    // Restore any persisted run (e.g. after a pi restart)
    const state = await loadState(c.cwd)
    if (state.execution && state.execution.status !== 'done') {
      c.ui.notify(`adx: restoring workflow "${state.execution.workflowName}" (status: ${state.execution.status})`, 'info')
      await executor.restore(state, c)
    } else if (pi.getFlag('adx-auto') === true || config.autoMode === true) {
      // Unattended pipeline: straight into plan mode (refine the provided
      // points, then flow_plan_done hands off to build-verify automatically).
      // CLI flag wins; config.autoMode is its persistent equivalent.
      autoMode = true
      enterPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
    } else if (config.defaultPlanMode === true) {
      // Config: start every session in plan mode (user-driven hand-off).
      enterPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
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
      sections['adx-plan'] = (autoMode ? AUTO_PLANNER_PROMPT_SECTION : PLANNER_PROMPT_SECTION).trim()
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
