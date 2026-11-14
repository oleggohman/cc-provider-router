# Provider Router mod for Claude Code

## Overview
- A Claude Code mod (plugin with a hooks module) that lets one session use several model providers at once.
- Routes every model request by the model id's prefix:
  - no prefix → the engine's own request (`yield* next(e)`), i.e. the signed-in Max subscription
  - `anthropic:<model>` → Anthropic Messages API with a Claude Platform API key (no format translation)
  - `openai:<model>` → OpenAI Platform (`https://api.openai.com/v1`) Chat Completions, translated
  - `custom:<name>:<model>` → any configured OpenAI-compatible endpoint (several allowed), translated
- Main session stays on Max while subagents (via `model:` in their definition) or a `/model` switch use other providers.
- Runs on unmodified official Claude Code releases: no fork, upgrades need no merge. The plugin API (`claude-code` types) is the only dependency.
- User requirements: **simple configuration**, **a good README**, TDD, and at the end a tagged release added to the `oleggohman/cc-things` marketplace.

## Context (from discovery)
- Repo (GitHub `oleggohman/cc-provider-router`, public), branch `feat/provider-router`.
- Plugin API reference for this build: `types/claude-code.d.ts` and `reference.md` in the plugin-authoring skill folder (Claude Code 2.1.323); after first load the mod gets `.claude-plugin/types/` + `tsconfig.json` for `tsc -p`.
- Already proven by a spike (`provider-spike` dev mod): a `--plugin-dir` mod answering `turn.step` by yielding its own `text` + `stop` chunks without `next()` works; `claude -p --model spike-echo` accepts an unknown model id (warns, assumes a 1M window).
- API facts (checked against the types file):
  - `turn.step` streams; hook is `async function* ($, e, next)`. `e` has `turnId`, `index`, `model`, `effort`, `messageCount`, `agentId`.
  - Chunks: `text {index,text}`, `thinking`, `tool {index,id,name}`, `input {index,json}` (partial tool args), `stop {stopReason,usage}`. Result: `{ turnId, index, answer, toolUses, serverToolUses? }`.
  - `$.session.messages({ as: 'api', agentId })` returns the Messages-API form of a loop's conversation (can answer `{ deny }`). System prompt and tool list are **not** in it.
  - `$.tool.list()` → `ToolInfo[]`; `inputSchema` is documented only for entries a `tool.list` hook adds — built-in tools' schemas are **unverified**. It is the main session's list, not a subagent's.
  - `$.http.fetch(url, { method, headers, body, compress, auth, socketPath })` resolves with the whole body as `text`. **No timeout, no abort signal, no streaming body** for a plugin's own request.
  - `userConfig` fields (string, number, boolean, string[]) are editable in `/config`; `sensitive` ones are kept in secure storage.
  - `$.session.authorize()` yields the session's first-party (Max) credential — **must never be used** by this mod: the `anthropic:` route bills the Platform key, not Max.
  - `next.signal` aborts when the person presses Esc; `$.clock.sleep(ms, { signal })` honours it.
- Reference for translation semantics: LiteLLM's Anthropic↔OpenAI adapter (read only, no dependency).

## Development Approach
- **testing approach**: TDD (tests first)
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task, success and error paths
- **CRITICAL: all tests must pass before starting next task** - no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- never run tests in parallel
- work on branch `feat/provider-router`; commit per task (Conventional Commits); merge, tag and publish only with the user's go-ahead

## Testing Strategy
- **unit tests**: `claude plugin test .` (`claude-code/testing`), one `*.test.ts` per module under `hooks/`; network mocked by an `on('http.fetch', …)` hook beneath the mod (confirmed in Task 1).
- **type check**: `tsc -p .`. **validate**: `claude plugin validate .`.
- **live smoke tests** (Task 8): real calls per provider, run only when that provider's key is set.
- no UI e2e.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix; blockers with ⚠️ prefix
- keep plan in sync with actual work done

## Solution Overview
- One `turn.step` hook. Parses `e.model`; no known prefix → `return yield* next(e)` untouched (zero overhead for Max).
- Routed model: build the request from `$.session.messages({ as: 'api', agentId })` plus the step's system prompt and tools (source decided in Task 1), call the provider with `$.http.fetch` (non-streaming), convert the reply to chunks, yield, return the result.
- Two adapters, each a plain function `complete(req, provider) → Reply` (no class hierarchy):
  - `anthropic`: request as is; only model id and key change.
  - `openai`: Anthropic ↔ Chat Completions translation; serves `openai:` and every `custom:<name>:`.
