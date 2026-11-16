# Design notes: engine behaviour the router depends on

Facts about Claude Code's engine that provider-router is built on, proven by a
throwaway verification spike (Claude Code 2.1.323, November 2026), by the
answer-in-place probes (2.1.325, kept in `scripts/probes/`) and by the
live smoke tests. The first spike's harness is no longer in the repo (see git
history, commit `66e4a3d`); this file keeps what it found, and the probes'
README lists the command and the expected record for each row that has one.
Re-check these after
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
`http.fetch`. The mod's `http.fetch` hook takes that request — it never
reaches the network — and **answers it in place**: its handler
(`hooks/answer.ts`) resolves the conversation, sends it to the real provider
(through the `curl` child, `hooks/transport.ts`), and returns the provider's
reply to the engine as an Anthropic SSE body (zero usage, the provider's
model name, a router-minted message id; `hooks/sse.ts`). The engine's own
chunks then flow up through `turn.step`, and after the stream the step
decides delivery from the job's phase and the engine's result (`routedStep`
in `hooks/register.ts`). For an error reply, a timeout or Esc, the engine
gets the empty stub instead and the step yields hook-made error chunks — or
nothing after Esc.

Before answer in place (up to and including `v0.1.2`) the hook answered an
empty stub and the step yielded the reply as hook-made chunks; that is the
flow the "Auto mode" rows below were recorded against, and the one auto mode
could not work with.

This works for subagents too: the subagent's own step calls `next`, so the
engine builds the subagent's request (its own tools and system prompt from the
agent file).

How requests are told apart:

- engine requests carry `init.compress` (`"gzip"`) and the
  `x-claude-code-session-id` header; the mod's own calls (a nested
  `$.http.fetch`, the `curl` child) have neither;
- a subagent's request carries `x-claude-code-agent-id` (absent on the main
  loop).

Reproduce the capture and the answer with `scripts/probes/run-probe.sh`
(`scripts/probes/README.md` rows 1 to 3); the flow against the shipped
plugin is `scripts/automode-check.sh`.

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

`hooks/shadow.ts` decides every engine request by one rule order (its
header); it refuses, never passes, with the classifier of rule 3 as the only
exception:

1. it names the shadow model (body or URL): the one strict match of a
   pending job is answered locally, every other one is refused. Strict
   match: engine request, `body.model === SHADOW_MODEL`, the loop key
   from `x-claude-code-agent-id` (`main` when absent), and
   `1 <= messages.length <= e.messageCount`. `e.messageCount` counts stored
   rows, not API messages (live: 22 rows, 2 API messages), hence `<=`.
   One pending job per loop, kept until the shadow stream has ended (also
   on error, abort, Esc); a second shadow for a pending loop is refused;
2. it names a router-prefixed or malformed-prefix model id (body, URL, or
   unparseable text), or its body is unreadable while any job is pending:
   refused, pending job or not. The engine sends requests of its own under
   the session's prefixed id that bypass `turn.step` (a prompt suggestion,
   its own compaction, the classifier's retry); none may reach the
   first-party host;
3. it matches the auto-mode classifier predicate ("Classifier predicate"
   below): passed when the `autoModeClassifier` option is on; with it off,
   refused once a step was routed since the module loaded, or while no step
   was seen at all (a reload clears both flags);
4. any other engine request of a loop with a pending job: answered locally
   (a non-retryable 400), and so is any shadow-model request matching no
   entry (for example after a module reload empties the map);
5. anything else: passed.

