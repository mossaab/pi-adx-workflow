# pi-adx-workflow

[![npm](https://img.shields.io/npm/v/pi-adx-workflow)](https://www.npmjs.com/package/pi-adx-workflow)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![pi-coding-agent](https://img.shields.io/badge/pi-coding-agent-%E2%89%A51.5-blueviolet.svg)](https://github.com/earendil-works/pi)

**plan → build/verify → review → summarize** workflow for
[pi-coding-agent](https://github.com/earendil-works/pi), built as a pi extension with
**in-house sub-agent propagation**: flow children (verifier / code reviewer)
run as isolated `pi -p` child processes — no pi-subagents dependency.

It implements a complete working method:

1. **Plan mode** (read-only) — the planner explores and proposes **acceptance
   criteria** (`flow_meta`, key `criteria`, status `pending`).
2. **Build mode** — you approve, then `/adx-run` starts the workflow:
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

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
- [Configuration](#configuration)
- [Never-stop (auto-continue)](#never-stop-auto-continue)
- [Tools](#tools)
- [Sub-agents](#sub-agents)
- [Workflows](#workflows)
- [Development](#development)
- [Contributing](#contributing)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [License](#license)

## Requirements

- pi-coding-agent **≥ 1.5** (the `pi` CLI is resolved from
  `~/.pi/agent/bin/pi`, `ADX_PI_BIN`, or `PATH`)
- Node **≥ 22.19** (pi's own engine requirement)

pi-subagents is **not** required: children are plain `pi -p` processes that
load only this extension (child mode), so there is no retained-child state
and no "Agent is already processing" jams.

No `npm install` is needed for the extension itself: its runtime imports
(`typebox`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) are
**host-provided** — pi maps them to its own copies, so the extension shares
pi's classes and registries (declared as `peerDependencies` with a `*` range,
per the pi package conventions).

## Install

Recommended: install as a [pi package](https://github.com/earendil-works/pi) from npm:

```sh
pi install npm:pi-adx-workflow
```

Variants:

```sh
# project-local (written to .pi/settings.json, loads after project trust)
pi install --local npm:pi-adx-workflow

# from git (tracks the main branch)
pi install git:github.com/mossaab/pi-adx-workflow
```

Manage the install:

```sh
pi list                                    # show configured packages
pi remove npm:pi-adx-workflow
pi update --extensions                     # reconcile git checkouts / npm specs
```

### Development install (symlink)

To develop the extension, clone the repo and symlink it into pi's global
extension directory (pi discovers `package.json` with a `pi.extensions`
field one level deep):

```sh
git clone https://github.com/mossaab/pi-adx-workflow.git
ln -sfn ~/path/to/pi-adx-workflow ~/.pi/agent/extensions/adx-workflow
```

No build step: pi loads `src/index.ts` through jiti. If you move the repo,
re-create the symlink.

## Usage

```
/adx-plan                    enter plan mode (read-only)
/adx-spec [path]             enter spec mode (read-only brainstorm/research; writes a spec file, no build)
/adx-spec SPEC.md            spec mode with a custom spec location (default: .pi/specs/<slug>.md)
/adx-approve                 approve the plan/spec: switch to build mode (turn plan/spec mode off, no launch)
/adx-run [workflow] [params] switch to build mode + launch a workflow (default: the configured build one)
/adx-run build-verify        switch to build mode + launch the full build-verify workflow
/adx-run build-verify skip_review=true   full workflow minus the code review step
/adx-run build-verify commit=true        pipeline + commit & push at the end (auto-skips the "Commit changes?" picker)
/adx-run build-verify commit=false       pipeline, changes left uncommitted (picker auto-skipped)
/adx-run build-verify commit=true message="feat: ..."   commit phase with an explicit commit message
/adx-status                  show current workflow state
/adx-resume                  resume a blocked/waiting workflow
/adx-cancel                  cancel the current run
/adx-config                  show the effective config ("edit" menu / "set key=value")
Ctrl+Alt+A                   toggle plan/spec mode (spec mode exits; plan mode toggles)
```

### Auto mode (unattended pipeline)

```
pi --adx-auto "Add a dark mode toggle: - toggle in settings, - persist to localStorage, - follow system preference"
```

`--adx-auto` runs the whole pipeline without any approval:

1. **Plan** — the planner refines the acceptance points you provided into
   final criteria (no questions, no validation step) and adds them to the store.
2. **Build** — plan mode exits automatically and the build-verify workflow
   launches (user steps like the work-location and commit pickers are
   auto-skipped — in auto mode the work is left uncommitted by default).
3. **Verify → recap** — the verifier checks the criteria, then the summary
   with "What to test" is printed. The code review step is skipped in auto
   mode; use `/adx-run build-verify` for the full pipeline with review.

Manual mode (`/adx-plan` + `/adx-approve` / `/adx-run`) is unchanged.

When the planner finishes in interactive mode it calls `flow_plan_done`, which
shows a picker: **Build + verify (full pipeline)** / **Build (simple)** /
**Choose workspace** (current workspace or fresh worktree, then the pipeline) /
**Spec only — stop** (export the stored criteria as a spec document and stop —
no build is launched).

### Spec mode (brainstorm / research, no code)

`/adx-spec` is the "specs without dev" mode: pure brainstorming, research, and
spec writing — **zero coding, zero verification, zero review**.

- **Read-only workspace** — same gating as plan mode (edit/write disabled,
  read-only bash allowlist). The single exception is the `spec_write` tool,
  the only write channel: it writes the spec markdown file and nothing else.
- **Iterative reasoning** — the spec agent asks you 1-3 focused questions per
  turn (`ask_user`), explores the codebase read-only, and researches on the
  web (`web_search`, `fetch_content`, `source_check`).
- **Output = a spec document** — a markdown file with *Context & goal*,
  *Research notes*, *Decisions & assumptions*, and an *Acceptance criteria*
  checklist. Written to `.pi/specs/<slug>.md` by default (auto-generated
  timestamp slug); pass a path to `/adx-spec` (e.g. `/adx-spec SPEC.md`) to
  choose the location. `spec_write` is called exactly once, at the end.
- **No hand-off** — after the spec is saved the session simply ends in normal
  build mode; nothing is launched, verified, or reviewed. Exit spec mode early
  with `/adx-approve` or Ctrl+Alt+A (no launch). Spec mode is persisted per
  session and restored on resume (unfinished spec → continue, then call
  `spec_write` once).

After a regular plan, the `flow_plan_done` picker's **Spec only — stop**
option does the same export: it composes the spec from the stored criteria,
saves it to `.pi/specs/<slug>.md`, exits plan mode, and launches nothing.

### Typical session

1. `/adx-plan`
2. Ask for a feature: *"Add a dark mode toggle. Use flow_meta to define the
   acceptance criteria."* — the planner explores (read-only) and adds
   criteria. Review them in the widget (or edit with `flow_meta`).
3. `/adx-run` (quick: `build → summarize`) or `/adx-run build-verify`
   (full: `work_location → build → verify → code_review → finalize → summarize`).
   The widget tracks step, iteration, and criterion status; the footer shows
   a compact status line.
4. When a criterion fails verification, the builder is nudged with the
   verifier's findings and re-enters `build` until everything is `passed`.
5. The reviewer's findings are dispositioned in `finalize`, then the summary
   with "What to test" is printed.

State lives **per pi session** in `.pi/adx-flow/state/<sessionId>.json`
(criteria, findings, execution state, plan-mode and spec-mode flags) — each session has its
own plan, and resuming a session restores exactly that session's plan/run.
**New sessions (`/new`, fork) start 100% clean**: no execution is restored and no
step auto-executes — an in-flight run left behind by a previous session stays in
*that* session's own file and comes back only when you re-resume it. When a resumed
session has no per-session file yet, an in-flight run still in the legacy shared
`.pi/adx-flow/state.json` (status ≠ done) is adopted into its file once, so
pre-per-session runs keep working — new sessions never touch the legacy file.
Flow sub-agents (verifier / code reviewer) write to the *parent's* state file
(passed via the `ADX_FLOW_STATE` env var) so their `flow_meta` updates land
in the driving session's store. It survives pi restarts — `session_start`
restores the resumed session's running run (and its plan/spec mode if the session
stopped mid-plan or mid-spec), and `/adx-resume` continues a blocked one.

## Configuration

The user config file is **created automatically on first run** with all
defaults, ready to edit:

- user: `~/.pi/agent/adx-workflow.json` (auto-created, all projects)
- project: `<cwd>/.pi/adx-workflow.json` (optional, overrides user per key)

All keys optional, unknown keys ignored, malformed file = defaults.

You can also manage it from inside pi:

```
/adx-config                          show the effective config + file paths
/adx-config edit                     interactive menu: pick the file (user/project),
                                     then pick a setting row to TOGGLE it (booleans flip,
                                     defaultBuildWorkflow cycles) — repeat, "Done" exits
/adx-config set defaultPlanMode=true one-shot update (user file)
/adx-config set showWidget=false project   # write to the project file
```

`showWidget`, `skipReview` and `defaultBuildWorkflow` apply immediately;
`defaultPlanMode` / `autoMode` apply from the next session.

```json
{
  "defaultPlanMode": true,
  "showWidget": true,
  "autoMode": false,
  "skipReview": false,
  "defaultBuildWorkflow": "build"
}
```

| Key | Default | Effect |
|---|---|---|
| `defaultPlanMode` | `false` | Start every pi session in plan mode (no active run to restore) |
| `showWidget` | `true` | `false` hides the bottom flow/criteria widget entirely |
| `autoMode` | `false` | Persistent `--adx-auto`: unattended plan → build → verify → recap (the CLI flag still wins when passed) |
| `skipReview` | `false` | Default `skip_review=true` for the build-verify pipeline (picker + `/adx-run build-verify`); an explicit `skip_review=` in the command args wins |
| `defaultBuildWorkflow` | `"build"` | Which workflow `/adx-run` launches: `"build"` (simple) or `"build-verify"` (full) |

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
| `flow_meta` | Shared workflow metadata store: `criteria`, `todos`, `review_findings`, `resume` (auto-continue notes) and `progress` (live display feed). Writes are atomic (per-process write chain + cross-process file lock — parent and `pi -p` children never lose updates); multi-item writes: `add_batch` (descriptions) / `update_batch` (items) |
| `flow_step_done` | Ends the current workflow step; the executor evaluates transitions and injects the next prompt (or a nudge) |
| `flow_plan_done` | Signals that planning is complete and hands off to the build pipeline (auto-launch in `--adx-auto`, picker in interactive mode — including **Spec only — stop**, which exports the criteria as a spec file and launches nothing) |
| `ask_user` | Structured question (choice / confirm / text) that pauses the turn for a user answer — plan/spec-mode clarification |
| `spec_write` | Writes the spec markdown document (spec mode only; `defaultActive: false`, so it is inactive in plan/build modes) — the single write channel while the workspace stays read-only |

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
  (e.g. `litellm/qwen3.8-27b`) to pin a cheaper model for flow children, or a
  per-step `"model"` field on any `sub_agent` step in a workflow file
  (takes precedence over `ADX_FLOW_MODEL`) — e.g. a fast model for
  verify/review on small projects.
- **Env overrides**: `ADX_PI_BIN` (pi CLI path), `ADX_EXTENSION_PATH`
  (extension entry for the child).

### Performance: no redundant verification

The executor keeps verification cheap in three ways:

- **Re-run short-circuit** — after a successful verify pass the executor
  records a content hash of the project files (`.pi/`, `node_modules/`,
  `.git/`, build dirs excluded). On re-entry to the verify step, if the hash
  is unchanged AND the step's metadata gate is now met (e.g. the store
  caught up after a lost write), the expensive verifier pass is skipped and
  the previous report is reused — a small project no longer pays 3-4 full
  verifier passes to re-converge on the same verdict.
- **Proportional effort** — verify prompts get `{{projectFileCount}}` /
  `{{projectLines}}` template variables and instruct the verifier to scale
  the effort to the project size (small project: focused read + one smoke
  run, not an exhaustive test suite).
- **Atomic store** — the state file is protected by a cross-process lock
  (parent + children) and `flow_meta` mutations are atomic read-modify-writes;
  the verifier records all criterion verdicts in a single `update_batch` call,
  so "the verifier said PASS but the store disagrees" re-loops can't happen.

## Workflows

Workflow files are plain JSON state machines: `workflows/*.workflow.json`
(bundled), overridable per project in `.pi/adx-workflows/` (highest
precedence) and per user in `~/.pi/agent/workflows/`.

Four workflows are bundled:

- `build` — **simple**: `work_location → build → commit? → summarize`. No
  automated verification, no code review; the builder self-checks before
  marking criteria complete. Launched by `/adx-run`.
- `build-verify` — **the full pipeline** (launched with `/adx-run build-verify`):
  `work_location → build → verify → code_review → finalize → commit? →
  summarize`.

Both build pipelines end with an optional **commit & push** phase (`commit?`
above), controlled by the `commit` launch parameter: `commit=true` runs the
commit & push step automatically (the "Commit changes?" picker is skipped),
`commit=false` skips it, and without the parameter an interactive
"Commit changes?" picker is shown (auto mode skips it — no commit by
default). The step stages only the session's files (never `git add -A`),
commits with a clear message, and pushes (rebase onto origin if rejected).
An optional `message` launch parameter sets the exact commit message
verbatim (without it, the agent derives one from the staged diff).
In a **fresh worktree** (the `worklocation=new` path) it commits on the
`adx/<slug>` branch and pushes that branch only — `git push -u origin
adx/<slug>` — with **no merge into the base branch**: the merge stays manual
(open a PR or `git merge adx/<slug>` later), and the worktree + branch are
kept in place for follow-up work.
- `pr-review` — PR review + fixes + squash-merge (requires `gh`), launched
  with `/adx-run pr-review pr_number=123`.
- `commit` — **commit & push**: `check_status → stage → commit → push →
  summarize`. Stages only the session's files (never `git add -A`), commits
  with a clear message, and rebases onto origin if the push is rejected.
  Launched with `/adx-run commit` (optional `message="..."` param to set
  the commit message explicitly).

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
- **Shell trust boundary**: `shell` step commands run via `sh -c`, and
  `{{params.*}}` / `{{workdir}}` are interpolated **verbatim (unquoted)**.
  Launch parameters are trusted shell input: a value like
  `message="a; rm -rf ~"` is executed as shell code, and word-splitting
  applies (a param `args="a b"` becomes two words). Quote values yourself when
  composing commands from params. This is a deliberate trust assumption,
  not a bug — workflow JSON and launch args are authored by the user running
  the workflow.
- **Semantics**: `settings.maxIterations` caps the whole run (default 50);
  no matching transition ⇒ `$blocked`; agent steps re-enter with
  `nudgePrompt` when their transition condition is unmet; state is persisted
  on every transition.

Full semantics: this extension is a self-contained declarative workflow
engine — steps, ordered transitions, metadata conditions, nudge re-entry,
`maxIterations` safety cap, `$blocked` handling, persistence and resume.

## Development

```sh
git clone https://github.com/mossaab/pi-adx-workflow.git
cd pi-adx-workflow
npm install            # dev dependencies (typescript, @types/node, jiti, typebox,
                       # @earendil-works/pi-ai + pi-coding-agent for the test scripts)
npm run setup-dev      # link host-provided packages (typebox, @earendil-works/*)
                       # from your pi install into node_modules

npm run smoke          # jiti-load the extension with a fake ExtensionAPI
npm run e2e            # drive the full build-verify pipeline with fake pi + fake sub-agents
npm run typecheck      # tsc --noEmit (strict)
```

`npm run setup-dev` replicates pi's runtime resolution: it symlinks the
host-provided packages (`typebox`, `@earendil-works/*`) from your pi install
into the local `node_modules/`, so the dev commands work from a fresh clone.
Re-run it if your pi install location changes (or use `ADX_FLOW_JITI` below).

The test scripts load TypeScript the same way pi does (via jiti). They find
jiti from your pi install — `~/.pi/agent/install/releases/<newest>/node_modules/jiti` —
with no hard-coded paths. Override the lookup with
`ADX_FLOW_JITI=/path/to/node_modules/jiti` if your layout is unusual.

Extension development loop: symlink the repo into
`~/.pi/agent/extensions/` (see [Install](#development-install-symlink)), edit
`src/*.ts`, and restart pi (or `/reload`) — jiti loads the TypeScript
directly, no build step.

### CI/CD

- **CI** (`.github/workflows/ci.yml`): on every push to `main` and on pull
  requests, GitHub Actions runs `npm ci` → `typecheck` → `smoke` → `e2e` →
  `e2e:lock` on Node 22. The test scripts' jiti lookup is pointed at the
  devDependency copy via `ADX_FLOW_JITI` (runners have no pi install).
- **Publish** (`.github/workflows/npm-publish.yml`): publishing a
  [GitHub release](https://github.com/mossaab/pi-adx-workflow/releases)
  (or the manual `workflow_dispatch`) runs the typecheck + smoke checks, then
  `npm publish --provenance`. Configure the repo secret **`NPM_TOKEN`** with
  an npm automation token (fine-grained or classic with publish access);
  `--provenance` additionally requires the GitHub OIDC token, which the
  workflow requests via the `id-token: write` permission.

## Contributing

Contributions are welcome — fork, branch, and open a pull request.

- **TypeScript, strict mode, no build step** — the extension ships as
  TypeScript loaded by pi's jiti; keep it that way.
- **Workflow engine changes**: extend `scripts/e2e-executor.mjs` — it drives
  the whole pipeline (nudge loops, verify/review sub-agents, resume,
  maxIterations blocking) against a fake pi, so it catches regressions fast.
- **New workflows**: plain JSON state machines in `workflows/` (schema in
  `src/types.ts`); see the [authoring reference](#authoring-reference-short).
- **Docs**: README sections mirror the feature set — update both together.

## Troubleshooting

- **`pi` CLI not found** — point the extension at it: `export ADX_PI_BIN=/path/to/pi`
  (or install pi-coding-agent so `~/.pi/agent/bin/pi` exists).
- **Flow children using a model you don't want** — pin one:
  `export ADX_FLOW_MODEL=<provider/model>`.
- **Config not taking effect** — run `/adx-config` to see the effective
  config and which files were read. Note: `defaultPlanMode` / `autoMode`
  apply from the *next* session; the rest apply immediately.
- **"Agent is already processing"** — structurally impossible here: flow
  children are isolated `pi -p` processes with fresh sessions, so no stuck
  retained child can block later spawns. A hung child is killed by the
  15-minute timeout and revived by the never-stop resume.
- **Package install fails at startup** (e.g. offline) — pi warns, skips the
  package, and retries on the next start or `/reload`; `pi update --extensions`
  reports the failure explicitly.
- **Dev scripts can't find jiti** — set `ADX_FLOW_JITI` to your jiti install
  path (see [Development](#development)).

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
├── build.workflow.json
├── build-verify.workflow.json
├── commit.workflow.json
└── pr-review.workflow.json
scripts/
├── find-jiti.mjs     # locate jiti in your pi install (used by the dev scripts)
├── setup-dev.mjs     # npm run setup-dev (link host-provided packages)
├── smoke-load.mjs    # npm run smoke
└── e2e-executor.mjs  # npm run e2e
```

## License

[MIT](./LICENSE) © mossaab
