/**
 * adx-workflow: workflow executor.
 *
 * State-machine executor for declarative workflows: walk a declarative state
 * machine (steps + ordered transitions with conditions) until a terminal
 * state ($done / $blocked).
 *
 * Mapping onto pi's conversational model:
 * - agent step    → the main session IS the agent. The executor injects the
 *   step prompt via pi.sendUserMessage(); the LLM works and calls the
 *   flow_step_done tool, which re-enters the executor (onStepDone).
 * - sub_agent step → in-house `pi -p` child-process spawn (isolated fresh session).
 * - shell step     → child_process.exec, branch on exit code.
 * - user step      → ctx.ui.select; choices derived from step_result
 *   transitions + a "Continue" button for the always transition.
 * - nudge re-entry → transition condition unmet → sendUserMessage(nudgePrompt).
 * - state persisted on every transition; /adx-resume re-enters the current step.
 */

import { exec } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type {
  AgentStep,
  ShellStep,
  SubAgentStep,
  UserStep,
  WorkflowDefinition,
  WorkflowStep,
  StepOutcome,
  TransitionCondition,
} from './types.js'
import { TERMINAL_DONE, TERMINAL_BLOCKED } from './types.js'
import {
  loadState,
  saveState,
  stateFileFor,
  metaConditionMet,
  pendingCriteriaCount,
  type FlowState,
  type ExecutionState,
} from './store.js'
import {
  resolveTemplate,
  formatCriteriaList,
  getModifiedFiles,
  projectHash,
  projectStats,
  type TemplateContext,
} from './templates.js'
import { loadWorkflow, parseLaunchParams } from './workflows.js'
import { spawnFlowAgent, resumeFlowAgent, type SpawnResult, type SpawnOptions } from './subagent.js'
import { refreshFlowWidget, setSubAgentActivity } from './widgets.js'
import type { StepDoneInfo } from './tools.js'

/**
 * Max consecutive auto-continues per step before the run blocks (safety
 * cap — mirrors the maxIterations philosophy).
 */
const AUTO_CONTINUE_CAP = 8

// ============================================================================
// Executor
// ============================================================================

export interface ExecutorDeps {
  pi: ExtensionAPI
  notify: (msg: string, level?: 'info' | 'warning' | 'error') => void
  /** Called after every state change so the TUI widget can refresh. */
  updateWidget?: () => void
  /** When it returns false, TUI widgets (flow widget, sub-agent activity) are suppressed (config `showWidget`). */
  widgetEnabled?: () => boolean
  /** Injectable spawner (e2e). Default: in-house `pi -p` child process. */
  spawn?: (
    agent: string,
    task: string,
    opts?: Omit<SpawnOptions, 'resume'>,
  ) => Promise<SpawnResult>
  /** Injectable never-stop resume (e2e). Default: re-spawn the persisted child session. */
  resume?: (
    agent: string,
    runId: string,
    message: string,
    opts?: Omit<SpawnOptions, 'resume'>,
  ) => Promise<SpawnResult>
}

function truncate(text: string, max = 10_000): string {
  return text.length > max ? text.slice(0, max) + '\n…(truncated)' : text
}

export class AdxExecutor {
  private cwd: string | undefined
  /** Pi session id of the driving session — the per-session state file key. */
  private sessionId: string | undefined
  private workflow: WorkflowDefinition | undefined
  private run: ExecutionState | undefined
  private lastCtx: ExtensionContext | undefined
  private spawn: (
    agent: string,
    task: string,
    opts?: Omit<SpawnOptions, 'resume'>,
  ) => Promise<SpawnResult>
  /** Never-stop child resume. Named `resumeRun` (not `resume`) so it does not
   * shadow the workflow `resume(ctx)` method. */
  private resumeRun: (
    agent: string,
    runId: string,
    message: string,
    opts?: Omit<SpawnOptions, 'resume'>,
  ) => Promise<SpawnResult>
  private deps: ExecutorDeps
  /** Set when the LLM calls flow_step_done in the current run (per agent-step turn). */
  private stepDoneCalled = false
  /** Set by resume(); the next agent step entered gets a neutral resume prompt. */
  private resumeReentry = false
  /** Consecutive auto-continues on the current step (reset on each step entry). */
  private autoContinueCount = 0
  /** Cached project size for {{projectLines}} / {{projectFileCount}} (refreshed on step entry). */
  private projectStatsCache: { lines: number; files: number } | undefined
  /** Last loaded FlowState (template context source: criteria list, counts). */
  private _lastState: FlowState | undefined

