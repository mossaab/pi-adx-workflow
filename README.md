# pi-adx-workflow

**plan → build/verify → review → summarize** workflow for
[pi-coding-agent](https://github.com/badri/pi), built as a pi extension with
**in-house sub-agent propagation**: flow children (verifier / code reviewer)
run as isolated `pi -p` child processes — no pi-subagents dependency.

It reproduces the core working method:

1. **Plan mode** (read-only) — the planner explores and proposes **acceptance
   criteria** (`flow_meta`, key `criteria`, status `pending`).
2. **Build mode** — you approve, then `/adx-build` starts the workflow:
   the builder implements and marks criteria `completed`.
3. **Verify loop** — an isolated **verifier** sub-agent (fresh `pi -p` child
   session) checks each criterion and sets `passed`/`failed`. Failures
   send the builder back with a nudge carrying the verifier's findings.
4. **Code review** — an isolated **code reviewer** sub-agent reviews the git
   diff and raises `review_findings`.
5. **Finalize loop** — the builder must resolve or dismiss every finding.
6. **Summarize** — final report + a "What to test" mini-tutorial.

The whole run is a declarative state machine: steps, ordered transitions,
metadata conditions, nudge re-entry, `maxIterations` safety cap,
`$blocked` handling, and persistence/resume.

## Requirements

- pi-coding-agent (the `pi` CLI is resolved from `~/.pi/agent/bin/pi`,
  `ADX_PI_BIN`, or `PATH`)

pi-subagents is **not** required: children are plain `pi -p` processes that
load only this extension (child mode), so there is no retained-child state
and no "Agent is already processing" jams.

## Install

The repo is already symlinked as a global pi extension:

```sh
ls -l ~/.pi/agent/extensions/adx-workflow
# -> ~/projects/pi-adx-workflow
```

If you move the repo, re-create the symlink:

```sh
ln -sfn ~/projects/pi-adx-workflow ~/.pi/agent/extensions/adx-workflow
```

No build step: pi loads `src/index.ts` through jiti. Dependencies
(`typebox`, `@earendil-works/pi-ai`) resolve from the pi install's
`node_modules` (a symlink is provided in this repo).

## Usage

```
/adx-plan                    enter plan mode (read-only)
/adx-build                   switch to build mode + launch the simple build workflow (no verify/review)
/adx-build-verify            switch to build mode + launch the full build-verify workflow
/adx-build-verify skip_review=true   full workflow minus the code review step
/adx-status                  show current workflow state
/adx-resume                  resume a blocked/waiting workflow
/adx-cancel                  cancel the current run
Ctrl+Alt+A                   toggle plan mode
```

### Auto mode (unattended pipeline)

```
pi --adx-auto "Add a dark mode toggle: - toggle in settings, - persist to localStorage, - follow system preference"
```

`--adx-auto` runs the whole pipeline without any approval:

1. **Plan** — the planner refines the acceptance points you provided into
   final criteria (no questions, no validation step) and adds them to the store.
2. **Build** — plan mode exits automatically and the build-verify workflow
   launches (user steps like the work-location picker are auto-skipped).
3. **Verify → recap** — the verifier checks the criteria, then the summary
   with "What to test" is printed. The code review step is skipped in auto
   mode; use `/adx-build-verify` for the full pipeline with review.

Manual mode (`/adx-plan` + `/adx-build` / `/adx-build-verify`) is unchanged.
When the planner finishes in interactive mode it calls `flow_plan_done`, which
shows a picker: **Build + verify (full pipeline)** / **Build (simple)** /
**Choose workspace** (current workspace or fresh worktree, then the pipeline).

Typical session:

1. `/adx-plan`
2. Ask for a feature: *"Add a dark mode toggle. Use flow_meta to define the
   acceptance criteria."* — the planner explores (read-only) and adds
   criteria. Review them in the widget (or edit with `flow_meta`).
3. `/adx-build` (quick: `build → summarize`) or `/adx-build-verify`
   (full: `work_location → build → verify → code_review → finalize → summarize`).
   The widget tracks step, iteration, and criterion status; the footer shows
   a compact status line.
4. When a criterion fails verification, the builder is nudged with the
   verifier's findings and re-enters `build` until everything is `passed`.
5. The reviewer's findings are dispositioned in `finalize`, then the summary
   with "What to test" is printed.

State lives in `.pi/adx-flow/state.json` (criteria, findings, execution
state). It survives pi restarts — `session_start` restores a running run, and
`/adx-resume` continues a blocked one.

## Never-stop (auto-continue)

The workflow never parks itself on you:

- **Agent steps**: when a run ends on an active agent step without
  `flow_step_done` (context pressure, stream stop, the model pausing
  mid-reflection), the `agent_before_settle` hook appends a continuation
  message — carrying the agent's **resume note** (written with `flow_meta`,
  key `resume`), the criteria status, and the step reason — and requests one
  more provider request. You never press "continue" (auto-continue /
  `CONTINUE_PROMPT` behavior).
- **Context overflow**: pi's built-in auto-compaction keeps the context
  usable between turns; the continuation message is what re-anchors the
  agent after a compaction.