- Timeout and cancel: `Promise.race([fetch, $.clock.sleep(timeout, { signal: next.signal })])`; on Esc the step ends at once, the provider call itself cannot be cancelled (documented: its cost still accrues).
- Context windows: the engine assumes 1M for unknown ids, so it would not compact in time. The mod reports real `usage` in `stop`, and when input tokens pass 85% of the model's known window it calls `$.session.compact` (or the mechanism Task 1 finds); a provider "context length exceeded" error becomes a clear message telling the person to run `/compact`.
- `/providers` command: configured providers, key present yes/no, and on demand `GET /v1/models` for each. No discovery at session start, no cache, no status line.
- Keys never appear in logs, state, store, errors, or replies.
- Limits in v1 (documented): no streaming for routed models, no prompt caching / extended thinking / server tools on translated providers, Max never routed.

## Technical Details
- **Config — must be simple**:
  - **Zero config via env**: `OPENAI_API_KEY` → `openai:` works; `ROUTER_ANTHROPIC_API_KEY` → `anthropic:` works. (Not `ANTHROPIC_API_KEY`: that variable makes Claude Code itself drop the Max sign-in — the README says so.)
  - **Or in `/config`** (`userConfig`, keys `sensitive` → secure storage): `openaiApiKey`, `anthropicApiKey`. Config value wins over env.
  - **Custom endpoints**: one `userConfig` string[] field `customEndpoints`, each entry `name=url` with an optional key reference, e.g. `mygateway=http://gateway.example.internal:4000/v1`; the key for endpoint `<name>` comes from env `ROUTER_<NAME>_API_KEY` (none needed for a local server). If Task 1 finds `userConfig` unsuitable, fall back to a single file `~/.claude/provider-router.json` holding only custom endpoints.
  - **Context windows**: built-in table for common OpenAI models; optional `userConfig` string[] `contextWindows` entries `model=tokens`.
  - Nothing else is configurable (timeouts and limits have fixed defaults).
  - Invalid config → one clear message naming the field; the session keeps working.
- **Model id grammar**: `anthropic:<id>` | `openai:<id>` | `custom:<name>:<id>` (`<id>` may contain `/` or `:`).
- **Translation (openai adapter)**:
  - system prompt → first `system` message
  - user text / image / `document` blocks → `content` parts (documents as text when no file part exists)
  - `tool_result` → `role: "tool"` message with `tool_call_id`; `is_error` → content prefixed `Error:`; images inside a tool result → moved into a following user message (tool messages cannot hold images)
  - assistant `tool_use` → `tool_calls[{id, type:"function", function:{name, arguments}}]`
  - tool definitions → `tools[{type:"function", function:{name, description, parameters}}]`
  - thinking blocks in history → dropped
  - `max_tokens` → `max_completion_tokens`; `effort` → `reasoning_effort` (low/medium/high) for models that accept it
  - reply `tool_calls` → `tool` + `input` chunks; `finish_reason`: `stop`→`end_turn`, `tool_calls`→`tool_use`, `length`→`max_tokens`, `content_filter`→`refusal`
  - usage: `prompt_tokens`→`input_tokens`, `completion_tokens`→`output_tokens`, cache fields 0
- **Errors**: provider failure → one text chunk `[provider-router] <provider> error <status>: <sanitized message>` and stop reason `refusal`, so a parent agent can tell it from a real answer; key material stripped.
- **Flow**:
  ```
  turn.step(e) → route(e.model)
    none     → yield* next(e)
    provider → req   = build(messages, system, tools, effort)
               reply = await race(adapter(req), sleep(timeout, next.signal))
               yield* toChunks(reply); maybeCompact(reply.usage)
               return toResult(e, reply)
  ```

## What Goes Where
- **Implementation Steps**: code, tests and docs in this repo.
- **Post-Completion**: live checks on real accounts, marketplace listing checks.

## Implementation Steps

### Task 1: Verification spike (go/no-go)
**Files:**
- Create: `spike/README.md` (findings), `spike/.claude-plugin/plugin.json`, `spike/hooks/hooks.json`, `spike/hooks/register.ts`