  constructor(deps: ExecutorDeps) {
    this.deps = deps
    this.spawn =
      deps.spawn ??
      ((agent, task, opts) => spawnFlowAgent(agent, task, { cwd: this.cwd ?? process.cwd(), ...opts }))
    this.resumeRun =
      deps.resume ??
      ((agent, runId, message, opts) =>
        resumeFlowAgent(agent, runId, message, { cwd: this.cwd ?? process.cwd(), ...opts }))
  }

  /** Child-process options: the parent's per-session state file (ADX_FLOW_STATE). */
  private childOpts() {
    return {
      cwd: this.cwd ?? process.cwd(),
      statePath: stateFileFor(this.cwd ?? process.cwd(), this.sessionId),
    }
  }

  /** Bind the driving pi session (its id keys the per-session state file). */
  private bindCtx(ctx: ExtensionContext): void {
    this.lastCtx = ctx
    this.cwd = ctx.cwd
    this.sessionId = ctx.sessionManager?.getSessionId?.()
  }

  // ------------------------------------------------------------------ queries
  isActive(): boolean {
    return (
      this.run !== undefined &&
      (this.run.status === 'running' || this.run.status === 'waiting')
    )
  }

  /**
   * Clear in-memory run state when the pi process switches to a brand-new
   * session (/new, fork): the previous session's run/workflow/sessionId must
   * not leak into the new one (builder prompt section, persist() target,
   * isActive() checks). Called from session_start (reason "new"/"fork")
   * before any restore; the new session's own state file is (by definition)
   * empty, so nothing is re-entered.
   */
  resetForNewSession(): void {
    this.run = undefined
    this.workflow = undefined
    this.sessionId = undefined
    this.cwd = undefined
    this.stepDoneCalled = false
    this.autoContinueCount = 0
    this.resumeReentry = false
    // Template-context caches: clear them too so no cross-session value can
    // surface before the new session's first persist refreshes them (all
    // readers are already guarded against undefined).
    this.lastCtx = undefined
    this.projectStatsCache = undefined
    this._lastState = undefined
    this.deps.updateWidget?.()
  }

  // ------------------------------------------------------------------ launch
  async launch(workflowId: string, ctx: ExtensionContext, rawArgs?: string): Promise<void> {
    this.bindCtx(ctx)

    const def = loadWorkflow(ctx.cwd, workflowId)
    if (!def) {
      this.deps.notify(`adx: workflow "${workflowId}" not found`, 'error')
      return
    }

    const params = parseLaunchParams(rawArgs)
    for (const p of def.metadata.parameters ?? []) {
      if (p.required && !params[p.id]) {
        this.deps.notify(`adx: missing required parameter "${p.id}" (${p.description ?? p.label})`, 'error')
        return
      }
    }

    // startCondition gate (metadata conditions only in this port)
    const state = await loadState(ctx.cwd, this.sessionId)
    if (def.startCondition && !this.matchesCondition(def.startCondition, { result: '', output: {} }, state)) {
      this.deps.notify(`adx: start condition for "${def.metadata.name}" not met`, 'warning')
      return
    }

    this.workflow = def
    this.run = {
      workflowId: def.metadata.id,
      workflowName: def.metadata.name,
      status: 'running',
      currentStep: def.entryStep,
      iteration: 0,
      lastStepOutput: {},
      lastStepResult: '',
      params,
      updatedAt: new Date().toISOString(),
    }
    state.execution = this.run
    await saveState(ctx.cwd, state, this.sessionId)

    this.deps.notify(`adx: starting workflow "${def.metadata.name}"`, 'info')
    await this.enterStep(def.entryStep)
  }

  // ------------------------------------------------------------------ resume / cancel / restore
  async resume(ctx: ExtensionContext): Promise<void> {
    this.bindCtx(ctx)
    const state = await loadState(ctx.cwd, this.sessionId)
    if (!state.execution) {
      this.deps.notify('adx: no workflow run to resume', 'info')
      return
    }
    const def = loadWorkflow(ctx.cwd, state.execution.workflowId)
    if (!def) {
      this.deps.notify(`adx: workflow "${state.execution.workflowId}" no longer available`, 'error')
      return
    }
    this.workflow = def
    this.run = state.execution
    if (this.run.status === 'done') {
      this.deps.notify('adx: last run already finished', 'info')
      return
    }
    this.run.status = 'running'
    // A resume gets a fresh iteration budget — otherwise a run blocked by
    // maxIterations re-blocks on the very next enterStep (iteration > cap).
    this.run.iteration = 0
    // Re-entering after a resume is NOT a failed transition: mark it so the
    // agent step injects a neutral resume prompt instead of the failure-flavored
    // nudgePrompt ("condition not met, fix the issues").
    this.resumeReentry = true
    this.deps.notify(`adx: resuming "${this.run.workflowName}" at step "${this.run.currentStep}"`, 'info')
    await this.enterStep(this.run.currentStep)
  }