- **Sub-agents**: if an isolated verifier/reviewer child stops before
  finishing (context pressure, timeout) and its run id is known, the executor
  revives it once by re-spawning the persisted child session
  (`pi -p --session <runId>` + "continue from where you stopped").
- **Safety**: 8 consecutive auto-continues on one step → the run blocks
  (`/adx-resume`); `maxIterations` caps the whole run. Explicit user aborts
  (Escape) are respected — `/adx-resume` continues from the persisted step.
- **Boot**: after a pi restart, `session_start` re-enters the current step of
  any running run (boot auto-continuation).

## Tools

| Tool | Purpose |
| --- | --- |
| `flow_meta` | CRUD for `criteria` / `todos` / `review_findings` / `resume` (shared workflow metadata store) |
| `flow_step_done` | Ends the current workflow step; the executor evaluates transitions and injects the next prompt (or a nudge) |

## Sub-agents

Flow children are spawned **in-house** as isolated `pi -p` child processes
(`src/subagent.ts`), not through pi-subagents:

```
pi -p --mode json --extension <adx-workflow> --no-extensions --no-mcp --no-skills
    --tools "read,bash,flow_meta" --session-dir <cwd>/.pi/adx-flow/sessions
    --session-id <runId>            (fresh run)  |  --session <runId> (resume)
    --append-system-prompt <agent role>
    "<task>"
```

| Agent | Role |
| --- | --- |
| `adx-verifier` | Independent criterion verification; sets `passed`/`failed` via `flow_meta` |
| `adx-code-reviewer` | Reviews the git diff; manages `review_findings` via `flow_meta` |

- **Fresh session per run** (session files in `.pi/adx-flow/sessions/`) → no
  retained in-process agent state → the "Agent is already processing" failure
  class (stuck retained child blocking all subsequent spawns) is
  structurally impossible.
- **Child mode** (`ADX_CHILD=1`): the child loads the extension with only the
  `flow_meta` tool registered — no executor/commands/widgets, so the child can
  update the shared store but never advance the workflow itself.
- **Bounded failures**: a 15-minute timeout kills the child process group;
  provider hangs are recovered by the never-stop resume (persisted session).
- **Result contract**: the child updates `flow_meta` (criteria /
  review_findings) and writes a report to `.pi/adx-flow/reports/<agent>.md`.
- **Model**: children use the user's default model; set `ADX_FLOW_MODEL`
  (e.g. `litellm/qwen3.8-27b`) to pin a cheaper model for flow children.
- **Env overrides**: `ADX_PI_BIN` (pi CLI path), `ADX_EXTENSION_PATH`
  (extension entry for the child).

## Workflows

Workflow files are plain JSON state machines: `workflows/*.workflow.json`
(bundled), overridable per project in `.pi/adx-workflows/` (highest
precedence) and per user in `~/.pi/agent/workflows/`.

- `build-verify` — the default pipeline (above)
- `pr-review` — PR review + fixes + squash-merge (requires `gh`), launched
  with `pr_number`

### Authoring reference (short)

- **Steps**: `agent` (in-session LLM turn; must end with `flow_step_done`),
  `sub_agent` (isolated child by `subAgentType`), `shell` (branch on exit
  code), `user` (pause; buttons derived from `step_result` transitions + a
  `Continue` for the `always` transition).
- **Transitions**: ordered, first match wins. Conditions: `step_result`,
  `metadata_all_match`, `metadata_all_in` (empty list ⇒ true), `always`.
  `goto` targets a step id, `$done`, or `$blocked`.
- **Templates**: `{{workdir}}`, `{{reason}}`, `{{criteriaCount}}`,
  `{{pendingCount}}`, `{{criteriaList}}`, `{{modifiedFiles}}`,
  `{{stepOutput.<key>}}` (incl. `content`, `stdout`, `stderr`, `exitCode`),
  `{{params}}` / individual launch parameters.
- **Semantics**: `settings.maxIterations` caps the whole run (default 50);
  no matching transition ⇒ `$blocked`; agent steps re-enter with
  `nudgePrompt` when their transition condition is unmet; state is persisted
  on every transition.

Full semantics: this extension is a self-contained declarative workflow
engine — steps, ordered transitions, metadata conditions, nudge re-entry,
`maxIterations` safety cap, `$blocked` handling, persistence and resume.

## Project layout

```
src/
├── index.ts          # entry: tools, commands, events, wiring
├── types.ts          # workflow schema types
├── store.ts          # flow_meta store + execution state (file-backed)
├── templates.ts      # template variable resolution
├── modes.ts          # plan/build tool gating, bash allowlist, prompt sections
├── subagent.ts       # in-house child-process propagation (pi -p spawn/resume)
├── executor.ts       # the workflow state machine
├── tools.ts          # flow_meta + flow_step_done tool definitions
├── widgets.ts        # TUI widget (criteria checklist, step, findings)
└── workflows.ts      # workflow loading (project > user > bundled)
workflows/
├── build-verify.workflow.json
└── pr-review.workflow.json
scripts/smoke-load.mjs
```