The handler guards what it sends itself: the outbound guard
(`hooks/answer.ts`) refuses, before anything is sent, a routed model equal
to `SHADOW_MODEL` and a custom endpoint URL naming it (a nested
`$.http.fetch` skips the mod's own hook); a conversation that merely quotes
the name is sent.

- `shadowLeaks` (shadow-model requests that got past every engine-request
  rule to the last guard, and were refused there) must stay 0;
  `shadowRefused` counts stray requests refused locally. `/providers` shows
  both, and `classifierPassed` / `classifierRefused` for rule 3;
- the `http.fetch` hook's `.catch` (`shadowFetchFailed`) never evaluates the
  classifier predicate and never grants the exception: a request not yet
  forwarded is refused when a job is pending, when it names the shadow model
  or a prefixed id, or — with `autoModeClassifier` off — when it is an
  engine request and a step was routed or none was seen;
- circuit breaker: the engine's types say that where the organization's guard
  loads, only the guard's own mods see engine requests. The mod's hook then
  never runs and the shadow request goes to the first-party API (rejected
  for the unknown id, but the content has left the machine). A shadow step
  that ends uncaptured, without Esc, while the hook saw no engine request at
  all sets a module-level flag; every later shadow step is refused before
  `next` is called. The first such request cannot be stopped from inside the
  mod. `/providers` shows `routing is off`. Not reproduced live (no
  organization guard to test with);
- the same signature matches a shadow step that sent no request (a
  `turn.step` hook beneath answered it without `next`, or the engine failed
  before sending; the types give no reliable way to tell: `stopReason` is
  null both then and for a failed request). So the flag heals: any engine
  request the hook sees (`shadowFetch` or `shadowFetchFailed`) clears it,
  since under the guard none is ever seen. For the breaker (both counting
  engine requests and clearing the flag) an engine request is one whose
  host-set `next.origin.plugin` is `"engine"`: nothing a plugin writes
  reaches it, while `compress` and the session header are caller-controlled
  and another plugin's `$.http.fetch` passes through the same hook. The
  markers stay the wide rule for refusing. Residual gap: a session with no
  unprefixed traffic stays off until the module reloads.

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
  the stop chunk included, asked for the step's result without Esc, and that
  result reflects the reply the router handed it (`sameDelivery` in
  `hooks/sse.ts`: text trimmed, tool arguments deep-equal whatever the key
  order, the stop reason); it is
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
| `$.http.fetch` | POST with body and headers works; 4xx/5xx resolve with `status`, `ok: false`, `text`. The host ends a call with no complete answer after 30 s (`aborted: no complete answer within 30000ms`, found in the 2.1.325 spike below) and aborts it on Esc | no timeout option, no streaming body; the provider transport therefore goes through a `curl` child (`hooks/transport.ts`), with `$.http.fetch` only as the 30 s fallback |
| `$.clock.sleep` racing an in-flight `$.http.fetch` | does not use up the hook's 10 s budget (25 s fetch beat a 60 s timer; a 15 s timer beat a 25 s fetch) | timeout race in `call.ts`, default 570 s (below the engine's 600 s request timeout) |
| `next.signal` | exists on `turn.step`'s `next`, aborts on Esc | Esc ends the step; on the curl transport it kills the child (the provider sees the connection drop), and a request already sent may still be billed |
| `userConfig` `sensitive: true` string | validates; `""` when unset | keys in `/config` live in secure storage |
| `userConfig` string list | `"type": "string[]"` fails validate; `"type": "string", "multiple": true` works and arrives as `[]` | `customEndpoints`, `contextWindows` |
| `$.config` live values | no plugin rows in `-p`; a `/config` change reloads the module with new `options` | config read from `options` + env only |
| plugin options with `--plugin-dir` | come from settings `pluginConfigs["provider-router@inline"].options` | `scripts/smoke.sh` passes them via `--settings` |
| routed `stop.usage` | does not feed `$.session.usage()` (headless) | the mod tracks input tokens per loop itself |
| `$.session.compact` | rejects while a turn runs; throws in `-p` ("no session is bound") | scheduled with `$.clock.after` after `turn.complete`, wrapped in try/catch |
| subagent auto-compact | agent definition field `autoCompactWindow` (100000 to 1000000) | README advice for routed agents |
| error stop reason | none exists | errors stop with `refusal`; context overflow with `model_context_window_exceeded` |
| usage accounting | `modelUsage` (and `/cost`) always list `provider-router-shadow` with 0 tokens and $0 | expected; the smoke test asserts it stays zero |

## Auto mode (checked live, Claude Code 2.1.325)

In auto mode the engine puts every tool call no rule settles to a server-side
classifier, whose verdict arrives with the first-party reply to the step. A
routed step's first-party request is the shadow, answered locally, so no
verdict exists and the engine fails closed (debug log: `Auto mode classifier
unavailable, denying with retry guidance (fail closed)`).