  async cancel(ctx: ExtensionContext): Promise<void> {
    this.bindCtx(ctx)
    if (!this.run) {
      this.deps.notify('adx: no active workflow run', 'info')
      return
    }
    const name = this.run.workflowName
    this.run = undefined
    this.workflow = undefined
    const state = await loadState(ctx.cwd, this.sessionId)
    state.execution = null
    await saveState(ctx.cwd, state, this.sessionId)
    this.deps.updateWidget?.()
    this.deps.notify(`adx: cancelled run "${name}"`, 'info')
  }

  /** Restore a persisted run after pi restarts (called from session_start). */
  async restore(state: FlowState, ctx: ExtensionContext): Promise<void> {
    this.bindCtx(ctx)
    const execution = state.execution
    if (!execution) return
    const def = loadWorkflow(ctx.cwd, execution.workflowId)
    if (!def) {
      this.deps.notify(`adx: workflow "${execution.workflowId}" no longer available`, 'error')
      return
    }
    this.workflow = def
    this.run = execution
    if (execution.status === 'done') {
      this.deps.updateWidget?.()
      return
    }
    if (execution.status === 'blocked') {
      this.deps.notify(
        `adx: run "${execution.workflowName}" is blocked at step "${execution.currentStep}" — use /adx-resume to continue`,
        'warning',
      )
      this.deps.updateWidget?.()
      return
    }
    // running / waiting: re-enter the current step
    this.deps.notify(`adx: re-entering step "${execution.currentStep}" of "${execution.workflowName}"`, 'info')
    await this.enterStep(execution.currentStep)
  }

  async showStatus(ctx: ExtensionContext): Promise<void> {
    this.bindCtx(ctx)
    if (!this.run || !this.workflow) {
      const state = await loadState(ctx.cwd, this.sessionId)
      if (!state.execution) {
        this.deps.notify('adx: no workflow run (start with /adx-run)', 'info')
        return
      }
      this.run = state.execution
      this.workflow = loadWorkflow(ctx.cwd, state.execution.workflowId)
    }
    const criteria = (await loadState(ctx.cwd, this.sessionId)).metadata['criteria'] ?? []
    const findings = (await loadState(ctx.cwd, this.sessionId)).metadata['review_findings'] ?? []
    const lines = [
      `workflow: ${this.run.workflowName}`,
      `status:   ${this.run.status}`,
      `step:     ${this.run.currentStep} (iteration ${this.run.iteration})`,
      `criteria: ${criteria.length} total — ${
        criteria.filter((c) => c.status === 'passed').length
      } passed, ${criteria.filter((c) => c.status === 'completed').length} completed, ${
        criteria.filter((c) => c.status === 'failed').length
      } failed`,
      `findings: ${findings.filter((f) => f.status === 'open').length} open`,
    ]
    this.deps.notify(lines.join('\n'), 'info')
  }

  // ------------------------------------------------------------------ step entry
  private async enterStep(stepId: string): Promise<void> {
    if (!this.run || !this.workflow || !this.cwd) return
    const step = this.workflow.steps.find((s) => s.id === stepId)
    if (!step) {
      await this.block(`Unknown step "${stepId}"`)
      return
    }

    // Re-entry detection (re-entering a step without a
    // satisfied transition injects the nudge prompt instead of the prompt).
    const seen = this.run.seenSteps ?? []
    const isReentry = seen.includes(step.id)
    if (!isReentry) {
      this.run.seenSteps = [...seen, step.id]
    }

    this.run.currentStep = step.id
    this.run.iteration += 1
    this.run.updatedAt = new Date().toISOString()
    this.stepDoneCalled = false
    this.autoContinueCount = 0

    const maxIterations = this.workflow.settings?.maxIterations ?? 50
    if (this.run.iteration > maxIterations) {
      await this.block(`maxIterations (${maxIterations}) reached at step "${step.id}"`)
      return
    }
    await this.persist()
    this.deps.updateWidget?.()
    // Refresh the size stats so verify prompts can keep the effort proportional.
    this.projectStatsCache = projectStats(this.cwd)

    switch (step.type) {
      case 'user':
        this.resumeReentry = false
        await this.runUserStep(step)
        break
      case 'shell':
        this.resumeReentry = false
        await this.runShellStep(step)
        break
      case 'sub_agent':
        this.resumeReentry = false
        await this.runSubAgentStep(step, isReentry)
        break
      case 'agent':
        this.runAgentStep(step, isReentry)
        break
    }
  }

