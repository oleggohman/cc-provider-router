# Provider Router mod for Claude Code

## Overview
- A Claude Code mod (plugin with a hooks module) that lets one session use several model providers at once.
- Routes every model request by the model id's prefix:
  - no prefix → the engine's own request (`yield* next(e)`), i.e. the signed-in Max subscription
  - `anthropic:<model>` → Anthropic Messages API with a Claude Platform API key (no format translation)
  - `openai:<model>` → OpenAI Platform (`https://api.openai.com/v1`) Chat Completions, translated
  - `zai:<model>` → Z.ai (GLM models) through its Anthropic-compatible endpoint `https://api.z.ai/api/anthropic` (no translation; `Authorization: Bearer` key). Z.ai's OpenAI-compatible endpoints (`/api/paas/v4` pay-as-you-go, `/api/coding/paas/v4` Coding Plan) stay reachable as `custom:` entries if ever needed.
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
- ⚠️ Routed model (changed by Task 1): run a **shadow step** — `next({ ...e, model: SHADOW_MODEL })` with a pending capture for this loop; the mod's `http.fetch` hook takes the engine's `/v1/messages` request for that loop (engine request: `init.compress` set, `x-claude-code-session-id` header; loop: `x-claude-code-agent-id` header, absent on main), answers it locally with a stub SSE body (never reaches the network), and the step drains the stub. The captured body gives system, tools (with `input_schema`), messages (with reminders) and `max_tokens`; first-party fields (`metadata`, `context_management`, `safeguards`, `thread`, `diagnostics`, `stream`, `thinking`) are dropped. Then call the provider with `$.http.fetch` (non-streaming), convert the reply to chunks, yield, return the result.
- ⚠️ **Shadow safety — fail closed** (review round 4). A shadow request must never leave the machine:
  - `SHADOW_MODEL` is a model id that does not exist (`provider-router-shadow`), so even a leaked request is rejected by Anthropic as an unknown model and bills nothing. Task 4 verifies live that the engine builds the same `tools` / `system` for this id as for a real model; if not, fall back to one documented real model and rely on the rules below alone.
  - Strict match: engine request (`compress` set) AND `body.model === SHADOW_MODEL` AND loop key (`x-claude-code-agent-id`, `main` when absent) AND `messages.length` consistent with `e.messageCount`.
  - Pending state: module-level `Map<loopKey, Pending>`; an entry lives until the shadow's `next()` stream has ended (also on error / abort / Esc), not just until the first hit. A second shadow for a key already pending is refused.
  - Refuse, never pass: while any shadow is pending, every engine request for that loop, and every engine request with `body.model === SHADOW_MODEL` that matches no entry, is answered locally (stub for the match, a local non-retryable 400 `invalid_request_error` otherwise, so the engine does not retry or fall back and the step ends). Only requests that are clearly not shadows (the mod's own fetches; other loops' real-model requests) reach `next`. Answering without `next` also covers the engine's internal retries ("sends" inside one fetch).
  - After a module reload (e.g. `/config` change) the map is empty; a stray shadow-model request is then refused by the rule above.
  - The stub reports zero usage; its chunks are drained and never yielded; the hook's own chunks and result replace the step entirely.
  - A debug counter `shadowLeaks` (shadow-model requests passed to `next`) is kept and must stay 0, plus `shadowRefused` (stray shadow requests refused locally); `/providers` shows both.
  - `buildRequest` sets `max_tokens` from the routed model's limits, not from the captured value (the engine may size it oddly for an unknown model id).
- Two adapters, each a plain function `complete(req, provider) → Reply` (no class hierarchy):
  - `anthropic`: request as is; only model id, base URL and key change. Serves `anthropic:` (`x-api-key`) and `zai:` (`Authorization: Bearer`); the provider table holds base URL + auth style, so a further Anthropic-compatible service is one table row.
  - `openai`: Anthropic ↔ Chat Completions translation; serves `openai:` and every `custom:<name>:`.
