# Design notes: engine behaviour the router depends on

Facts about Claude Code's engine that provider-router is built on, proven by a
throwaway verification spike (Claude Code 2.1.323, November 2026) and by the
live smoke tests. The spike harness itself is no longer in the repo (see git
history, commit `66e4a3d`); this file keeps what it found. Re-check these after
a Claude Code release that changes the plugin API.

## The shadow step

A routed step needs what the engine would send: the system prompt, the tool
list with JSON schemas, and the messages with their system reminders. None of
the plugin APIs gives all of that:

| Source | Result |
|---|---|
| `$.tool.list()` | no `inputSchema` on built-in tools (663 entries, 0 schemas) |
| `tool.describe` hook | description and deferral only, no schema |
| `$.session.messages({ as: 'api' })` | messages, but no system prompt or tools |
| the engine's own request body | everything, per step, for main and subagent loops |

So a routed `turn.step` hook calls `next({ ...e, model: SHADOW_MODEL })`. The
engine builds the exact request for this step and passes it through
`http.fetch`. The mod's `http.fetch` hook takes that request, answers it
locally with a stub SSE body (it never reaches the network), and the step
drains and discards the stub. The captured body is then sent to the real
provider.

This works for subagents too: the subagent's own step calls `next`, so the
engine builds the subagent's request (its own tools and system prompt from the
agent file).

How requests are told apart:

- engine requests carry `init.compress` (`"gzip"`) and the
  `x-claude-code-session-id` header; the mod's own `$.http.fetch` calls have
  neither;
- a subagent's request carries `x-claude-code-agent-id` (absent on the main
  loop).

### Shadow model id

`SHADOW_MODEL = provider-router-shadow`, an id that does not exist, so even a
leaked request is rejected and bills nothing. Compared live against
`claude-haiku-4-5` (main loop and subagent):

| Item | Result |
|---|---|
| tool names, order, `input_schema` | identical |
| `system` | identical |
| tool descriptions, reminder wording | newest-model wording (prose only) |
| `max_tokens` | 32000 both (not shrunk) |
| `thinking`, `output_config` | adaptive thinking and `effort` added; dropped by `buildRequest` |

The engine does not reject the unknown id: it logs
`[claude-code:unrecognized_model]` and builds the request as for its newest
models.

### Fail-closed rules (do not weaken)

`hooks/shadow.ts` refuses, never passes:

- strict match: engine request, `body.model === SHADOW_MODEL`, the loop key
  from `x-claude-code-agent-id` (`main` when absent), and
  `1 <= messages.length <= e.messageCount`. `e.messageCount` counts stored
  rows, not API messages (live: 22 rows, 2 API messages), hence `<=`;
- one pending capture per loop, kept until the shadow stream has ended (also
  on error, abort, Esc); a second shadow for a pending loop is refused;
- while a shadow is pending, every other engine request for that loop is
  answered locally (a non-retryable 400), and so is any shadow-model request
  matching no entry (for example after a module reload empties the map);
- `shadowLeaks` (shadow-model requests that got past every engine-request
  rule to the last guard, and were refused there) must stay 0;
  `shadowRefused` counts stray requests refused locally. `/providers` shows
  both;
- circuit breaker: the engine's types say that where the organization's guard
  loads, only the guard's own mods see engine requests. The mod's hook then
  never runs and the shadow request goes to the first-party API (rejected
  for the unknown id, but the content has left the machine). A shadow step
  that ends uncaptured, without Esc, while the hook saw no engine request at
  all sets a module-level flag; every later shadow step is refused before
  `next` is called, until the module reloads. The first such request cannot
  be stopped from inside the mod. `/providers` shows `routing is off`. Not
  reproduced live (no organization guard to test with).

## Message threads (found in the live smoke tests)

Claude Code 2.1.323 sends the shadow requests in message-thread form:

- the first request of a loop is `thread: { type: "create" }` with everything;
- later requests are `thread: { type: "continue" }` with only the new
  messages, no tools, a system prompt reduced to the billing header, and
  `previous_message_id: msg_hook_*`;
- messages can have `role: "system"` with `tool_addition` / `tool_removal`
  blocks, and the tool list can hold a `DeferredToolPlaceholder` tool.

Other providers keep no server-side thread, and reject those forms (Z.ai:
400 "messages parameter is illegal"; the Anthropic Platform: `tool_addition`
needs a beta header). `hooks/thread.ts` therefore:

- keeps each loop's conversation in memory (system, tools, messages up to the
  last assistant turn) and rebuilds a continue as that state plus the delta;