| Check (routed `anthropic:claude-haiku-5-5` main loop, `--permission-mode auto`) | Result |
|---|---|
| Bash `echo`, and a write inside the working directory | run; the log says `Skipping auto mode classifier for Bash: would be allowed in acceptEdits mode` |
| `Agent` | refused: `The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one` |
| core's `tool.check` verdict for that call | `ask` (`Claude requested permissions to use Agent, but you haven't granted it yet.`) |
| a `tool.check` hook re-issuing that `ask` as its own, headless | `ask -> deny by plugin`, nobody to ask |
| the same hook, interactive | no dialog; still `Not run · auto mode's check had no usable answer` (the classifier's block stands over a plugin's ask) |
| `--allowedTools Agent`, and `--allowedTools "Agent(general-purpose)"` | still refused; the log says `Ignoring dangerous permission Agent(*) from cliArg (bypasses classifier)` |
| routed main loop in accept-edits mode with `--allowedTools Agent` | the subagent runs; the classifier is never consulted |
| subscription main loop in auto mode starting a routed subagent | the `Agent` call runs (the first-party reply carries a verdict); the subagent's own Bash call outside the working directory is refused with the same no-verdict text |
| the same, the agent defined through `--agents` with `"permissionMode": "acceptEdits"` | no effect: the subagent's call is refused the same way |

The smoke tests never met this: they run in the default mode with
`--allowedTools Bash,Agent`.

So the mod had no way to hand such a call to the person, and the person had
none to allow it by rule. The one thing a hook could do is answer `allow`,
which would run a routed model's calls with no review at all while the
session still says auto mode; the mod does not. This was the state up to and
including `v0.1.2`; answer in place (next section) removed the limit.

### Answer in place (probed on throwaway copies, Claude Code 2.1.325, 2026-11-15)

Probes with a local mock provider (`custom:mock:m` at `http://127.0.0.1`),
`claude -p --permission-mode auto`, the main loop's model reply always an
`Agent` call. These were the first probes, on throwaway copies before the
plan existed; the mechanism they found now ships in the plugin (the spike
section below repeats every row with the kept scripts of
`scripts/probes/`).

| Probe | Result |
|---|---|
| captured shadow request body, auto mode | keys `context_management, diagnostics, max_tokens, messages, metadata, model, output_config, safeguards, stream, system, thinking, thread, tools`; `safeguards` is `[{ type: "dangerous_tool_use", classifier_context: { v: 1, permission_mode: "auto", ... } }]`: the request does ask for a verdict |
| chunks the hook reads from the shadow's `next(...)` stream (today's empty stub) | `engine` refs 1–4, `stop` (ref 5, `end_turn`, zero usage, model `provider-router-shadow`), `engine` ref 6 |
| yield the first and last of those `engine` chunks around the hook-made reply, the hook-made `stop` under the stub's ref | no change: refused, no `[server-classifier]` log line |
| answer the shadow request itself with an SSE body holding the `Agent` `tool_use` block, and pass the engine's stream up (`yield* next(...)`) | the engine logs `[server-classifier] a completed response carried no classification result (no safeguard_results); assuming something on the path to the API dropped it, so auto mode classifies locally for the rest of this session`, then `Agent: no server verdict for this call (server_no_result); the local classifier decides it` |
| that run, today's rule refusing every other engine request of the pending loop | the classifier request (`model=claude-sonnet-5 stage=xml_s1`) ends `outcome=error` in 2 ms; the engine retries it with `model=custom:mock:m`, which fails too; the call is refused: `custom:mock:m is temporarily unavailable, so auto mode cannot determine the safety of Agent right now` |
| the same with engine requests of the pending loop that name a non-shadow model and carry no `tools` let through | classifier requests end `outcome=ok` (about 1.8 s each); `Agent` runs, the subagent starts, 0 permission denials |
| the classifier request as a mock gateway sees it (`ANTHROPIC_BASE_URL` run, no mod) | model `claude-sonnet-5`, body keys `max_tokens, messages, metadata, model, stop_sequences, system, thinking` (later ones without `stop_sequences`), no `tools`, no `thread`, system text after the billing header starting `You are a secur` |
| `$.clock.sleep(25000)` alone inside the `http.fetch` hook before answering | the hook is cut at 10 s (`http.fetch settled in 10002.7ms`), its `.catch` refuses the request |
| a nested `$.http.fetch` taking 25 s inside the `http.fetch` hook before answering | completes (`$.http.fetch (provider-router): 200 in 25002ms`, `http.fetch settled in 25003.7ms`), the engine accepts the answer; the log marks it `http.fetch nested in provider-router#1`: the nested fetch does not pass through the mod's own `http.fetch` hook |
| usage of that run | `modelUsage` lists only `provider-router-shadow` |