- Timeout and cancel: `call.ts` races the fetch against `$.clock.sleep(timeout, { signal })`, where `signal` is the mod's own AbortController linked to `next.signal`. When the fetch wins, the controller aborts the timer. When the person presses Esc, the step ends cleanly (no error text), and a timeout yields the error reply. The provider call itself cannot be cancelled (documented: its cost still accrues).
- ⚠️ Config reading: options arrive in `register(on, options)` and env is read at that point. Task 1: a `/config` change reloads the module with new `options`, so no live `$.config` reads.
- ⚠️ Context windows: the engine assumes 1M for unknown ids, so it would not compact in time. Task 1: routed `stop.usage` does NOT feed `$.session.usage()` (headless), and `$.session.compact` throws in `-p` ("no session is bound") — catch it. The mod reports real `usage` in `stop` and keeps the last input-token count per `agentId`. `$.session.compact` rejects while a turn runs, so compaction happens from a `turn.complete` hook, for the main loop only (no `agentId`), when input tokens passed 85% of the model's known window; its `{ skip }` result is respected. Subagents: ⚠️ the agent definition's `autoCompactWindow` (100000–1000000) is the documented knob (README advice); in addition a provider "context length exceeded" error becomes a clear message (main loop: run `/compact`; subagent: the task was too large).
- `/providers` command: configured providers, key present yes/no, and on demand `GET /v1/models` for each. No discovery at session start, no cache, no status line.
- Keys never appear in logs, state, store, errors, or replies.
- Limits in v1 (documented): no streaming for routed models, no prompt caching / extended thinking / server tools on translated providers, Max never routed.

## Technical Details
- **Config — must be simple**:
  - **Zero config via env**: `OPENAI_API_KEY` → `openai:` works; `ROUTER_ANTHROPIC_API_KEY` → `anthropic:` works; `ZAI_API_KEY` → `zai:` works (e.g. `zai:glm-5.3`). (Not `ANTHROPIC_API_KEY`: that variable makes Claude Code itself drop the Max sign-in — the README says so.)
  - **Or in `/config`** (`userConfig`, keys `sensitive` → secure storage): `openaiApiKey`, `anthropicApiKey`, `zaiApiKey`. Config value wins over env.
  - **Custom endpoints**: one `userConfig` list field `customEndpoints` (⚠️ declared `"type": "string", "multiple": true`; `string[]` fails validate), each entry `name=url` with an optional key reference, e.g. `mygateway=http://gateway.example.internal:4000/v1`; the key for endpoint `<name>` comes from env `ROUTER_<NAME>_API_KEY` (none needed for a local server). 
  - **Context windows**: built-in table for common OpenAI, Claude (`anthropic:`) and Z.ai GLM (`zai:`) models; optional `userConfig` list (`"multiple": true`) `contextWindows` entries `model=tokens`.
  - Nothing else is configurable (timeouts and limits have fixed defaults).
  - Invalid config → one clear message naming the field; the session keeps working.
- **Model id grammar**: `anthropic:<id>` | `openai:<id>` | `zai:<id>` | `custom:<name>:<id>` (`<id>` may contain `/` or `:`).
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
- **Errors**: provider failure → one text chunk `[provider-router] <provider> error <status>: <sanitized message>`; the prefix is the main signal for a parent agent. Stop reason: ⚠️ `refusal` (Task 1: no error stop reason exists; `model_context_window_exceeded` for a context-length error) (documented in the README, since refusal normally means the model declined). Key material stripped.
- **Flow**:
  ```
  turn.step(e) → route(e.model)
    none     → yield* next(e)
    provider → body  = shadowStep(e)          // next({...e, model: SHADOW}) + http.fetch capture
               req   = build(body, effort)
               reply = await race(adapter(req), sleep(timeout, next.signal))
               yield* toChunks(reply); recordUsage(e.agentId, reply.usage)
               return toResult(e, reply)
  turn.complete(e) → maybeCompact()   // main loop only, respects { skip }
  ```

## What Goes Where
- **Implementation Steps**: code, tests and docs in this repo.
- **Post-Completion**: live checks on real accounts, marketplace listing checks.

## Implementation Steps