  // ------------------------------------------------------------------ step runners
  private userStepChoices(step: UserStep): string[] {
    const choices = step.transitions
      .filter((t) => t.when.type === 'step_result')
      .map((t) => (t.when.type === 'step_result' ? t.when.result : ''))
    if (step.transitions.some((t) => t.when.type === 'always')) choices.push('Continue')
    return choices
  }

  private async runUserStep(step: UserStep): Promise<void> {
    if (!this.run) return
    const ctx = this.lastCtx
    if (!ctx) {
      await this.block('no UI context for user step')
      return
    }
    // Auto-skip: a matching param transition takes the step without user
    // input (e.g. `auto=true` skips the "Where to work" picker in auto mode).
    const autoState = await loadState(this.cwd ?? process.cwd(), this.sessionId)
    const auto = step.transitions.find(
      (t) => t.when.type === 'param' && this.matchesCondition(t.when, { result: '', output: {} }, autoState),
    )
    if (auto && auto.when.type === 'param') {
      this.run.lastStepOutput = { content: `auto: ${auto.when.key}=${auto.when.value}` }
      this.run.lastStepResult = 'auto'
      this.run.updatedAt = new Date().toISOString()
      await this.persist()
      this.deps.notify(`adx: auto-skipping user step "${step.name}" (${auto.when.key}=${auto.when.value})`, 'info')
      await this.enterStep(auto.goto)
      return
    }
    const choices = this.userStepChoices(step)
    this.run.status = 'waiting'
    await this.persist()
    this.deps.updateWidget?.()

    // Non-interactive mode (print/json, ctx.hasUI === false): a user step
    // needs a dialog-capable UI. The run stays "waiting" (resumable via
    // /adx-resume from a TUI/RPC session).
    if (!ctx.hasUI) {
      this.deps.notify(
        `adx: user step "${step.name}" needs an interactive UI — resume it with /adx-resume in a TUI/RPC session`,
        'info',
      )
      this.deps.updateWidget?.()
      return
    }

    const choice = await ctx.ui.select(`adx: ${step.name}`, choices)
    if (choice === undefined) {
      // User dismissed the prompt: stay waiting (resumable via /adx-resume)
      this.deps.notify('adx: step paused — use /adx-resume to continue', 'info')
      this.deps.updateWidget?.()
      return
    }
    this.run.status = 'running'
    const outcome: StepOutcome = { result: choice, output: {} }
    await this.advance(step, outcome)
  }

  private async runShellStep(step: ShellStep): Promise<void> {
    if (!this.run || !this.cwd) return
    const command = resolveTemplate(step.command, this.templateContext())
    const timeoutMs = step.timeoutMs ?? 60_000
    this.deps.notify(`adx: running shell step "${step.name}"`, 'info')

    const { stdout, stderr, code } = await execInDir(command, this.cwd, timeoutMs)
    const success = (step.successExitCodes ?? [0]).includes(code ?? -1)
    const outcome: StepOutcome = {
      result: success ? 'success' : 'failure',
      output: {
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        exitCode: String(code ?? -1),
      },
    }
    await this.advance(step, outcome)
  }