- normalizes the body to a plain Messages API request: system messages folded
  into user text, tool additions and removals applied to `tools`, the
  placeholder tool, billing-header block, cache_control `scope` and
  `eager_input_streaming` dropped, consecutive same-role messages merged with
  `tool_result` blocks first;
- records an error step as an assistant text turn (the engine records it the
  same way) and records nothing for a step cancelled before its reply was
  delivered. A step counts as delivered once the engine has read every chunk,
  the stop chunk included, and asked for the step's result without Esc; it is
  recorded only then. A delivery cut short (Esc, the stream closed or left)
  leaves the engine holding an unknown part of the reply, so the loop's
  conversation is dropped (system prompt and tools kept) and the next
  continue is rebuilt from the session history;
- stores the tools in force after a step's `tool_addition` / `tool_removal`
  blocks, since the session history holds no tool changes;
- binds each continue's `previous_message_id` to the length of the
  conversation it built on; a continue naming an anchor bound earlier (a
  `/rewind`) cuts the conversation back to it, and one past the known
  conversation is the clear error below. Anchors are learned from the
  continues themselves (the hook never sees the id the engine gives its
  reply), so a rewind to a point before the last rebuild from history is not
  detected;
- rebuilds a continue with no known conversation from
  `$.session.messages({ as: 'api', agentId })` up to its last assistant turn.
  A history with no assistant turn is not the thread's: a fork then builds on
  the forked loop's conversation, anything else gets the clear error;
- takes the system prompt and tools for a loop it has no state for only from
  the loop it forks, by `$.agent.list()`: an id the list does not name is an
  engine fork (compaction, memory) of the main loop, a listed `fork` forks its
  `parentId` (or main). A listed subagent, or any loop when the list cannot be
  read, gets none. Known gap: workflow agents are not listed either, so one
  continuing after a reload is taken for a fork of main;
- answers a continue it cannot rebuild (after a `/config` change or plugin
  reload empties memory, with no history, or no system prompt known) with a
  clear error asking for `/clear` or `/compact`.

Rejected alternative: answering the shadow create with a
`thread_unsupported_request` 400 to make the engine resend statelessly. Hook
answered errors are classified as `hook_denied` and not retried (verified
live).

## Other engine facts

| Check | Result | Consequence |
|---|---|---|
| self-made `tool` + `input` + `stop{tool_use}` chunks | the engine runs the tool and sends a next step with the `tool_result`; `input` chunks split across yields are joined | adapters yield tool calls as chunks |
| subagent with `model: <prefixed id>` | reaches `turn.step` with that model and its `agentId` | routed subagents need no extra config |
| `--model 'x:my-gw:org/model:v1'` | reaches `turn.step` unchanged; the engine warns it does not know the model and assumes a 1M window | ids may contain `/` and `:` |
| `$.http.fetch` | POST with body and headers works; 4xx/5xx resolve with `status`, `ok: false`, `text` | no timeout, no abort, no streaming body |
| `$.clock.sleep` racing an in-flight `$.http.fetch` | does not use up the hook's 10 s budget (25 s fetch beat a 60 s timer; a 15 s timer beat a 25 s fetch) | timeout race in `call.ts`, default 600 s |
| `next.signal` | exists on `turn.step`'s `next`, aborts on Esc | Esc ends the step; the sent provider call is not cancelled |
| `userConfig` `sensitive: true` string | validates; `""` when unset | keys in `/config` live in secure storage |
| `userConfig` string list | `"type": "string[]"` fails validate; `"type": "string", "multiple": true` works and arrives as `[]` | `customEndpoints`, `contextWindows` |
| `$.config` live values | no plugin rows in `-p`; a `/config` change reloads the module with new `options` | config read from `options` + env only |
| plugin options with `--plugin-dir` | come from settings `pluginConfigs["provider-router@inline"].options` | `scripts/smoke.sh` passes them via `--settings` |
| routed `stop.usage` | does not feed `$.session.usage()` (headless) | the mod tracks input tokens per loop itself |
| `$.session.compact` | rejects while a turn runs; throws in `-p` ("no session is bound") | scheduled with `$.clock.after` after `turn.complete`, wrapped in try/catch |
| subagent auto-compact | agent definition field `autoCompactWindow` (100000 to 1000000) | README advice for routed agents |
| error stop reason | none exists | errors stop with `refusal`; context overflow with `model_context_window_exceeded` |
| usage accounting | `modelUsage` (and `/cost`) always list `provider-router-shadow` with 0 tokens and $0 | expected; the smoke test asserts it stays zero |

## Test-kit notes

See "Test-kit quirks" in `CLAUDE.md`.