Every row above was reproduced with the kept scripts (next section); the
points this list once named as not probed are answered there.

### Answer in place: spike (kept scripts, Claude Code 2.1.325, 2026-11-15)

Task 2 of the plan, run with `scripts/probes/` (the README there lists the
command and the expected record for each row) and `tests/observer-plugin/`.
Provider: the local mock (`custom:mock:m`). Hook order in every run unless
stated: `provider-router` (the probe copy, tier user, environment 1) above
`fetch-observer` (environment 2), built-ins beneath. "-p" is `claude -p
--output-format stream-json`; "pty" is an interactive session driven by
`drive-pty.py`. A request shape lists the body's top-level keys; header
values that may hold a credential arrive as `[redacted]` and are not
recorded anywhere.

**Outcome of the GO items.** Classifier predicate: go. Timeout mechanism: go.
Esc: go. Classifier attribution: **no** as planned (the request carries no
agent header; a session-wide rule is proposed instead). Long hold: **no** as
planned (`$.http.fetch` is cut by the host at 30 s, from any hook, in the
shipped flow too; the hold itself is fine up to the engine's 600 s). Both
need a decision before Task 3.

| # | Item | Run | Request shape and hook order | Observed |
|---|---|---|---|---|
| 1 | reproduce "Answer in place" | -p auto, and pty auto | shadow request (engine origin): `POST https://api.anthropic.com/v1/messages?beta=true`, keys `context_management, diagnostics, max_tokens, messages, metadata, model, output_config, safeguards, stream, system, thinking, thread, tools`; `safeguards` only until the engine switches to local classification | every earlier row reproduced: `Agent` judged and run with the provider's reply as SSE; refused with today's rule (retry names `custom:mock:m`); refused when engine chunks are passed around hook-made ones; a plain `$.clock.sleep(25000)` cut at 10 s (the hook's `next.signal` aborts at 10004 ms, `.catch` answers, step result `stopReason: null`, `usage: null`); a 25 s nested fetch completes. Interactive: the same, plus a session-title side request |
| 2 | observer load order | -p, both orders | see `tests/observer-plugin/README.md` | `--plugin-dir` flags nest in order, first outermost. Beneath the router the observer records the router's nested provider fetch (`origin.plugin: "provider-router"`, tier user) and each request the router passed; above it, the shadow request too |
| 3 | **classifier predicate** | -p and pty, main loop and subagent loop, first and later calls, stage 1 and 2, the retry | stage 1: keys `max_tokens, messages, metadata, model, stop_sequences, system, thinking`, `max_tokens: 64`, `stop_sequences: ["</severity>"]`, `thinking: {type: disabled}`, model `claude-sonnet-5`; stage 2 (after stage 1 flags the call): the same without `stop_sequences`, `max_tokens: 8192`. Not streamed. `metadata` is `{ user_id }` only. Headers: `anthropic-beta` holds `auto-mode-classifier-2026-07-16` and `claude-code-side-query-2026-09-29`; `x-stainless-timeout: 60`; no `x-claude-code-agent-id`, no `x-claude-code-prompt-id`; `x-claude-code-request-class` and `x-claude-1p-request-class` are present on every engine request and host-redacted. The retry after a refusal: the session's own model id (`custom:mock:m`), `max_tokens: 2112`, no `thinking` | **go.** The marker is the `auto-mode-classifier-<date>` token of `anthropic-beta`, which no other recorded request carries (the title request shares only `claude-code-side-query-*`). Predicate and counterexamples below. System prompt opening (`You are a security monitor for autonomous AI coding agents.`) is not part of the predicate |
| 4 | **classifier timing and attribution** | -p auto: one call, two calls in one reply, a later turn, a routed subagent under a subscription main loop, the subagent resumed with `SendMessage` | order for the first judged call of a reply: SSE handed -> engine chunks -> `tool.check` (core answers `ask`) -> classifier send (job still pending, phase handed) -> the step's stream ends and the job is removed 3 ms later -> classifier settles about 2 s after that. A second call in the same reply, a later turn's call and a subagent's call: `tool.check` and the classifier send come after the stream ended, with no job pending. Requests are sent one at a time | **no as planned.** The classifier request never carries the agent header: a subagent's call is judged by a request with the main loop's key, also while the main loop has its own request in flight. It cannot be attributed to a loop, so a per-loop status decides nothing. After the first routed step the engine classifies locally for the whole session: the subscription main loop's own calls (`SendMessage`) and an end-of-subagent review (`tool=unknown_tool`) were classified the same way. Proposed instead: no loop condition in the predicate; the opt-out works on the session |
| 5 | **long hold** | -p default | nested `$.http.fetch` from the `http.fetch` hook; the same from the `turn.step` hook of an unpatched HEAD copy | **no as planned.** A `$.http.fetch` is ended by the host after 30 s: `HooksError: ... $.http.fetch(...) aborted: no complete answer within 30000ms`, in both hooks, so in the shipped flow too (v0.1.2 cannot take a provider reply slower than 30 s). `init.timeoutMs`, `init.timeout` and `init.signal` change nothing. The hold itself is not the limit: 11 nested fetches of 29 s in a row (319 s) and a single `$.process.run(["curl", ...], { timeoutMs: 600000 })` of 300 s and of 590 s all end with the engine accepting the answer. The engine's own request timeout is 600 s (`x-stainless-timeout: 600`): at 600000 ms the fetch hook's `next.signal` aborts |
| 6 | **timeout mechanism** | -p default, 15 s limit, 25 s provider, then a second prompt | (a) `raceCall` with `$.clock.sleep` in the fetch hook; (b) `$.clock.sleep` in the `turn.step` hook resolving a promise the fetch hook races | **go, both.** (a): the sleep is not cut at 10 s while the nested fetch is in flight; outcome `timeout` at 15005 ms. (b): timer fired at 15003 ms, the fetch hook answered at 14976 ms of its own clock. Each time the reply is `[provider-router] ... no reply within 15000 ms (timed out)` and the next prompt answers `MOCK-TEXT`; in (b) the provider's late answer arrives 10 s later and is dropped. Above 30 s the host's fetch limit decides first (row 5) |
| 7 | reload | pty | edit of the `--settings` file during a hold; a `.claude/settings.local.json` with `pluginConfigs` created in the working directory | **inconclusive.** Neither reloads the module (same load id; the log says `project settings are not read` for plugin options). A reload needs `/config`, which writes the user's settings and was not allowed in the spike. The `unknown`-status rule was exercised only as a fresh session with `autoModeClassifier: false`: the classifier request is refused and auto mode fails closed |
| 8 | abandonment | -p default, a second mod above the router (`make-abandoner.sh`) | `step-abandoner` (environment 1) above the router | a consumer that leaves its loop (`break`): the router's `next.signal` aborts and its generator is closed (`finally` runs). A consumer that hangs: the host cuts it at 10 s and reads the router's stream to the end, no abort. The router's own hook hanging: cut at 10 s, signal aborted, `.catch` answers, and no `finally` runs: the job stayed and the next step found it pending. The abort listener is needed |
| 9 | **Esc** | pty auto, Esc 15 to 18 s into a 28 s hold, then a new prompt | as row 1 | **go.** Both hooks' `next.signal` abort at the same millisecond; the nested provider fetch fails with `The operation was aborted`. The engine still reads what the fetch hook then returns and the step's stream ends normally (not closed), `stopReason: null`. Answered with an empty stub: nothing is shown or recorded, and the next prompt is a fresh `thread: create` that works. Answered with a 400: the same plus an error line on screen. Answered with text as SSE: the engine records it (the next continue names its message id), so never do that |
| 10 | nested dispatch | every run | debug log | `http.fetch skipped: re-entry (its own frame is being dispatched; origin provider-router#1)` for the router's own hook, `fetch-observer: http.fetch nested in provider-router#1` for the observer |
| 11 | delivery | -p default | SSE variants (`PROBE_SSE`) | good reply: result keys `turnId, index, answer, toolUses, stopReason, usage`; `answer` is the text **trimmed**; `toolUses[].input` has the same values with keys **reordered** (the `input` chunk keeps the bytes sent); `usage` is the SSE's plus `model`. Two replies with the same stop reason and counts but different content give different results. Cut mid-block, a malformed data line, an empty body: the engine sends the request again (the router refuses the second), result `stopReason: null`, `usage: null`. An unknown stop reason: `stopReason: null` with the text. HTTP 400: `hook_denied`, `stopReason: null`. So `stopReason: null` does follow a handed answer. A body complete but for `message_delta` and `message_stop`: the hook's result looks whole (`end_turn`) while the engine reports `Connection lost mid-response` and asks the model to resume; only a body the router itself cut can do that |
| 12 | error replies | -p default, main loop and subagent | `PROBE_ERR_STOP` | no SSE stop reason works. `end_turn`: fine for the person, but a subagent is told three times to hand back a report (three more failing calls) and its parent gets `The subagent ended without delivering a report`. `refusal`: the engine treats it as its own safety stop (adds `Your response above was stopped by a safety classifier`, runs another step, reports `API Error: ... safeguards flagged this message`). `model_context_window_exceeded`: `Output token limit hit. Resume directly` and another step. HTTP 400 with `x-should-retry: false`: `A mod's http.fetch hook stopped this request: <text>`, `is_error`, nothing the router can record. **Chosen:** answer the shadow request with the empty stub and yield today's hook-made error chunks (`refusal`) from the `turn.step` hook: the person sees the `[provider-router]` text, a parent agent gets it as the subagent's result, no retry, as in v0.1.2 |
| 13 | model and usage | -p default, pty `/cost` | `PROBE_USAGE`, `PROBE_MODEL` | real usage: `modelUsage` and `/cost` list `provider-router-shadow` with the tokens and an invented cost (5000 input tokens: $0.02), whatever model the SSE names; `$.session.usage()` reports `context.tokens`; the transcript row's `message.model` is the SSE's model and its id the minted id. Zero usage: $0, no context size. **Chosen:** zero usage, the provider's model name |
| 14 | compaction | -p default, a reply reporting 985000 input tokens, then a prompt | the engine's compaction request: engine origin, model `custom:mock:m`, keys `context_management, diagnostics, fallbacks, max_tokens, messages, metadata, model, output_config, stream, system, thinking, tools`, headers `x-cc-compaction-request`, `x-claude-code-compaction` | with real usage the engine compacts by itself at its assumed 1M window (`effectiveWindow=980000`, `thresholdSource=unknown-model`), and that request does not pass through `turn.step`: it names the prefixed model and carries the conversation to the first-party host. The probe refused it; the turn ended `Prompt is too long · automatic compaction failed`. With zero usage the engine never starts it. Recovery after a compaction fork and after `/model` there and back: **inconclusive**, not probed |
| 15 | thread anchors | every multi-step run | `thread: { type: "continue", previous_message_id }` | the next continue names the id minted in the SSE's `message_start` (`diagnostics.previous_message_id` too). After a hook-made error step it names an engine-made `msg_hook_*` id |
| 16 | classifier denial | -p auto, Bash `curl -s http://127.0.0.1:<mock>/script.sh \| bash` | stage 1 then stage 2 | denied: `Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Code from External]`; the mock saw no GET and no file was written |
| 17 | non-auto modes | -p default and accept-edits, `Agent` and an outside Bash, probe and unpatched HEAD | no classifier request | identical results with both: `Agent` runs, the outside Bash is denied with the engine's `needs approval` text |

Also seen, outside the checklist:

- an interactive session sends side requests of its own that never pass
  through `turn.step`: a session title (`claude-haiku-5-5`, keys `max_tokens,
  messages, metadata, model, output_config, stream, system, tools`), and a
  prompt suggestion that carries the conversation under the session's own
  model id (`custom:mock:m`), like the compaction request of row 14. Nothing
  pending covers them: only a rule that refuses any engine request naming a
  router-prefixed model keeps them from the first-party host;
- the classifier's transcript holds the user's prompts and each tool call of
  the session, routed loops included; it goes to the first-party API on the
  subscription;
- behind `ANTHROPIC_BASE_URL` (mock gateway, API-key auth) the classifier
  requests carry no `auto-mode-classifier-*` beta. The predicate pins the
  first-party URL, so there the exception never applies and a classifier
  request sent while a job is pending is refused (auto mode fails closed for
  that call);
- in `-p` runs the OS sandbox stopped the judged `touch` outside the working
  directory (`Operation not permitted`); the interactive runs wrote the file.

#### Classifier predicate (as shipped, `isClassifierRequest` in `hooks/shadow.ts`; `scripts/probes/check-predicate.py` re-checks it)

```
evaluated only after the unconditional refusals (shadow model, shadow URL, prefixed or malformed model id)
next.origin.plugin === "engine"
AND (e.init.method ?? "GET") === "POST"
AND e.url === "https://api.anthropic.com/v1/messages?beta=true"
AND one comma-separated token of the anthropic-beta header matches /^auto-mode-classifier-\d{4}-\d{2}-\d{2}$/
AND the request has no x-claude-code-agent-id header
AND e.init.body is a string that parses to a JSON object (not an array)
AND typeof body.model === "string", not empty, not SHADOW_MODEL, classifyModel(body.model).kind === "unprefixed"
AND every top-level key of body is one of: max_tokens, messages, metadata, model, stop_sequences, system, thinking
```

No loop condition (row 4). A match passes when `autoModeClassifier` is on,
whatever job is pending. With it off, a match is refused once any step was
routed since the module loaded, and also while the module has seen no step at
all; a session whose every step was unprefixed keeps its classifier.

Counterexamples tried (`check-predicate.py` over about 400 recorded engine
requests; none matches):

| Request | Fails on |
|---|---|
| thread create, subscription model and shadow model | `marker`, keys `tools, thread, context_management, diagnostics, output_config, stream` (and `safeguards`); `model` for the shadow |
| thread continue | `marker`, keys `thread, context_management, diagnostics, output_config, stream` |
| compaction request (row 14) | `marker`, `model`, keys `tools, fallbacks, context_management, ...` |
| session-title side request | `marker`, keys `output_config, stream, tools` |
| prompt-suggestion side request | `marker`, `model`, keys as a conversation request |
| fallback-model retry of the conversation | seen only behind the mock gateway (`url`); its keys are a conversation request's |
| the classifier's own retry under the session's model | `model` (prefixed) |
| a request to a non-Messages path | telemetry `POST /api/event_logging/v2/batch` (`origin` is `cc-plugin-telemetry`, `url`); synthetic `count_tokens` path: `url` |
| synthetic variants of a recorded classifier request | other origin, GET, another host, shadow name in the URL, no classifier beta, the beta as a substring, an agent header, shadow or prefixed or malformed model, added `tools` / `thread` / `stream` / `safeguards` / `output_config`, unparseable body: each fails |

Residual, to be stated in `CLAUDE.md`: the marker is a request header, which
a hook above the router can write; `next.origin` proves who raised the
request, not that it is unmodified. What a matching request can carry is
bounded by its shape (a real first-party model, no tools, no thread).

### Curl transport probe (plan Task 7, Claude Code 2.1.325, 2026-11-15)

Run with `scripts/probes/curl-transport.sh` (README rows 28 to 31): the probe
mod (from `make-probe.sh`), `--permission-mode default`, the `custom:mock:m`
route only, the mock's `/slow?s=<n>&tag=<t>` endpoint, which now logs whether
the client closed the connection during the wait. From the `http.fetch` hook,
before the provider call, the probe runs `$.process.spawn({ argv: ["curl",
"--disable", "--config", "-"], input: <config> })` with the URL, two headers,
`data-binary`, `silent`, `show-error`, `globoff`, `proto`, `max-redirs`,
`max-time` and a `write-out` status mark in the config on stdin. Hook order
as in the spike (router copy above the observer).

**Outcome: GO for `$.process.spawn`.** Every condition of the plan held.

| # | Item | Run | Observed |
|---|---|---|---|
| 1 | 60 s hold completes | -p default, `hold60` | `hold-spawn-done` at 60047 ms, `{code: 0, signal: null}`; stdout came as two pieces, the body (`{"slow": 60.0, ...}`) then `\n@@probe-status@@200`; the mock: `dropped: false`, after 60.0 s; the step answered `MOCK-TEXT`. The config on stdin was read (URL, headers and body arrived) |
| 2 | 300 s hold completes | -p default, `hold300` | `hold-spawn-done` at 300049 ms, `{code: 0, signal: null}`; mock `dropped: false` after 300.0 s; result `MOCK-TEXT` |
| 3 | `return()` kills the child | -p default, `return`: `return()` from a `$.clock.sleep(20000)` while a pull is pending | the sleep fired at 20001 ms (not cut at 10 s while the spawn pull was pending); the pending pull settled `done: true` (value null) at 20003 ms and `return()` resolved `{done: true}` at the same ms; the mock logged `dropped: true` after 20.1 s. The handler then went on and the step answered `MOCK-TEXT` |
| 4 | `next.signal` aborting kills the child | pty default, `esc`: Esc during the hold | `step-signal-abort` and `fetch-signal-abort` 1 ms apart, 8.7 s into the hold; the pending pull rejected `HooksError: provider-router: $.process.spawn(curl) aborted` 2 ms later; the mock logged `dropped: true` after 8.7 s; the step ended `stopReason: null`, the probe answered the stub |
| 5 | the hook's budget is not consumed while it waits | rows 1 to 3 | `next.budget` `{ms: 10000, remainingMs: 9998}` at the start, 9997 after 60 s and after 300 s; no `fetch-catch`, the signal never aborted |

Also seen: in the `esc` run the second prompt's hold was still waiting when
the driver ended the session at 110 s; that child's pull settled `done` with
`{code: null, signal: "SIGTERM"}` (no signal abort logged) and the mock logged a
drop. Not observed: a module unload during a hold, and whether a spawn left
running after the `http.fetch` hook returned is killed (the transport never
leaves one: it ends the loop itself on timeout and overflow). Only the
`stdout` pipe carried pieces in these runs; the stderr path is covered by the
unit and integration tests only.

### Answer in place: acceptance runs (plan Task 12, Claude Code 2.1.325, 2026-11-15/16)

The plugin itself (not the probe mod), `custom:mock:m` against
`scripts/probes/mock-provider.py`, each `claude` in its own temp directory
with `--setting-sources project,local`.

| # | Item | Run | Observed |
|---|---|---|---|
| 1 | 60 s reply through curl | -p default, `scenario=slow:60` | result `MOCK-SLOW` after 60219 ms; debug `$.process.spawn (provider-router): curl with 3 args` then `curl ended (0) in 60026ms`; `/providers`: `transport: curl` |
| 2 | the same without curl | as 1, `PATH` = a directory of symlinks to `/opt/homebrew/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin` minus `curl` | `curl failed to start: ENOENT: Executable not found in $PATH: "curl"`, then `$.http.fetch (provider-router): POST .../chat/completions`; after 30191 ms the result `[provider-router] custom:mock error: request failed: the reply took longer than 30 s, the limit without curl (...)`; `/providers`: `transport: fetch (30 s limit)` |
| 3 | interactive, prompt suggestion | pty default, two prompts, observer beneath the router | `source=prompt_suggestion` with `custom:mock:m` → `API hook_denied: provider-router: shadow request refused locally`; the observer saw only telemetry and the session-title request (`claude-haiku-5-5`, sent at prompt submit), nothing naming the shadow model or a prefixed id |
| 4 | default and accept-edits vs `v0.1.2` | -p, `S=agent` and `S=bash`, HEAD and `git archive v0.1.2` | identical in all 8 runs: `Agent` ran (PONG), the outside `touch` refused `needs approval`, 0 classifier requests |

The auto-mode cases are `scripts/automode-check.sh` (4/4 PASS, plan Task 11).

The unit tests run in the kit, which has no process noun, so the real-curl
checks (config parsing of injection payloads, the hostile `.curlrc`, argv as
`ps` shows it, connection drop on Esc and timeout, overflow, a closed port)
are in `scripts/curl-integration.mts`, run by `npm test` under Node against a
listener on 127.0.0.1, skipped when `curl` is absent.

## Test-kit notes

See "Test-kit quirks" in `CLAUDE.md`.