  private async runSubAgentStep(step: SubAgentStep, isReentry: boolean): Promise<void> {
    if (!this.run || !this.cwd) return
    const reportsDir = join(this.cwd, '.pi', 'adx-flow', 'reports')
    await mkdir(reportsDir, { recursive: true })
    const reportFile = join(reportsDir, `${step.subAgentType}.md`)
    const baseTask = step.prompt
      ? resolveTemplate(step.prompt, this.templateContext())
      : 'Perform your task.'
    const task =
      (isReentry && step.nudgePrompt
        ? resolveTemplate(step.nudgePrompt, this.templateContext())
        : baseTask) +
      `\n\nWrite your final report (what you did, results, findings) to this file: ${reportFile}`

    this.deps.notify(`adx: running sub-agent "${step.subAgentType}" (isolated context)…`, 'info')
    // Fresh run → reset the display-only progress feed so stale notes from a
    // previous run of this step don't mislead the live widget.
    {
      const state = await loadState(this.cwd, this.sessionId)
      if (state.metadata['progress']) {
        delete state.metadata['progress']
        await saveState(this.cwd, state, this.sessionId)
      }
    }
    // Re-verification short-circuit: if this verifier step already ran
    // successfully, the project files are UNCHANGED since, and the step's
    // metadata gate is NOW met (e.g. the store caught up after a lost write),
    // skip the expensive re-run and advance with the previous report. Without
    // this, a single small-file project can pay 3-4 full verifier passes just
    // to re-converge on the same verdict.
    if (isReentry && step.subAgentType === 'adx-verifier') {
      const prev = this.run.lastSubAgentStep
      if (prev && prev.ok && prev.stepId === step.id && prev.hash) {
        const hash = projectHash(this.cwd)
        if (hash === prev.hash) {
          const stateNow = await loadState(this.cwd, this.sessionId)
          const gateMet = step.transitions.some(
            (t) =>
              (t.when.type === 'metadata_all_match' || t.when.type === 'metadata_all_in') &&
              metaConditionMet(stateNow, t.when),
          )
          if (gateMet) {
            let content = ''
            try {
              content = await readFile(reportFile, 'utf8')
            } catch {
              /* no previous report */
            }
            this.deps.notify(
              'adx: verifier re-run skipped — code unchanged since the last pass and the gate is met',
              'info',
            )
            const outcome: StepOutcome = { result: 'success', output: { content } }
            await this.advance(step, outcome)
            return
          }
        }
      }
    }
    // Animated activity widget: spinner + agent/step + live elapsed time +
    // task summary + live criteria checklist + progress line, so the idle TUI
    // shows the child is working (minutes-long sub-agent runs). Restored by
    // refreshFlowWidget() below.
    const activityCtx = this.lastCtx
    if (activityCtx && this.deps.widgetEnabled?.() !== false) {
      setSubAgentActivity(
        activityCtx,
        {
          agent: step.subAgentType,
          step: step.name,
          task: baseTask,
          startedAt: Date.now(),
        },
        this.sessionId,
      )
    }
    const spawnOpts: Omit<import('./subagent.js').SpawnOptions, 'resume'> = {
      ...this.childOpts(),
      ...(step.model ? { model: step.model } : {}),
    }
    let result = await this.spawn(step.subAgentType, task, spawnOpts)

    // Transient busy: the child session was still streaming when the task
    // prompt was injected ("Agent is already processing"). It will go idle
    // shortly — retry with backoff before giving up.
    const isBusy = (r: { ok: boolean; error?: string }) =>
      !r.ok && (r.error ?? '').includes('already processing')
    for (let attempt = 1; attempt <= 3 && isBusy(result); attempt++) {
      const delayMs = 5_000 * attempt
      this.deps.notify(
        `adx: sub-agent "${step.subAgentType}" busy — retrying in ${delayMs / 1000}s (attempt ${attempt}/3)`,
        'info',
      )
      await new Promise((r) => setTimeout(r, delayMs))
      result = await this.spawn(step.subAgentType, task, spawnOpts)
    }

    // Never-stop: if the child stopped/died (e.g. context pressure, timeout)
    // and we know its run id, revive it once with a continue instruction.
    if (!result.ok && result.runId) {
      this.deps.notify(`adx: sub-agent "${step.subAgentType}" stopped — resuming it…`, 'info')
      result = await this.resumeRun(
        step.subAgentType,
        result.runId,
        'Continue from where you stopped. Finish the task, complete any flow_meta updates, and write the final report to the report file named in your original task. Do not repeat work already done.',
        spawnOpts,
      )
    }

    // Record the run for the re-verification short-circuit: the code hash at
    // the moment of a successful verify lets a later re-entry skip the
    // expensive re-run when nothing in the project has changed.
    if (result.ok) {
      this.run.lastSubAgentStep = {
        stepId: step.id,
        ok: true,
        hash: projectHash(this.cwd),
        at: new Date().toISOString(),
      }
    }

    // The child may have updated the shared store (criteria / review_findings)
    let content = ''
    try {
      content = await readFile(reportFile, 'utf8')
    } catch {
      /* no report written */
    }
    // Child is done: restore the static criteria/step widget (also picks up
    // the child's flow_meta updates) now that the animated activity widget
    // is no longer needed.
    if (this.lastCtx && this.deps.widgetEnabled?.() !== false) refreshFlowWidget(this.lastCtx, this.sessionId)
    const outcome: StepOutcome = result.ok
      ? { result: 'success', output: { content } }
      : { result: 'error', output: { content: content || `sub-agent error: ${result.error}` } }
    await this.advance(step, outcome)
  }

