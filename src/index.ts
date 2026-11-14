/**
 * adx-workflow extension entry point.
 *
 * plan → build/verify → review → summarize workflow for
 * pi-coding-agent. Flow sub-agents (verifier / code reviewer) are spawned
 * as isolated `pi -p` child processes (in-house propagation — see
 * subagent.ts); no pi-subagents dependency.
 *
 * Commands:
 *   /adx-plan             enter plan mode (read-only; planner proposes criteria)
 *   /adx-spec [path]      enter spec mode (read-only brainstorm/research; writes a spec file, no build)
 *   /adx-approve          approve the plan/spec: switch to build mode (no launch)
 *   /adx-run [workflow]   switch to build mode + launch a workflow (default: the configured build one)
 *   /adx-status           show current workflow state
 *   /adx-resume           resume a blocked/waiting workflow
 *   /adx-cancel           cancel the current workflow run
 *   /adx-config           show config / "edit" opens a menu / "set key=value [project]"
 * Flag:
 *   --adx-auto         unattended pipeline: plan → build → verify → recap without approvals
 * Shortcut:
 *   Ctrl+Alt+A   toggle plan mode
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { createFlowMetaTool, createFlowStepDoneTool, createFlowPlanDoneTool, createSpecWriteTool } from './tools.js'
import {
  PLANNER_PROMPT_SECTION,
  AUTO_PLANNER_PROMPT_SECTION,
  BUILDER_PROMPT_SECTION,
  SPEC_PROMPT_SECTION,
  activatePlanModeTools,
  getBuildModeTools,
  getSpecModeTools,
  planModeBashGuard,
  CODE_EXEC_TOOLS,
  planModeExecGuard,
} from './modes.js'
import { loadState, mutateState, onStateWarning, setLegacyAdoption } from './store.js'
import { composeSpecMarkdown, defaultSpecPath, specPathError, writeSpecFile } from './spec.js'
import { relative, resolve as resolvePath } from 'node:path'
import { refreshFlowWidget, clearFlowWidget, setModeBadge, type ModeBadgeSpec } from './widgets.js'
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
  let specMode = false
  let toolsBeforePlanMode: string[] | undefined
  let toolsBeforeSpecMode: string[] | undefined
  /** Spec file location pinned via /adx-spec <path> (relative to cwd). */
  let specPath: string | undefined
  let ctx: ExtensionContext | undefined
  /** User/project config (loaded at session_start; defaults until then). */
  let config: AdxConfig = {}
  /** Pi session id — keys the per-session adx state file (own plan per session). */
  let sessionId: string | undefined
  /** Latest pending plan/spec flag persist — launch paths await this chain. */
  let pendingModePersist: Promise<unknown> = Promise.resolve()

  /**
   * Persist the plan-mode flag into the session's state file (resume-friendly).
   * Returns the write promise: launch paths AWAIT it so the executor's next
   * persist() (load + save) sees planMode=false — a fire-and-forget write
   * used to lose that race, leaving finished runs with planMode=true.
   */
  function persistPlanMode(on: boolean): Promise<void> {
    const c = ctx
    if (!c) return Promise.resolve()
    const sid = sessionId ?? c.sessionManager.getSessionId()
    const p = mutateState(c.cwd, sid, (state) => {
      state.planMode = on
    }).catch(() => {
      /* best effort — the in-memory flag is authoritative */
    })
    pendingModePersist = p
    return p
  }

  /** Persist the spec-mode flag (and its pinned spec path) for resume. */
  function persistSpecMode(on: boolean, path?: string): Promise<void> {
    const c = ctx
    if (!c) return Promise.resolve()
    const sid = sessionId ?? c.sessionManager.getSessionId()
    const p = mutateState(c.cwd, sid, (state) => {
      state.specMode = on
      state.specPath = on ? path : undefined
    }).catch(() => {
      /* best effort — the in-memory flag is authoritative */
    })
    pendingModePersist = p
    return p
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
  // picks the pipeline/workspace via a picker (or exports a spec and stops).
  pi.registerTool(
    createFlowPlanDoneTool({
      autoMode: () => autoMode,
      launch: (workflow, args) => {
        const c = ctx
        if (!c) return Promise.resolve()
        return executor.launch(workflow, c, args)
      },
      withConfigDefaults,
      exitPlanMode: async () => {
        const c = ctx
        if (c) await exitPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
      },
      specOnly: async () => {
        // "Spec only — stop": export the stored criteria as a spec document
        // (.pi/specs/<slug>.md) and stop — no workflow is launched.
        const c = ctx
        if (!c) throw new Error('no active session')
        const sid = sessionId ?? c.sessionManager.getSessionId()
        const state = await loadState(c.cwd, sid)
        const criteria = state.metadata['criteria'] ?? []
        const rel = defaultSpecPath(c.cwd)
        const written = await writeSpecFile(c.cwd, resolvePath(c.cwd, rel), composeSpecMarkdown({ criteria, title: 'Session spec' }))
        // Display the concise project-relative form (the written path may carry
        // a collision suffix); the absolute path stays the write source of truth.
        return relative(c.cwd, written)
      },
      notify: (m, l) => ctx?.ui.notify(m, l ?? 'info'),
    }),
  )

  // Spec-mode write channel: the ONLY way spec mode touches the filesystem.
  // defaultActive: false — it is activated only while spec mode is on.
  pi.registerTool(
    createSpecWriteTool({
      cwd: () => ctx?.cwd,
      pinnedPath: () => specPath,
      notify: (m, l) => ctx?.ui.notify(m, l ?? 'info'),
      onWritten: (absPath) => {
        const c = ctx
        specPath = absPath
        if (specMode) void exitSpecMode((m, l) => c?.ui.notify(m, l ?? 'info'))
      },
    }),
  )

  // ------------------------------------------------------------------ mode helpers
  function showBadge(badge: ModeBadgeSpec | undefined): void {
    if (config.showWidget === false) badge = undefined
    if (ctx) setModeBadge(ctx, badge, sessionId)
  }

  function enterPlanMode(notify: (msg: string, level?: 'info' | 'warning' | 'error') => void) {
    if (planMode) return
    // Plan mode and spec mode are mutually exclusive read-only modes.
    if (specMode) void exitSpecMode(() => {})
    planMode = true
    toolsBeforePlanMode = pi.getActiveTools()
    let tools = activatePlanModeTools(pi.getActiveTools())
    // Auto mode is unattended: no interactive question tool.
    if (autoMode) tools = tools.filter((t) => t !== 'ask_user')
    pi.setActiveTools(tools)
    void persistPlanMode(true)
    showBadge(
      autoMode
        ? { mode: 'auto', detail: 'plan → build → verify → recap' }
        : { mode: 'plan', detail: 'read-only · /adx-approve to exit · /adx-run to start' },
    )
    notify('adx: plan mode ON (read-only). Propose acceptance criteria with flow_meta. Exit: /adx-approve or Ctrl+Alt+A.', 'info')
  }

  async function exitPlanMode(notify: (msg: string, level?: 'info' | 'warning' | 'error') => void): Promise<void> {
    if (!planMode) return
    planMode = false
    pi.setActiveTools(getBuildModeTools(toolsBeforePlanMode ?? pi.getActiveTools()))
    toolsBeforePlanMode = undefined
    // Badge + notification run synchronously so a fire-and-forget plan↔spec
    // switch (enterSpecMode → void exitPlanMode) can't be clobbered by the
    // pending continuation after the new mode's badge is already set.
    showBadge(undefined)
    notify('adx: plan mode OFF (build mode).', 'info')
    // Last: the persist must land before any launch persist that follows
    // (exitReadOnlyModes / flow_plan_done await this function for that).
    await persistPlanMode(false)
  }

  function enterSpecMode(
    notify: (msg: string, level?: 'info' | 'warning' | 'error') => void,
    pathArg?: string,
  ): void {
    if (specMode) return
    // Spec mode and plan mode are mutually exclusive read-only modes.
    if (planMode) void exitPlanMode(() => {})
    specMode = true
    toolsBeforeSpecMode = pi.getActiveTools()
    pi.setActiveTools(getSpecModeTools(pi.getActiveTools()))
    specPath = pathArg || undefined
    void persistSpecMode(true, specPath)
    showBadge({ mode: 'spec', detail: `read-only · /adx-approve to exit${specPath ? ` · spec: ${specPath}` : ''}` })
    notify(
      'adx: spec mode ON (read-only brainstorm/research). Explore, research, then call spec_write ONCE with the full spec markdown. Exit: /adx-approve or Ctrl+Alt+A.',
      'info',
    )
  }

  async function exitSpecMode(notify: (msg: string, level?: 'info' | 'warning' | 'error') => void): Promise<void> {
    if (!specMode) return
    specMode = false
    pi.setActiveTools(getBuildModeTools(toolsBeforeSpecMode ?? pi.getActiveTools()))
    toolsBeforeSpecMode = undefined
    specPath = undefined
    // Badge + notification run synchronously (same reason as exitPlanMode).
    showBadge(undefined)
    notify('adx: spec mode OFF (build mode).', 'info')
    await persistSpecMode(false)
  }

  /**
   * Exit whichever read-only mode (plan/spec) is active — used before
   * launching a build. Awaited: the flag persists must land BEFORE the
   * executor's launch persist() (which loads then saves the state file),
   * or the executor would write back the stale planMode=true.
   */
  async function exitReadOnlyModes(
    notify: (msg: string, level?: 'info' | 'warning' | 'error') => void,
  ): Promise<void> {
    if (specMode) await exitSpecMode(notify)
    if (planMode) await exitPlanMode(notify)
    // A fire-and-forget exit (e.g. the Ctrl+Alt+A shortcut) may still be
    // persisting planMode=false: await the pending persist so the launch's
    // loadState (which reads the file directly) cannot read it back stale
    // and write it over the flag.
    await pendingModePersist
  }

  // ------------------------------------------------------------------ commands
  pi.registerCommand('adx-plan', {
    description: 'Enter plan mode (read-only; planner proposes acceptance criteria)',
    handler: async (_args, c) => {
      ctx = c
      enterPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
    },
  })

  pi.registerCommand('adx-spec', {
    description:
      'Enter spec mode (read-only brainstorming/research; writes a spec file, no build/verify/review). '
      + 'Optional .md path arg, e.g. /adx-spec SPEC.md (default: .pi/specs/<slug>.md)',
    handler: async (args, c) => {
      ctx = c
      if (specMode) {
        c.ui.notify('adx: already in spec mode (exit with /adx-approve or Ctrl+Alt+A)', 'info')
        return
      }
      const raw = (args ?? '').trim()
      if (raw) {
        // The path must be a single token and a valid .md location inside the
        // project — refuse immediately, before the user spends a session on it.
        if (raw.includes(' ')) {
          c.ui.notify('adx: usage: /adx-spec <path.md> (a single .md path inside the project)', 'warning')
          return
        }
        const problem = specPathError(c.cwd, raw)
        if (problem) {
          c.ui.notify(`adx: ${problem}`, 'warning')
          return
        }
      }
      if (planMode) void exitPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
      enterSpecMode((m, l) => c.ui.notify(m, l ?? 'info'), raw || undefined)
    },
  })

  // Approve the plan/spec: turn the plan/spec read-only mode off (build mode)
  // without launching a workflow.
  const approveHandler = async (_args: string, c: ExtensionCommandContext) => {
    ctx = c
    if (specMode) await exitSpecMode((m, l) => c.ui.notify(m, l ?? 'info'))
    else if (planMode) await exitPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
    else c.ui.notify('adx: already in build mode (plan mode is off)', 'info')
  }
  pi.registerCommand('adx-approve', {
    description: 'Approve the plan/spec: switch to build mode (turn plan/spec mode off) without launching a workflow',
    handler: approveHandler,
  })

  // Generic launcher: switch to build mode and launch a workflow — the
  // configured default one, or an explicit workflow id as the first token.
  const runHandler = async (args: string, c: ExtensionCommandContext) => {
    ctx = c
    await exitReadOnlyModes((m, l) => c.ui.notify(m, l ?? 'info'))
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
  }
  pi.registerCommand('adx-run', {
    description:
      'Switch to build mode and launch a workflow (default: the configured build one). Pass a workflow id as the first token, e.g. /adx-run pr-review pr_number=123',
    handler: runHandler,
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
    description: 'Toggle adx plan/spec mode (spec mode exits; plan mode enters/toggles)',
    handler: async (c) => {
      ctx = c
      if (specMode) await exitSpecMode((m, l) => c.ui.notify(m, l ?? 'info'))
      else if (planMode) await exitPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
      else enterPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
    },
  })

  // ------------------------------------------------------------------ events
  pi.on('session_start', async (event, c) => {
    ctx = c
    sessionId = c.sessionManager.getSessionId()
    // First run: give the user a ready-to-edit config file with the defaults.
    const created = ensureUserConfig()
    if (created) c.ui.notify(`adx: created default config at ${created} (edit to customize)`, 'info')
    config = loadConfig(c.cwd)

    if (event.reason === 'new' || event.reason === 'fork') {
      // /new or fork: a brand-new session starts 100% clean — no legacy
      // adoption, no execution restore, no plan/spec mode inherited from a
      // state file. The previous session's in-flight run (if any) stays in
      // ITS per-session state file and is picked up by re-resuming that
      // session. Config-driven entry (auto / defaultPlanMode) still applies.
      setLegacyAdoption(false)
      executor.resetForNewSession()
      // The closure (and the widget's mode badge) lives for the whole pi
      // process, so also drop the PREVIOUS session's in-memory mode state —
      // without this, /new after a plan/spec session would start the new
      // session still in read-only mode (prompt section + tool blocking +
      // footer badge all inherited).
      autoMode = false
      if (planMode || specMode) {
        const saved = planMode ? toolsBeforePlanMode : toolsBeforeSpecMode
        planMode = false
        specMode = false
        specPath = undefined
        toolsBeforePlanMode = undefined
        toolsBeforeSpecMode = undefined
        pendingModePersist = Promise.resolve()
        pi.setActiveTools(getBuildModeTools(saved ?? pi.getActiveTools()))
        showBadge(undefined)
      }
      if (pi.getFlag('adx-auto') === true || config.autoMode === true) {
        autoMode = true
        enterPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
      } else if (config.defaultPlanMode === true) {
        enterPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
      }
      return
    }

    // resume / startup / reload: restore this session's persisted state
    // (per-session file; a legacy in-flight run is adopted as a one-time
    // migration, resuming the plan/run from the last stop).
    setLegacyAdoption(true)
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
      // A finished run leaves planMode=false (the launch path persists it
      // before the first executor persist), so this only fires for a plan
      // that was genuinely left open — including a fresh plan started after
      // a previous run finished.
      enterPlanMode((m, l) => c.ui.notify(m, l ?? 'info'))
      c.ui.notify('adx: plan mode restored (unfinished plan from last stop — continue with flow_meta, then /adx-run)', 'info')
    } else if (state.specMode === true) {
      // The session was stopped mid-spec: restore spec mode (the spec file is
      // still pending — continue, then call spec_write once).
      enterSpecMode((m, l) => c.ui.notify(m, l ?? 'info'), state.specPath)
      c.ui.notify('adx: spec mode restored (unfinished spec from last stop — continue, then call spec_write once)', 'info')
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
    if (specMode) {
      sections['adx-spec'] = SPEC_PROMPT_SECTION.trim()
      delete sections['adx-plan']
      delete sections['adx-impl']
    } else if (planMode) {
      sections['adx-plan'] = (autoMode ? AUTO_PLANNER_PROMPT_SECTION : PLANNER_PROMPT_SECTION).trim()
      delete sections['adx-impl']
    } else if (executor.isActive()) {
      sections['adx-impl'] = BUILDER_PROMPT_SECTION.trim()
      delete sections['adx-plan']
    } else {
      delete sections['adx-plan']
      delete sections['adx-impl']
      delete sections['adx-spec']
    }
  })

  /** Plan/spec mode: guard code-executing tool calls (bash, ctx_execute, ctx_batch, codemode) against non-read-only operations. */
  pi.on('tool_call', (event) => {
    if (!(planMode || specMode)) return
    const args = (event.input ?? {}) as Record<string, unknown>
    let problem: string | undefined
    if (event.toolName === 'bash') {
      problem = planModeBashGuard(args, (msg) => ctx?.ui.notify(msg, 'warning'))
    } else if (CODE_EXEC_TOOLS.has(event.toolName)) {
      problem = planModeExecGuard(event.toolName, args, (msg) => ctx?.ui.notify(msg, 'warning'))
    }
    if (problem) {
      // Block the call and hand the reason back to the model as a tool result —
      // WITHOUT terminate: the turn continues so the model can adapt (simpler
      // read-only variant, another tool, or proceed with the plan). The mode
      // itself stays on; only this one call is refused.
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