### Task 1: Verification spike (go/no-go)
**Files:**
- Create: `spike/README.md` (findings), `spike/.claude-plugin/plugin.json`, `spike/hooks/hooks.json`, `spike/hooks/register.ts`

- [x] **GO/NO-GO — tools** — GO via (c) as a per-step shadow request (see spike/README.md); (a), (b) fail; (d) not needed.: for a main-session step and a subagent step, find the exact tool names + JSON schemas the engine would send. Try in order: (a) `$.tool.list()` `inputSchema` for built-ins; (b) a `tool.list` / `tool.describe` hook; (c) an `http.fetch` hook beneath the engine reading the body of the engine's own request on an unprefixed step and caching tools per `agentId`/agent type — NOTE this never fires for a subagent defined with a routed `model:` (it makes no unprefixed step), so (c) alone is not a pass; (d) last resort: a hand-written schema table for core tools. Record which works; if none gives schemas for a subagent's tool set → ⚠️ stop and report to the user.
- [x] **GO/NO-GO — system prompt** — GO, same capture (system, tools, messages incl. reminders).: per step and per agent, from `prompt.compose`, the agent definition, or the engine request body (as above); include system reminders that `messages({as:'api'})` leaves out.
- [x] verify a subagent with `model: spike-echo` in its definition reaches the hook with that model and its `agentId`
- [x] verify a self-made `tool` + `input` + `stop{tool_use}` reply makes the engine run the tool and send a next step with the `tool_result`
- [x] verify `$.http.fetch` POST with JSON body and headers, 4xx/5xx shape; verify `Promise.race` with `$.clock.sleep(ms, { signal: next.signal })` ends the step on Esc (race + `next.signal` verified; Esc itself skipped - not automatable in `-p`, check in Task 8)
- [x] verify `claude plugin test` with `on('http.fetch')` beneath the mod intercepts the mod's own `$.http.fetch`
- [x] verify `userConfig` with `sensitive: true` string and a string[] field; how `/model` accepts a prefixed id; whether `stop.usage` feeds the context meter; `$.session.compact` from a `turn.complete` hook (main loop) works; whether a routed subagent's own auto-compact token threshold can be set; whether a step can end with an error stop reason (else `refusal`); whether `$.config` returns live values after a `/config` change (results in spike/README.md; compact and interactive `/model` unverified in `-p`, moved to Task 8)
- [x] write findings to `spike/README.md`; revise Tasks 2–7 here before continuing

