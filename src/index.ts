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
 *   /adx-build-mode    switch to build mode (turn plan mode off; no launch)
 *   /adx-build         switch to build mode + launch the simple build workflow
 *   /adx-build-verify  switch to build mode + launch the full build-verify workflow
 *   /adx-status        show current workflow state
 *   /adx-resume        resume a blocked/waiting workflow
 *   /adx-cancel        cancel the current workflow run
 *   /adx-config        show config / "edit" opens a menu / "set key=value [project]"
 * Flag:
 *   --adx-auto         unattended pipeline: plan → build → verify → recap without approvals
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
import { loadState, mutateState, onStateWarning } from './store.js'
import { refreshFlowWidget, clearFlowWidget, setModeBadge } from './widgets.js'
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
  /** Pi session id — keys the per-session adx state file (own plan per session). */
  let sessionId: string | undefined

  /** Persist the plan-mode flag into the session's state file (resume-friendly). */
  function persistPlanMode(on: boolean): void {
    const c = ctx
    if (!c) return
    const sid = sessionId ?? c.sessionManager.getSessionId()
    void mutateState(c.cwd, sid, (state) => {
      state.planMode = on
    }).catch(() => {
      /* best effort — the in-memory flag is authoritative */
    })
  }

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
      if (ctx) refreshFlowWidget(ctx, sessionId)
    },
    widgetEnabled: () => config.showWidget !== false,
    // Filled in once a ctx is available (session_start)
  })

  /** An executor rejection (e.g. a state-lock timeout) must not surface as an
   *  unhandled promise rejection in a command handler — notify the user. */
  const executorFail = (what: string, err: unknown, c: ExtensionContext): void => {
    c.ui.notify(`adx: ${what} failed — ${err instanceof Error ? err.message : String(err)}`, 'error')
  }

  // Surface store-level state-file warnings (corrupt reset, version mismatch)
  // in the TUI — a console.warn alone is easy to miss.
  onStateWarning((msg) => {
    ctx?.ui.notify(msg, 'warning')
  })

  // ------------------------------------------------------------------ tools
  pi.registerTool(
    createFlowMetaTool(() => {
      if (config.showWidget === false) return
      if (ctx) refreshFlowWidget(ctx, sessionId)
    }),
  )
  pi.registerTool(
    createFlowStepDoneTool(async (info) => {
      executor.markStepDoneCalled()
      await executor.onStepDone(info)
    }),
  )
  // Structured question tool for plan-mode clarification:
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
    createFlowPlanDoneTool({
      autoMode: () => autoMode,
      launch: (workflow, args) => {
        const c = ctx
        if (!c) return Promise.resolve()
        return executor.launch(workflow, c, args)
      },
      withConfigDefaults,
      exitPlanMode: () => {
        const c = ctx
        if (c) exitPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
      },
      notify: (m, l) => ctx?.ui.notify(m, l ?? 'info'),
    }),
  )

  // ------------------------------------------------------------------ mode helpers
  function showBadge(badge: string | undefined): void {
    if (config.showWidget === false) badge = undefined
    if (ctx) setModeBadge(ctx, badge, sessionId)
  }

  function enterPlanMode(notify: (msg: string, level?: 'info' | 'warning' | 'error') => void) {
    if (planMode) return
    planMode = true
    toolsBeforePlanMode = pi.getActiveTools()
    let tools = activatePlanModeTools(pi.getActiveTools())
    // Auto mode is unattended: no interactive question tool.
    if (autoMode) tools = tools.filter((t) => t !== 'ask_user')
    pi.setActiveTools(tools)
    persistPlanMode(true)
    showBadge(autoMode ? 'adx: [AUTO] plan → build → verify → recap' : 'adx: [PLAN] read-only · /adx-build-mode to exit · /adx-build to start')
    notify('adx: plan mode ON (read-only). Propose acceptance criteria with flow_meta. Exit: /adx-build-mode or Ctrl+Alt+A.', 'info')
  }

  function exitPlanMode(notify: (msg: string, level?: 'info' | 'warning' | 'error') => void) {
    if (!planMode) return
    planMode = false
    pi.setActiveTools(getBuildModeTools(toolsBeforePlanMode ?? pi.getActiveTools()))
    toolsBeforePlanMode = undefined
    persistPlanMode(false)
    showBadge(undefined)
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

  pi.registerCommand('adx-build-mode', {
    description: 'Switch to build mode (turn plan mode off) without launching a workflow',
    handler: async (_args, c) => {
      ctx = c
      if (planMode) exitPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
      else c.ui.notify('adx: already in build mode (plan mode is off)', 'info')
    },
  })

  pi.registerCommand('adx-build', {
    description:
      'Switch to build mode and launch a workflow (default: the configured build one). Pass a workflow id as the first token, e.g. /adx-build pr-review pr_number=123',
    handler: async (args, c) => {
      ctx = c
      exitPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
      // First bare token (no '=') names the workflow; the rest are key=value params.
      const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean)
      const first = tokens[0]
      const hasWorkflowToken = first !== undefined && !first.includes('=')
      const workflow = hasWorkflowToken
        ? first
        : config.defaultBuildWorkflow === 'build-verify' ? 'build-verify' : 'build'
      const params = hasWorkflowToken ? tokens.slice(1).join(' ') : tokens.join(' ')
      try {
        await executor.launch(workflow, c, workflow === 'build-verify' ? withConfigDefaults(params) : params)
      } catch (err) {
        executorFail('launch', err, c)
      }
    },
  })
  pi.registerCommand('adx-build-verify', {
    description: 'Switch to build mode and launch the full build-verify workflow (verify + code review; add skip_review=true to skip the review)',
    handler: async (args, c) => {
      ctx = c
      exitPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
      try {
        await executor.launch('build-verify', c, withConfigDefaults(args))
      } catch (err) {
        executorFail('launch', err, c)
      }
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
      try {
        await executor.resume(c)
      } catch (err) {
        executorFail('resume', err, c)
      }
    },
  })

  pi.registerCommand('adx-cancel', {
    description: 'Cancel the current adx workflow run',
    handler: async (_args, c) => {
      ctx = c
      try {
        await executor.cancel(c)
      } catch (err) {
        executorFail('cancel', err, c)
      }
      if (config.showWidget !== false) clearFlowWidget(c, sessionId)
    },
  })

  pi.registerCommand('adx-config', {
    description: 'Show effective adx config; "edit" opens a menu; "set <key>=<value> [project]" updates the config file',
    handler: async (args, c) => {
      ctx = c
      const raw = (args ?? '').trim()
      const effective = { ...DEFAULT_CONFIG, ...config }
      const keys = Object.keys(DEFAULT_CONFIG) as (keyof AdxConfig)[]
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
        // Single-step menu: picking a setting row TOGGLES/rotates its value
        // (booleans flip, defaultBuildWorkflow cycles) and writes it.
        // "Done" exits. Loop until done.
        let changed = 0
        const DONE = 'Done (save & exit)'
        while (true) {
          const keyLabel = await c.ui.select(
            'adx config: pick a setting to toggle it (Enter = flip value)',
            [...keys.map((k) => `${k} = ${String(effective[k])}`), DONE],
          )
          if (keyLabel === undefined || keyLabel === DONE) break
          const key = keyLabel.split(' = ')[0] as keyof AdxConfig
          const current = effective[key]
          const value: boolean | string =
            key === 'defaultBuildWorkflow'
              ? current === 'build' ? 'build-verify' : 'build'
              : !current
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
    sessionId = c.sessionManager.getSessionId()
    // First run: give the user a ready-to-edit config file with the defaults.
    const created = ensureUserConfig()
    if (created) c.ui.notify(`adx: created default config at ${created} (edit to customize)`, 'info')
    config = loadConfig(c.cwd)
    // Restore this session's persisted state (per-session file: resuming a
    // session brings back its plan/run; a new session starts fresh).
    const state = await loadState(c.cwd, sessionId)
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
    } else if (state.planMode === true) {
      // The session was stopped mid-plan: restore plan mode so the user can
      // pick up the unfinished plan (criteria are already in the state file).
      enterPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
      c.ui.notify('adx: plan mode restored (unfinished plan from last stop — continue with flow_meta, then /adx-build)', 'info')
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