  private runAgentStep(step: AgentStep, isReentry: boolean): void {
    if (!this.run) return
    this.run.status = 'running'
    const base = step.prompt
      ? resolveTemplate(step.prompt, this.templateContext())
      : 'Proceed with the current step.'
    let prompt:
      string
    if (this.resumeReentry) {
      // Neutral re-entry: the run was blocked/stopped and resumed — no
      // transition failed. Tell the LLM to re-read the shared state and
      // continue, instead of a failure-flavored nudge.
      this.resumeReentry = false
      prompt =
        `The adx workflow "${this.run.workflowName}" was resumed at step "${step.name}" (the previous run was blocked or stopped; no transition failed). ` +
        `Re-read the current state with flow_meta (key "criteria" and any other keys you need), continue the step from where it left off, and do not redo work that is already done.`
    } else {
      prompt =
        (isReentry && step.nudgePrompt
          ? resolveTemplate(step.nudgePrompt, this.templateContext())
          : base)
    }
    prompt +=
      '\n\nOnce you are done, call flow_step_done.' +
      '\nSub-agent steps (verify / code review) run automatically — do NOT spawn, resume or manage subagents yourself (no `subagent` tool calls); if a criterion fails verification, fix the code and call flow_step_done so the verifier re-runs.'
    this.deps.notify(`adx: step "${step.name}" — working…`, 'info')
    // followUp: if the session is still busy when we enter the step (e.g. the
    // previous turn is still streaming when flow_step_done fires), the prompt
    // is queued and delivered as a fresh turn once the agent stops. When idle
    // it starts immediately.
    this.deps.pi.sendUserMessage(prompt, { deliverAs: 'followUp' })
    // The turn ends when the LLM calls flow_step_done → onStepDone()
  }

  // ------------------------------------------------------------------ flow_step_done
  /** Called by the flow_step_done tool before onStepDone (marks the turn as step-complete). */
  markStepDoneCalled(): void {
    this.stepDoneCalled = true
  }

  async onStepDone(info: StepDoneInfo): Promise<void> {
    if (!this.run || !this.workflow || !this.cwd) return
    if (this.run.status !== 'running') return
    const step = this.workflow.steps.find((s) => s.id === this.run!.currentStep)
    if (!step || step.type !== 'agent') return

    const outcome: StepOutcome = {
      result: info.result ?? 'completed',
      output: {
        ...(info.content !== undefined ? { content: info.content } : {}),
        stepDoneCalled: 'true',
      },
    }

    const state = await loadState(this.cwd, this.sessionId)
    if (await this.runTransitions(step, outcome, state)) return

    // Condition unmet → nudge re-entry
    const nudge = step.nudgePrompt
      ? resolveTemplate(step.nudgePrompt, this.templateContext())
      : `The step transition condition is not met yet (${this.reasonFor(step)}). Keep working on the current step.`
    this.deps.notify('adx: step condition not met — nudging to continue', 'info')
    // steer: the nudge fires mid-run (right after the flow_step_done tool
    // call); deliver it before the next LLM call so the LLM keeps working on
    // the same step within the current run.
    this.deps.pi.sendUserMessage(
      nudge + '\n\nOnce you are done, call flow_step_done.',
      { deliverAs: 'steer' },
    )
  }

  // ------------------------------------------------------------------ auto-continue (never stop)
  /**
   * Never-stop auto-continuation: when the agent's run ends on an active
   * agent step without calling flow_step_done (context pressure, stream
   * stop, model deciding to pause…), the executor appends a continuation
   * message and requests one more provider request — the user never has to
   * press "continue".
   *
   * Returns the continuation message (to append as a custom_message entry
   * with continue: true), or undefined when no continuation is needed.
   */
  async autoContinue(): Promise<{ message: string } | undefined> {
    if (!this.run || !this.workflow || !this.cwd) return undefined
    if (this.run.status !== 'running') return undefined
    if (this.stepDoneCalled) return undefined
    const step = this.workflow.steps.find((s) => s.id === this.run!.currentStep)
    if (!step || step.type !== 'agent') return undefined

    if (this.autoContinueCount >= AUTO_CONTINUE_CAP) {
      await this.block(
        `auto-continue cap (${AUTO_CONTINUE_CAP}) reached on step "${step.id}" — /adx-resume to continue`,
      )
      return undefined
    }

    const state = await loadState(this.cwd, this.sessionId)
    const criteriaList = formatCriteriaList(state.metadata['criteria'] ?? [])
    const resumeNotes = state.metadata['resume'] ?? []
    const resumeNote =
      resumeNotes.length > 0 ? resumeNotes[resumeNotes.length - 1]!.description : undefined

    const message =
      `Continue the current adx workflow step "${step.name}" from where you stopped — do not repeat work already done.` +
      (resumeNote ? `\n\nResume note: ${resumeNote}` : '') +
      `\n\nCriteria status:\n${criteriaList}` +
      `\n\n${this.reasonFor(step)}. When the step is fully complete, call flow_step_done.`

    this.autoContinueCount += 1
    this.run.updatedAt = new Date().toISOString()
    this._lastState = state
    await this.persist()
    this.deps.updateWidget?.()
    this.deps.notify(
      `adx: auto-continue #${this.autoContinueCount} on step "${step.id}" (${this.reasonFor(step)})`,
      'info',
    )
    return { message }
  }