### Task 2: Plugin skeleton and model-id router
**Files:**
- Create: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.ts`, `hooks/route.ts`, `hooks/route.test.ts`
- Create: `package.json` (scripts: test, typecheck, validate), `.gitignore`, `LICENSE` (MIT), `README.md` stub

- [ ] write tests for `parseModel()`: no prefix, `anthropic:`, `openai:`, `zai:` (and `zai:` with an empty id), `custom:<name>:`, ids containing `/` and `:`, unknown custom name, empty id
- [ ] implement `parseModel()`
- [ ] write test: unprefixed `turn.step` passes through to `next` unchanged
- [ ] implement the `turn.step` hook skeleton (pass-through + dispatch stub)
- [ ] ➕ tests read `$.turn.step(...)` with `.next()` until `done` (`stream.result` is undefined in the kit); op hooks answer `{ value }`; stub `clock.sleep`
- [ ] run `claude plugin test .`, `tsc -p .`, `claude plugin validate .` — must pass before Task 3

### Task 3: Configuration and keys
**Files:**
- Create: `hooks/config.ts`, `hooks/config.test.ts`
- Modify: `.claude-plugin/plugin.json` (`userConfig`: `openaiApiKey`, `anthropicApiKey`, `zaiApiKey` sensitive; ⚠️ `customEndpoints`, `contextWindows` as `"type": "string", "multiple": true`)

- [ ] write tests: env-only, `/config`-only, both (config wins), custom endpoint parsing `name=url`, its key from `ROUTER_<NAME>_API_KEY`, invalid entry → clear message naming the field
- [ ] implement `loadConfig($)`
- [ ] write test: a missing key error names the variable or `/config` field, never a value
- [ ] ➕ write tests: empty `customEndpoints` list → no custom endpoints; malformed `name=url` entry skipped with a warning, no crash
- [ ] ⚠️ write test: config comes only from `register` `options` + env (module reloads on `/config` change; no `$.config` reads)
- [ ] run tests — must pass before Task 4

### Task 4: Request builder and error module
**Files:**
- Create: `hooks/request.ts`, `hooks/request.test.ts`, `hooks/shadow.ts`, `hooks/shadow.test.ts`, `hooks/errors.ts`, `hooks/errors.test.ts`
- Create: `tests/fixtures/` (transcripts: text only, tool round-trip, images, documents, thinking blocks, subagent)

- [ ] ➕ live check (spike harness, few short haiku-main runs): with `SHADOW_MODEL = provider-router-shadow`, the captured `tools` / `system` for main and a subagent equal those captured with `claude-haiku-4-5`; also record what the engine does with the unknown id before building the request (rejects it? shrinks `max_tokens` / thinking?); record in `spike/README.md`; if they differ, use the documented real model and note it (⚠️)
- [ ] ➕ write tests for `shadow.ts` (strict match + fail closed, see Solution Overview). Every test asserts the hook beneath the mod (the network) was called **0 times** for shadow traffic: match answered with stub; header missing; a 2nd and 3rd engine request in the same step; a side request (other model, no tools) on a pending loop; a shadow-model request matching no entry; pending kept until the stream ends and cleared after (success, error, abort); a second shadow on an already-pending key refused; main + subagent pending at once; two instances of the same agent type in parallel; empty map after reload refuses a stray shadow request; a refused shadow step ends (400, no retry loop) and bumps `shadowRefused`
- [ ] ➕ write tests: the stub's chunks are never yielded, its usage is zero, `shadowLeaks` stays 0; the mod's own fetches pass through
- [ ] ➕ implement `shadow.ts` (`shadowStep($, e, next)` → captured body; `Map<loopKey, Pending>`; refuse rule; `shadowLeaks` counter)
- [ ] ⚠️ write tests building the provider request from the captured body (system, tools, messages, `max_tokens`; first-party fields dropped; model replaced), including subagent tool sets
- [ ] ➕ write tests (fixture): deferred tools / tool search (`defer_loading`, `tool_reference` blocks) are flattened or dropped for the OpenAI adapter and kept for Anthropic-compatible ones
- [ ] implement `buildRequest(body, e)`
- [ ] ⚠️ write tests for `errors.ts`: status → message, key stripping, stop reason `refusal` (`model_context_window_exceeded` for context-length errors); a parent agent receives the `[provider-router]`-prefixed text from a refusal-stopped subagent step
- [ ] implement `errors.ts`
- [ ] run tests — must pass before Task 5

### Task 5: Anthropic Platform adapter, chunks, timeout and cancel
**Files:**
- Create: `hooks/providers/anthropic.ts`, `hooks/providers/anthropic.test.ts`, `hooks/chunks.ts`, `hooks/chunks.test.ts`, `hooks/call.ts`, `hooks/call.test.ts`

- [ ] write tests for `toChunks()`/`toResult()`: text, tool calls, mixed, each stop reason, usage
- [ ] implement `chunks.ts`
- [ ] write tests for `call.ts`: success (timer aborted, no leftover sleep), timeout (error reply), Esc before reply (step ends cleanly, no error text, no unhandled rejection) — ⚠️ Esc simulated by aborting `next.signal` in tests; the real key is a Task 8 manual check
- [ ] implement `call.ts`
- [ ] write adapter tests with mocked `http.fetch`: success, tool_use reply, 401, 429, 5xx
- [ ] implement the adapter (`POST <base>/v1/messages`, `anthropic-version`, auth per provider row); wire `anthropic:` and `zai:`; hook-level tests through `turn.step` for both
- [ ] write tests for the `zai:` row: Bearer header, base URL, Z.ai error body shape (mocked)
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

- [ ] write tests: window lookup (built-in table incl. a `zai:glm-*` id, `contextWindows` override, unknown); compact called from `turn.complete` after an 85% step on the main loop and never during `turn.step`; not called for a subagent; `{ skip }` respected; "context length exceeded" → message per loop type
- [ ] ➕ write test: compact is never called synchronously inside the `turn.complete` hook; it is scheduled with `$.clock.after` after `next(e)` returns
- [ ] ⚠️ implement `context.ts`: own per-loop usage tracking (routed usage does not reach `$.session.usage()`); `$.session.compact` scheduled via `$.clock.after` after `turn.complete`'s `next(e)` returns, wrapped in try/catch (rejects mid-turn, throws in `-p`); README recommends `autoCompactWindow` in routed agent definitions
- [ ] write tests for `/providers`: configured providers, key yes/no, on-demand model listing for Anthropic and OpenAI shapes, provider down
- [ ] implement `/providers`
- [ ] write a test that no log, status, state or reply in the whole suite contains a test key value; run `mcp__plugin-authoring__scan_secrets` on the repo
- [ ] run tests — must pass before Task 8

### Task 8: Live smoke tests
**Files:**
- Create: `scripts/smoke.sh`, `examples/agents/gpt-worker.md`, `examples/agents/platform-opus.md`

- [ ] write `scripts/smoke.sh`: per provider whose key is set, `claude -p --plugin-dir . --model <prefixed id>` with a tool-using prompt; assert reply and tool run
- [ ] add example subagents using `model: openai:<id>` and `model: anthropic:<id>`
- [ ] run smoke for Anthropic Platform, OpenAI Platform and Z.ai (`zai:glm-5.3`)
- [ ] custom endpoint: start LiteLLM on a test Docker host, run smoke against it, then stop and remove the container
- [ ] verify main session on Max and a subagent on another provider run in parallel in one session
- [ ] ➕ zero-leak check in `scripts/smoke.sh`: after each run `shadowLeaks` is 0 and session usage / `/cost` shows no shadow-model or extra haiku entries; run for main routed, one routed subagent, and 2 routed subagents in parallel while main runs on Max
- [ ] ➕ manual: transcript (`$.session.messages`) and `/cost` contain no stub text and no shadow-model entries
- [ ] ➕ manual (from Task 1): Esc during a routed step ends it cleanly; interactive `/model <prefixed id>` accepted; `$.session.compact` from `turn.complete` works interactively

### Task 9: Verify acceptance criteria
- [ ] all routes work (none / anthropic / openai / zai / custom); config is env-or-`/config` only, plus `customEndpoints`
- [ ] timeout, cancel, error and context-limit paths behave as specified
- [ ] `claude plugin test .`, `tsc -p .`, `claude plugin validate .` all pass; show output
- [ ] every module has success and error tests

### Task 10: README and docs (user requirement: a good README)
- [ ] README.md: one-paragraph pitch; 60-second quick start (install from marketplace, set one env var — `OPENAI_API_KEY`, `ROUTER_ANTHROPIC_API_KEY` or `ZAI_API_KEY` — then `/model openai:gpt-5` or `/model zai:glm-5.3`); note that Z.ai's OpenAI-compatible endpoints can be added as `custom:` entries; configuration (env, `/config`, custom endpoints) with copy-paste examples; model id grammar; subagent example; how it works (diagram: engine → hook → provider); limits (no streaming, no caching/thinking on translated providers, Esc does not cancel a sent provider call, Max never routed); why not `ANTHROPIC_API_KEY`; troubleshooting (`/providers`, `claude --debug`); security (where keys are read, never stored by the mod)
- [ ] fresh-reader check: an agent given only the README follows the quick start in a clean config dir; fix each step it stumbles on
- [ ] CLAUDE.md with repo conventions and test commands
- [ ] remove `spike/` or move its findings into `docs/`

### Task 11: Release (only with the user's go-ahead)
- [ ] code review: code-reviewer → review-fixer → re-review (max 3 rounds)
- [ ] run `mcp__plugin-authoring__scan_secrets` again on the final tree
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