- [ ] **GO/NO-GO — tools**: for a main-session step and a subagent step, find the exact tool names + JSON schemas the engine would send. Try in order: (a) `$.tool.list()` `inputSchema` for built-ins; (b) a `tool.list` / `tool.describe` hook; (c) an `http.fetch` hook beneath the engine reading the body of the engine's own request on an unprefixed step and caching tools per `agentId`/agent type; (d) last resort: a hand-written schema table for core tools. Record which works; if none gives schemas for a subagent's tool set → ⚠️ stop and report to the user.
- [ ] **GO/NO-GO — system prompt**: per step and per agent, from `prompt.compose`, the agent definition, or the engine request body (as above); include system reminders that `messages({as:'api'})` leaves out.
- [ ] verify a subagent with `model: spike-echo` in its definition reaches the hook with that model and its `agentId`
- [ ] verify a self-made `tool` + `input` + `stop{tool_use}` reply makes the engine run the tool and send a next step with the `tool_result`
- [ ] verify `$.http.fetch` POST with JSON body and headers, 4xx/5xx shape; verify `Promise.race` with `$.clock.sleep(ms, { signal: next.signal })` ends the step on Esc
- [ ] verify `claude plugin test` with `on('http.fetch')` beneath the mod intercepts the mod's own `$.http.fetch`
- [ ] verify `userConfig` with `sensitive: true` string and a string[] field; how `/model` accepts a prefixed id; whether `stop.usage` feeds the context meter and how to trigger compaction (`$.session.compact` or other)
- [ ] write findings to `spike/README.md`; revise Tasks 2–7 here before continuing