  // ------------------------------------------------------------------ transitions
  /**
   * Iterate a step's ordered transitions (first match wins), performing the
   * shared bookkeeping and goto (incl. the terminal $done / $blocked). Returns
   * true when a transition matched, so callers can apply their own no-match
   * behavior: onStepDone nudges a re-entry, advance blocks the run.
   */
  private async runTransitions(
    step: WorkflowStep,
    outcome: StepOutcome,
    state: FlowState,
  ): Promise<boolean> {
    const run = this.run
    if (!run || !this.cwd) return false
    for (let i = 0; i < step.transitions.length; i++) {
      const t = step.transitions[i]!
      if (!this.matchesCondition(t.when, outcome, state)) continue
      // Falling through to the "always" fallback means every specific gate
      // was unmet — remember WHY so the next nudge is actionable.
      run.lastNudgeReason =
        t.when.type === 'always' ? this.unmetGateReason(step, state) : undefined
      run.lastStepOutput = outcome.output
      run.lastStepResult = outcome.result
      run.updatedAt = new Date().toISOString()
      if (t.goto === TERMINAL_DONE) {
        await this.persist()
        await this.finish('done')
        return true
      }
      if (t.goto === TERMINAL_BLOCKED) {
        await this.persist()
        await this.finish('blocked')
        return true
      }
      await this.persist()
      await this.enterStep(t.goto)
      return true
    }
    return false
  }

  private async advance(step: WorkflowStep, outcome: StepOutcome): Promise<void> {
    if (!this.run || !this.cwd) return
    const state = await loadState(this.cwd, this.sessionId)
    if (await this.runTransitions(step, outcome, state)) return
    await this.block(`No matching transition for step "${step.id}" (result: ${outcome.result})`)
  }

  private matchesCondition(
    condition: TransitionCondition,
    outcome: StepOutcome,
    state: FlowState,
  ): boolean {
    switch (condition.type) {
      case 'step_result':
        return outcome.result === condition.result
      case 'metadata_all_match':
      case 'metadata_all_in':
        return metaConditionMet(state, condition)
      case 'param':
        return this.run?.params?.[condition.key] === condition.value
      case 'always':
        return true
    }
  }

  /**
   * Why the LAST gate fell through to an "always" fallback (persisted on the
   * run, shown in the next nudge prompt). Replaces the opaque
   * "transition condition not met" with an actionable reason like
   * "10 criteria not yet passed".
   */
  private unmetGateReason(step: WorkflowStep, state: FlowState): string | undefined {
    for (const t of step.transitions) {
      const w = t.when
      if (w.type !== 'metadata_all_match' && w.type !== 'metadata_all_in') continue
      if (metaConditionMet(state, w)) continue // satisfied — not the blocker
      const entries = state.metadata[w.key] ?? []
      const unmet =
        w.type === 'metadata_all_match'
          ? entries.filter((e) => e[w.field] !== w.value).length
          : entries.filter((e) => !w.values.includes(e[w.field] as string)).length
      const accepted = w.type === 'metadata_all_match' ? w.value : w.values.join(' / ')
      if (w.key === 'criteria') return `${unmet} criteria not yet ${accepted}`
      if (w.key === 'review_findings') return `${unmet} review findings not yet ${accepted}`
      return `${unmet} "${w.key}" items do not match the gate`
    }
    return undefined
  }

