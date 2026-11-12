/**
 * adx-workflow: workflow definition types.
 *
 * Workflow schema types:
 * a workflow is a declarative state machine. Steps have ordered transitions
 * with conditions; the executor walks the graph until a terminal state
 * ($done or $blocked).
 */

// ============================================================================
// Workflow definition
// ============================================================================

export interface WorkflowParameter {
  id: string
  label: string
  description?: string
  position?: number
  required?: boolean
}

export interface WorkflowMetadata {
  id: string
  name: string
  description: string
  version: string
  color?: string
  parameters?: WorkflowParameter[]
}

export interface WorkflowSettings {
  /** Safety limit on total state-machine iterations (default 50) */
  maxIterations: number
}

export interface WorkflowDefinition {
  metadata: WorkflowMetadata
  /** ID of the first step to execute */
  entryStep: string
  /** Optional: `maxIterations` safety cap (default 50). Honest as optional —
   *  workflows without a `settings` block are valid and run with defaults. */
  settings?: WorkflowSettings
  /** Ordered for display; execution follows transitions, not array order */
  steps: WorkflowStep[]
  /** Condition that must be met before the workflow starts (default: always) */
  startCondition?: TransitionCondition
}

// ============================================================================
// Steps
// ============================================================================

export interface StepBase {
  /** Unique within this workflow */
  id: string
  /** Display name */
  name: string
  /** UI phase label ("build", "verification", …) */
  phase: string
  /** Evaluated in order; first match wins */
  transitions: Transition[]
}

/** Full in-session LLM turn: prompt injected, agent works, calls flow_step_done */
export interface AgentStep extends StepBase {
  type: 'agent'
  /** Agent prompt section to activate for this step ("planner" | "builder") */
  agentId?: string
  /** Injected as a user message on first entry. Supports template variables. */
  prompt?: string
  /** Injected when re-entering the step without a satisfied transition. */
  nudgePrompt?: string
}

/** Isolated sub-agent with fresh context (in-house `pi -p` child process) */
export interface SubAgentStep extends StepBase {
  type: 'sub_agent'
  /** e.g. "adx-verifier" or "adx-code-reviewer" (runtime-registered agent names) */
  subAgentType: string
  /** Injected as the child's task. Supports template variables. */
  prompt?: string
  /** Injected when nudging the sub-agent. Supports template variables. */
  nudgePrompt?: string
  /** Optional per-step model override (provider/model) for the child run —
   * e.g. a faster/cheaper model for verify/review. Precedes ADX_FLOW_MODEL. */
  model?: string
}

/** Run a shell command, branch on exit code */
export interface ShellStep extends StepBase {
  type: 'shell'
  /** Shell command to run. Supports template variables: {{workdir}}, etc. */
  command: string
  timeoutMs?: number
  /** Which exit codes count as success (default [0]) */
  successExitCodes?: number[]
}

/** Pause and wait for the user to pick a choice */
export interface UserStep extends StepBase {
  type: 'user'
}

export type WorkflowStep = AgentStep | SubAgentStep | ShellStep | UserStep

// ============================================================================
// Transitions
// ============================================================================

export interface Transition {
  when: TransitionCondition
  /** Step ID, or "$done" / "$blocked" for terminal states */
  goto: string
}

export type TransitionCondition =
  | { type: 'step_result'; result: string }
  | { type: 'metadata_all_match'; key: string; field: string; value: string }
  | { type: 'metadata_all_in'; key: string; field: string; values: string[] }
  /** Matches when the run was launched with `<key>=<value>` (e.g. `/adx-build-verify skip_review=true`) */
  | { type: 'param'; key: string; value: string }
  | { type: 'always' }

// ============================================================================
// Terminal state constants
// ============================================================================

export const TERMINAL_DONE = '$done'
export const TERMINAL_BLOCKED = '$blocked'

/**
 * A step outcome is what transitions branch on:
 * - agent: "completed" by default, or the `result` from flow_step_done
 * - sub_agent: "success" by default, or the child's result
 * - shell: "success" | "failure" from exit-code classification
 * - user: the chosen button label ("continue" for the always-transition button)
 */
export interface StepOutcome {
  result: string
  output: Record<string, string>
}