### Task 2: Plugin skeleton and model-id router
**Files:**
- Create: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.ts`, `hooks/route.ts`, `hooks/route.test.ts`
- Create: `package.json` (scripts: test, typecheck, validate), `.gitignore`, `LICENSE` (MIT), `README.md` stub

- [ ] write tests for `parseModel()`: no prefix, `anthropic:`, `openai:`, `custom:<name>:`, ids containing `/` and `:`, unknown custom name, empty id
- [ ] implement `parseModel()`
- [ ] write test: unprefixed `turn.step` passes through to `next` unchanged
- [ ] implement the `turn.step` hook skeleton (pass-through + dispatch stub)
- [ ] run `claude plugin test .`, `tsc -p .`, `claude plugin validate .` — must pass before Task 3

### Task 3: Configuration and keys
**Files:**
- Create: `hooks/config.ts`, `hooks/config.test.ts`
- Modify: `.claude-plugin/plugin.json` (`userConfig`: `openaiApiKey`, `anthropicApiKey` sensitive; `customEndpoints`, `contextWindows` string[])

- [ ] write tests: env-only, `/config`-only, both (config wins), custom endpoint parsing `name=url`, its key from `ROUTER_<NAME>_API_KEY`, invalid entry → clear message naming the field
- [ ] implement `loadConfig($)`
- [ ] write test: a missing key error names the variable or `/config` field, never a value
- [ ] run tests — must pass before Task 4

### Task 4: Request builder and error module
**Files:**
- Create: `hooks/request.ts`, `hooks/request.test.ts`, `hooks/errors.ts`, `hooks/errors.test.ts`
- Create: `tests/fixtures/` (transcripts: text only, tool round-trip, images, documents, thinking blocks, subagent)

- [ ] write tests building the request from `messages({as:'api', agentId})` + system + tools (source from Task 1), including the `{ deny }` result and subagent tool sets
- [ ] implement `buildRequest($, e)`
- [ ] write tests for `errors.ts`: status → message, key stripping, `refusal` stop
- [ ] implement `errors.ts`
- [ ] run tests — must pass before Task 5

### Task 5: Anthropic Platform adapter, chunks, timeout and cancel
**Files:**
- Create: `hooks/providers/anthropic.ts`, `hooks/providers/anthropic.test.ts`, `hooks/chunks.ts`, `hooks/chunks.test.ts`, `hooks/call.ts`, `hooks/call.test.ts`

- [ ] write tests for `toChunks()`/`toResult()`: text, tool calls, mixed, each stop reason, usage
- [ ] implement `chunks.ts`
- [ ] write tests for `call.ts` (`race` of fetch vs `$.clock.sleep` with `next.signal`): success, timeout, abort before reply
- [ ] implement `call.ts`
- [ ] write adapter tests with mocked `http.fetch`: success, tool_use reply, 401, 429, 5xx
- [ ] implement the adapter (`POST /v1/messages`, `x-api-key`, `anthropic-version`); wire `anthropic:`; hook-level test through `turn.step`
- [ ] run tests — must pass before Task 6

### Task 6: OpenAI-compatible adapter (OpenAI Platform + custom endpoints)
**Files:**
- Create: `hooks/translate.ts`, `hooks/translate.test.ts`, `hooks/providers/openai.ts`, `hooks/providers/openai.test.ts`

- [ ] write tests for Anthropic → Chat Completions (system, text, images, documents, tool_use, tool_result with `is_error` and images, thinking dropped, tools, `max_completion_tokens`, `reasoning_effort`)
- [ ] write tests for Chat Completions → reply (text, tool_calls, malformed args JSON, finish_reason mapping, usage, empty content)
- [ ] implement `translate.ts`
- [ ] write adapter tests with mocked `http.fetch`: success, tool call, 4xx/5xx, custom url with and without key
- [ ] implement the adapter; wire `openai:` and `custom:<name>:`
- [ ] run tests — must pass before Task 7

### Task 7: Context windows and `/providers`
**Files:**
- Create: `hooks/context.ts`, `hooks/context.test.ts`, `hooks/providers-command.ts`, `hooks/providers-command.test.ts`
- Modify: `hooks/register.ts`

- [ ] write tests: window lookup (built-in table, `contextWindows` override, unknown), compaction trigger at 85%, "context length exceeded" error → `/compact` message
- [ ] implement `context.ts` with the compaction mechanism from Task 1
- [ ] write tests for `/providers`: configured providers, key yes/no, on-demand model listing for Anthropic and OpenAI shapes, provider down
- [ ] implement `/providers`
- [ ] write a test that no log, status, state or reply in the whole suite contains a test key value; run `mcp__plugin-authoring__scan_secrets` on the repo
- [ ] run tests — must pass before Task 8

### Task 8: Live smoke tests
**Files:**
- Create: `scripts/smoke.sh`, `examples/agents/gpt-worker.md`, `examples/agents/platform-opus.md`

- [ ] write `scripts/smoke.sh`: per provider whose key is set, `claude -p --plugin-dir . --model <prefixed id>` with a tool-using prompt; assert reply and tool run
- [ ] add example subagents using `model: openai:<id>` and `model: anthropic:<id>`
- [ ] run smoke for Anthropic Platform and OpenAI Platform
- [ ] custom endpoint: start LiteLLM on a test Docker host, run smoke against it, then stop and remove the container
- [ ] verify main session on Max and a subagent on another provider run in parallel in one session

### Task 9: Verify acceptance criteria
- [ ] all routes work (none / anthropic / openai / custom); config is env-or-`/config` only, plus `customEndpoints`
- [ ] timeout, cancel, error and context-limit paths behave as specified
- [ ] `claude plugin test .`, `tsc -p .`, `claude plugin validate .` all pass; show output
- [ ] every module has success and error tests

### Task 10: README and docs (user requirement: a good README)
- [ ] README.md: one-paragraph pitch; 60-second quick start (install from marketplace, set one env var, `/model openai:gpt-5`); configuration (env, `/config`, custom endpoints) with copy-paste examples; model id grammar; subagent example; how it works (diagram: engine → hook → provider); limits (no streaming, no caching/thinking on translated providers, Esc does not cancel a sent provider call, Max never routed); why not `ANTHROPIC_API_KEY`; troubleshooting (`/providers`, `claude --debug`); security (where keys are read, never stored by the mod)
- [ ] fresh-reader check: an agent given only the README follows the quick start in a clean config dir; fix each step it stumbles on
- [ ] CLAUDE.md with repo conventions and test commands
- [ ] remove `spike/` or move its findings into `docs/`

### Task 11: Release (only with the user's go-ahead)
- [ ] code review: code-reviewer → review-fixer → re-review (max 3 rounds)
- [ ] merge `feat/provider-router` to `main`; run `trivy repo .` and fix findings
- [ ] tag `v0.1.0` and create the GitHub release (release-tools:new)
- [ ] add the plugin to the `oleggohman/cc-things` marketplace via the marketplace-cc agent
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Informational only*

**Manual verification**:
- interactive session: `/model openai:<id>` and back; a subagent fan-out across three providers
- token usage on each provider's dashboard matches expectations

**Maintenance**:
- after each Claude Code release, run the test suite and `tsc -p .`; a type error from the new `claude-code` types flags API drift