  private reasonFor(step: WorkflowStep): string {
    if (this.run?.lastNudgeReason) return this.run.lastNudgeReason
    const state = this._lastState
    if (!state) return 'condition not met'
    const transitions = step.transitions ?? []
    const onCriteria = transitions.some(
      (t) => t.when.type === 'metadata_all_match' || t.when.type === 'metadata_all_in' ? t.when.key === 'criteria' : false,
    )
    if (step.id === 'build' || onCriteria) {
      // Count only the criteria that block THIS step's gate (statuses outside
      // the gate's accepted values). During "build" that is the "pending"
      // ones only — "passed" is set later by the verifier, so counting
      // non-passed criteria here would report a number that can never reach
      // zero in-step (stale "N criteria remaining" nudge loop).
      const gate = transitions.find(
        (t) =>
          (t.when.type === 'metadata_all_match' || t.when.type === 'metadata_all_in') &&
          t.when.key === 'criteria',
      )
      if (gate && (gate.when.type === 'metadata_all_match' || gate.when.type === 'metadata_all_in')) {
        const accepted =
          gate.when.type === 'metadata_all_match' ? [gate.when.value] : gate.when.values
        const entries = state.metadata['criteria'] ?? []
        const blocking = entries.filter((e) => !accepted.includes(e.status))
        if (blocking.length > 0)
          return `${blocking.length} criteria not yet ${accepted.join(' / ')}`
      } else {
        const pending = pendingCriteriaCount(state)
        if (pending > 0) return `${pending} criteria remaining`
      }
    }
    const onFindings = transitions.some(
      (t) => t.when.type === 'metadata_all_match' || t.when.type === 'metadata_all_in' ? t.when.key === 'review_findings' : false,
    )
    if (onFindings) {
      const open = (state.metadata['review_findings'] ?? []).filter((f) => f.status === 'open').length
      if (open > 0) return `${open} review findings still open`
    }
    return 'transition condition not met'
  }

  private async finish(status: 'done' | 'blocked'): Promise<void> {
    if (!this.run) return
    this.run.status = status
    this.run.updatedAt = new Date().toISOString()
    await this.persist()
    this.deps.updateWidget?.()
    if (status === 'done') {
      this.deps.notify(`adx: workflow "${this.run.workflowName}" finished ✅`, 'info')
    } else {
      this.deps.notify(
        `adx: workflow "${this.run.workflowName}" blocked at step "${this.run.currentStep}" — fix and /adx-resume`,
        'warning',
      )
    }
  }

  private async block(reason: string): Promise<void> {
    if (!this.run) return
    this.run.status = 'blocked'
    this.run.updatedAt = new Date().toISOString()
    await this.persist()
    this.deps.updateWidget?.()
    this.deps.notify(`adx: blocked — ${reason} (use /adx-resume to continue)`, 'warning')
  }

  private async persist(): Promise<void> {
    if (!this.run || !this.cwd) return
    const state = await loadState(this.cwd, this.sessionId)
    state.execution = this.run
    this._lastState = state
    await saveState(this.cwd, state, this.sessionId)
  }

  private templateContext(): TemplateContext {
    const state = this._lastState
    const cwd = this.cwd ?? process.cwd()
    const run = this.run
    const currentStep = run
      ? this.workflow?.steps.find((s) => s.id === run.currentStep)
      : undefined
    return {
      workdir: cwd,
      reason: currentStep ? this.reasonFor(currentStep) : '',
      criteriaCount: state?.metadata['criteria']?.length ?? 0,
      pendingCount: state ? pendingCriteriaCount(state) : 0,
      criteriaList: formatCriteriaList(state?.metadata['criteria'] ?? []),
      modifiedFiles: getModifiedFiles(cwd),
      projectLines: this.projectStatsCache?.lines ?? 0,
      projectFileCount: this.projectStatsCache?.files ?? 0,
      stepOutput: run?.lastStepOutput ?? {},
      params: run?.params ?? {},
    }
  }
}

// ============================================================================
// helpers
// ============================================================================

function execInDir(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      // Branch on the failure KIND so successExitCodes / failure transitions
      // can tell the cases apart (previously everything collapsed to 1):
      //   timeout kill  → -1, missing binary (ENOENT) → -2, real exit → its
      //   numeric code, other spawn failures → 1. The reason is appended to
      //   stderr so nudges can act on it.
      let code: number
      let reason: string | undefined
      if (!error) {
        code = 0
      } else {
        const e = error as { code?: string | number; killed?: boolean; message?: string }
        if (e.killed) {
          code = -1
          reason = `timed out after ${timeoutMs}ms`
        } else if (e.code === 'ENOENT') {
          code = -2
          reason = 'command not found (ENOENT)'
        } else if (typeof e.code === 'number') {
          code = e.code
          reason = `exit code ${code}`
        } else {
          code = 1
          reason = e.message ?? `spawn failed (${String(e.code)})`
        }
      }
      resolve({
        stdout: stdout ?? '',
        stderr: reason ? `${stderr ?? ''}\n[adx] shell step failed: ${reason}` : (stderr ?? ''),
        code,
      })
    })
  })
}
