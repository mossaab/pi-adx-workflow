# Conformance audit — `pi-adx-workflow` vs `pi.dev/docs/latest/extensions`

Audit of the `pi-adx-workflow` extension against the official pi-coding-agent
extensions documentation (https://pi.dev/docs/latest/extensions), checked
against the **pi 1.5.2** release (the version in `node_modules`, whose
`docs/extensions.md` + `docs/cli.md` were used as the reference).

Legend: ✅ compliant · ⚠️ deviation / gap (with disposition)

## 1. Entry point & loading

| Check | Verdict |
|---|---|
| Default export is a factory function `(pi: ExtensionAPI) => void` (`src/index.ts`) | ✅ |
| Factory is synchronous; no background resources (timers/sockets/watchers) started at load — the only `setInterval` lives inside a `setWidget` component and is `dispose()`d | ✅ |
| TypeScript loaded via jiti (no compilation step) | ✅ |
| Child mode (`ADX_CHILD=1`): registers only `flow_meta`, then returns — no commands/events/widgets in children | ✅ |

## 2. Package manifest (`package.json`)

| Check | Verdict |
|---|---|
| `pi.extensions: ["./src/index.ts"]` manifest entry for package-style discovery | ✅ |
| Host-provided packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`) declared as **peerDependencies**, not `dependencies` (per "Do not list the host-provided packages above in `dependencies`") | ✅ |
| No runtime npm deps of the extension itself (host provides everything) | ✅ |
| `files` ships `src`, `workflows`, `README.md` | ✅ |

## 3. Custom tools

Tools registered: `flow_meta`, `flow_step_done`, `flow_plan_done`, `ask_user`.

| Check | Verdict |
|---|---|
| `name` / `label` / `description` on every tool | ✅ |
| `promptSnippet` (one-line `<tools>` entry) and `promptGuidelines` on every tool; each guideline **names the tool** it refers to (no "Use this tool…") | ✅ |
| Parameter schemas built with `typebox` (`Type`) + `StringEnum` from `@earendil-works/pi-ai` — the documented "new code" import pattern (pi-ai no longer re-exports TypeBox's `Type`) | ✅ |
| Every `execute()` result — final and partial — carries model-facing `content` **and** a `details` value (`details: {}` consistently) | ✅ |
| Errors signaled via `isError: true` (`flow_meta` `fail()`), matching "throw or return `isError: true`" | ✅ |
| `terminate: true` on `flow_step_done` used with the documented early-termination semantics (executor queues the next prompt) | ✅ |
| No file mutation in tools → `withFileMutationQueue()` not required | ✅ |
| Tool outputs are small/bounded (`flow_meta` lists capped; `progress` feed capped at 20) — no unbounded LLM context growth | ✅ |
| `ask_user` degrades gracefully without a dialog UI (chat-answer fallback + `terminate`) | ✅ |
| `flow_plan_done` interactive picker guarded by `ctx.hasUI` (print/json: plan mode stays on, the turn ends via `terminate: true`, and the user starts the pipeline with a command — consistent with the picker-cancelled path) | ✅ (added in this audit) |

## 4. Events

| Event used | Verdict |
|---|---|
| `session_start` — load config, restore persisted run, enter plan/auto mode | ✅ |
| `session_shutdown` — clears the captured `ctx` (state cleanup on reload/switch) | ✅ |
| `before_agent_start` — mutates `event.systemPromptOptions.sections` (keyed record; pi diffs and patches only changed sections — the cache-friendly pattern the doc recommends over replacing the whole prompt) | ✅ |
| `tool_call` — plan-mode bash guard returns `{ block: true, reason }` (documented gate; no `terminate`, so the turn continues) | ✅ |
| `agent_before_settle` — returns `{ entries: [...event.entries, custom_message], continue: true }` with a guard (`outcome === 'aborted'` + executor decision) so `continue: true` is never unconditional (no endless-loop risk per the doc's warning) | ✅ |
| `agent_settled` — notification-only use (abort notice) | ✅ |

## 5. UI (`ctx.ui`)

| Check | Verdict |
|---|---|
| Dialogs: `select` / `confirm` / `input` used with documented signatures; `notify` levels (`info`/`warning`/`error`) correct | ✅ |
| `setWidget` with static string arrays **and** a component factory (`(tui, theme) => component`); the animated sub-agent widget implements `render`/`invalidate`/`dispose` (timer cleared on dispose) | ✅ |
| `setStatus` footer status; cleared with `undefined` | ✅ |
| `ui.theme` access guarded by `?? PLAIN_THEME` fallback for non-interactive modes | ✅ |
| Dialog-capable calls guarded by `ctx.hasUI` (`ask_user` originally; `flow_plan_done` + executor user-step added in this audit) | ✅ |
| No `custom()`/component usage in non-TUI-only paths that would break RPC mode (widget component factories are ignored in RPC, which is documented behavior) | ✅ |

## 6. Commands, shortcuts, flags

| Check | Verdict |
|---|---|
| `registerCommand` for `/adx-plan`, `/adx-build-mode`, `/adx-build`, `/adx-build-verify`, `/adx-status`, `/adx-resume`, `/adx-cancel`, `/adx-config` with `description` + `handler(args, ctx)` | ✅ |
| `registerShortcut('ctrl+alt+a', { description, handler })` | ✅ |
| `registerFlag('adx-auto', { type: 'boolean', default: false })` read via `pi.getFlag()` in `session_start` (documented pattern — in the factory, `getFlag()` returns the default) | ✅ |
| Command handlers capture `ctx` (ExtensionCommandContext) into the module-level `ctx` for tools/events | ✅ |

## 7. State & session persistence

| Check | Verdict |
|---|---|
| Durable run state in `.pi/adx-flow/state/<sessionId>.json` (per pi session; survives restarts, resume via `/adx-resume`; legacy shared `state.json` in-flight runs are adopted once) — the doc's `pi.appendEntry()` is for LLM-context-free session entries; a session-scoped file store is a valid alternative for cross-restart workflow state | ✅ (design choice, documented in README) |
| `pi.sendUserMessage(prompt, { deliverAs: 'followUp' })` for step prompts — `deliverAs` supplied (required while streaming) | ✅ |
| No captured old-session objects reused after replacement flows (no `newSession`/`fork` usage) | ✅ |

## 8. Sub-agents (in-house `pi -p` child processes)

All CLI flags used in `src/subagent.ts` verified against `docs/cli.md` (1.5.2):

| Flag | Verdict |
|---|---|
| `-p` (print), `--mode json` (JSONL event stream) | ✅ |
| `--extension <path>` + `--no-extensions` (child loads only adx-workflow) | ✅ |
| `--no-mcp`, `--no-skills` | ✅ |
| `--tools read,bash,flow_meta` (plain list replaces the default selection — intentional) | ✅ |
| `--session-dir`, `--name`, `--session-id` (fresh) / `--session <id>` (resume) | ✅ |
| `--append-system-prompt <role prompt>`, `--model` (env `ADX_FLOW_MODEL` pin) | ✅ |

| Check | Verdict |
|---|---|
| Children run with `ADX_CHILD=1` so only `flow_meta` is registered (no crosstalk) | ✅ |
| Process-group kill on timeout (`detached: true` + `kill(-pid, SIGKILL)`) — raw `node:child_process.spawn` instead of `pi.exec` | ⚠️ stylistic deviation, **justified**: `pi.exec` cannot create a detached process group for whole-tree kills. The doc's own `subagent/` example also uses `exec`. |
| Child success = exit 0 **and** final `turn_end` without provider error (pi exits 0 even on model 400s) | ✅ |

## 9. Tooling & verification

| Check | Verdict |
|---|---|
| `tsc --noEmit` passes against installed pi 1.5.2 types (extension uses only documented API surface) | ✅ |
| `node scripts/smoke-load.mjs` (jiti load + registration census) passes | ✅ |
| `node scripts/e2e-executor.mjs` (state-machine, nudge, never-stop, caps) passes | ✅ |

## Summary

The extension is **conformant** with the extensions documentation. All
deviations found are minor and dispositioned:

1. **`ctx.hasUI` guards** for dialogs in `flow_plan_done` (tools.ts) and the
   executor user-step (executor.ts) — **added** (harmonized with the existing
   `ask_user` pattern).
2. Raw `spawn` instead of `pi.exec` for sub-agent children — **kept** (detached
   process-group kill semantics; documented in `src/subagent.ts`).
