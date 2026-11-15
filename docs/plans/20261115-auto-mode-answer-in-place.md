# Auto mode for routed models: answer the engine's request in place

## Overview
- **Problem.** In auto mode (`--permission-mode auto`, or `permissions.defaultMode: "auto"`) Claude Code refuses every tool call of a routed model that no rule settles, most visibly `Agent`: `The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one`. A routed main session cannot start a subagent; a routed subagent cannot run a command outside the working directory.
- **Cause (observed live, Claude Code 2.1.325).** The router answers the engine's shadow request with an empty stub and then yields the provider's reply as its own `turn.step` chunks. A tool call that arrives as hook-made chunks has no engine-parsed response behind it, and the engine fails closed.
- **Proposed fix.** Answer the engine's shadow request *with the provider's reply* (as Anthropic SSE) inside the `http.fetch` hook, and let the engine's own chunks flow up through `turn.step`. In the probes the engine then logs `no server verdict for this call (server_no_result); the local classifier decides it` and judges the call with its own local classifier request, which the router must let through.
- **Benefit.** Auto mode works for routed main sessions and routed subagents, with Claude Code's real classifier deciding. No verdict is forged and no check is bypassed.
- **Status of the evidence.** The probes were run once, on throwaway copies, in `-p` mode. They are recorded in `docs/design-notes.md` under "Answer in place". They show the mechanism exists; they do not establish the security boundary, the delivery semantics or interactive behaviour. Task 2 repeats every probe with kept scripts and settles the open points before any production code depends on them. **If Task 2 cannot produce a bounded classifier predicate, the plan stops there.**
- **Non-goals.** Streaming of routed replies; extended thinking; any hook that answers `tool.check` with `allow`.

## Context (from discovery)
- Repo `oleggohman/cc-provider-router`, `main` at `v0.1.2`. Working branch for this plan: `feat/answer-in-place` (new). The branch `auto-mode-limit-fable-limits` holds uncommitted work that Task 1 lands first: the `anthropic:claude-fable` limits row, the documented limitation and the probe records.
- Files involved: `hooks/register.ts` (`routedStep`, hook wiring), `hooks/shadow.ts` (capture, fail-closed rules, circuit breaker), `hooks/chunks.ts`, `hooks/errors.ts` (`errorChunks`), `hooks/thread.ts` (per-loop state, anchors), `hooks/context.ts` (usage for compaction), `hooks/call.ts` (timeout race), `hooks/route.ts` (`parseModel` accepts any suffix), both adapters, all `*.test.ts` beside them, `tests/harness.ts`, `scripts/smoke.sh`, `README.md`, `CLAUDE.md`, `docs/design-notes.md`.
- Observed in the probes (`docs/design-notes.md`, "Auto mode" and "Answer in place"; each is re-verified in Task 2):
  - the shadow request carries `safeguards: [{ type: "dangerous_tool_use", classifier_context: {...} }]`;
  - passing the shadow stream's `engine` chunks around hook-made chunks changes nothing;
  - answering the shadow request with an SSE body holding a `tool_use` block triggers the engine's local-classifier fallback "for the rest of this session";
  - the classifier request is an engine request of the same loop (model `claude-sonnet-5`, no `tools`, no `thread`), sent while the step's stream is still open; today's rule refuses it, and the engine then retries the classifier with the session's own prefixed model id;
  - with it let through (by a deliberately loose probe rule, not the rule this plan ships), `Agent` is judged and runs;
  - a nested `$.http.fetch` of 25 s inside the `http.fetch` hook completes; a plain `$.clock.sleep(25000)` there is cut at 10 s; the nested fetch does not pass through the mod's own `http.fetch` hook.
- Plugin API facts this plan depends on (`.claude-plugin/types/claude-code/index.d.ts`): a nested operation skips its calling hook; `next.origin` names who raised a request, not what it is for, and a hook above may rewrite an engine request without changing the origin; `next.signal` aborts on Esc and also when an enclosing hook settles or a hook exhausts its budget; a `.catch` has a short grace after which the hook is absent; a `turn.step` result may complete with `stopReason: null`; chunks a failed streaming hook already yielded stay.
- Conventions that bind this work (`CLAUDE.md`): fail-closed shadow rules, thread-state invariants, no `$.session.authorize()`, no secrets, TDD, tests run sequentially.

## Development Approach
- **testing approach**: TDD (tests first), as `CLAUDE.md` requires
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task, success and error paths
- **CRITICAL: every task ends green**: `npm test`, `npm run typecheck`, `npm run validate`, in that order, never in parallel
- **CRITICAL: update this plan file when scope changes during implementation**
- Task 2 is a go/no-go spike. Its findings are written to `docs/design-notes.md`, this plan is revised from them, and the revised plan is reviewed again before Task 3 starts
- commit per task (Conventional Commits); merge, tag and publish only with the user's go-ahead

## Testing Strategy
- **unit tests**: `claude plugin test .`, one `*.test.ts` per module. `routedStep` and the fetch-side handler are tested directly with injected `fetch` / `sleep` / `signal` (the kit refuses `$.http.fetch` from a test's own hooks).
- **fail-closed tests**: every change to `hooks/shadow.ts` gets tests asserting zero network calls for anything that could be a shadow, a routed conversation, or a router-prefixed model id.
- **local end-to-end (new, free)**: `scripts/automode-check.sh` with a local mock provider and an **observer plugin** (`tests/observer-plugin/`): a second mod whose only hook is an `http.fetch` hook that appends one line per request it sees (URL, model, origin, body keys) to a file. Placed beneath the router in the hook chain (Task 2 pins how), it records what actually left the router. Assertions are made on that record, not on `shadowLeaks` (which counts one guard's catches) and not on a debug-log string alone.
- **live smoke tests**: `scripts/smoke.sh`, assertions updated in Task 10 to what the new design reports.
- no UI e2e.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix; blockers with ⚠️ prefix
- keep the plan in sync with actual work done

## Solution Overview

### Today
```
turn.step hook (routed model)
  1. shadowStep: next({ ...e, model: SHADOW })  -> http.fetch hook captures the body, answers an empty stub
  2. resolveThread + buildRequest
  3. provider call ($.http.fetch from the turn.step hook, raced against $.clock.sleep;
     it passes through the mod's own http.fetch hook, whose last guard refuses shadow models and URLs)
  4. yield the reply as hook-made chunks; return a hook-made result
```

### After this plan ("answer in place")
```
turn.step hook (routed model)
  1. check key / endpoint (unchanged: no engine work for a step that cannot be answered)
  2. register a job for the loop (route, config, event, signal, a fresh job id)
  3. drive the engine's stream: for await (chunk of next({ ...e, model: SHADOW })) yield chunk
     in a try/finally that always ends the job
  4. after the stream: decide delivery from the job's phase and the engine's result,
     then commit or drop the loop's thread state

http.fetch hook, engine's shadow request of that loop
  a. strict match as today (engine request, SHADOW model, loop key, message count)
  b. resolveThread + normalizeBody + buildRequest; keep the step's system prompt and
     effective tools on the loop at once, withhold the conversation and anchors
  c. outbound guard, then the provider call (nested $.http.fetch), with the timeout mechanism Task 2 selects
  d. answer the engine's request with the reply as Anthropic SSE (or an error reply as SSE)
  e. any failure: a local answer, never next(e) for a shadow

http.fetch hook, every engine request (pending job or not), in this order
  1. names the shadow model, in its body or URL          -> existing rules (answer the one match, refuse the rest)
  2. names a router-prefixed or malformed-prefix model   -> refuse (new)
  3. matches the classifier predicate for a routed loop  -> pass if autoModeClassifier is on, else refuse (new);
     with autoModeClassifier off, also refuse it for a loop of unknown status
  4. another engine request of a loop with a pending job -> refuse (unchanged)
  5. anything else                                       -> next(e) (unchanged)
```

### Key decisions
- **The shadow request still never leaves the machine.** It is answered locally, now with real content. `SHADOW_MODEL` stays a non-existent id.
- **Outbound guard replaces hook re-entry.** Today the provider call passes through the mod's own `http.fetch` hook, whose last guard refuses a request naming the shadow model in its body or URL. A nested fetch skips that hook, and `parseModel` accepts any suffix (`custom:gw:provider-router-shadow`). So the handler validates before sending: the routed model is not `SHADOW_MODEL`, the target URL does not contain it. A conversation that merely quotes the name is still sent (as today).
- **Classifier exception: a bounded predicate or no feature.** Unconditional refusals (shadow model, shadow URL, prefixed model) run first. The exception then needs all of: host-set engine origin; method and path of the Messages API on the first-party host; a classifier-specific marker that Task 2 must find in headers or body (not the system-prompt opening alone); the classifier body shape (no `tools`, no `thread`, none of the conversation-request keys the shadow carries); a loop the router is currently routing. If Task 2 finds no marker stronger than the prompt opening, or finds any ordinary engine request that satisfies the predicate, the plan stops for a decision by the user.
- **A request rewritten by a hook above the router is out of scope, stated.** `next.origin` does not prove a request is unmodified. The predicate therefore never grants more than "this request, as the router sees it, has the classifier's shape and names a real model"; what such a request can carry is bounded by its shape. This residual is documented in `CLAUDE.md`.
- **`.catch` never grants the exception and never evaluates the predicate.** In `shadowFetchFailed`, a request not yet forwarded (`next.called` false) is refused when a job is pending, or it names the shadow model or a prefixed id, or (with `autoModeClassifier: false`) it is an engine request of a loop that is routed or whose status is unknown (see next point), job or no job. Replay stays only for a request already forwarded.
- **Routed loops are tracked beyond the job.** Whether the classifier request is sent before or after the step's stream ends is unverified. A per-loop status (`routed` once a loop's step is routed, `unrouted` on an unprefixed step of that loop) lets the opt-out and the exception apply to a routed loop's classifier request with or without a pending job. Task 2 pins the ordering and whether the classifier request can be attributed to its loop (agent header).
- **A reload must not open the opt-out.** A `/config` change reloads the module and empties that status, possibly while a classifier request or its retry is outstanding, and possibly switching `autoModeClassifier` to `false`. So a loop the module has seen no step of since it loaded has status `unknown`, and with `autoModeClassifier: false` a classifier-shaped request of an `unknown` loop is refused, like a routed loop's. The cost, stated in the README: right after a reload with the opt-out set, a subscription loop's classifier request can be refused once, until that loop's next step. Task 2 probes a reload between reply and classifier send.
- **The subscription pays for classifier requests in auto mode.** This is Claude Code's behaviour behind any gateway, but new for this plugin. It is documented, with an opt-out: plugin option `autoModeClassifier` (boolean, default `true`). When `false`, classifier requests of routed loops are refused and auto mode fails closed for routed steps as it does today.
- **Session-wide side effect, documented.** After the first routed step in auto mode the engine classifies locally "for the rest of this session", including later steps on subscription models.
- **Delivery is a state machine, not "the stream ended".** See Technical Details. A step is recorded only when the provider answered, the router handed the engine that answer, and the engine's result for the step reflects it. Anything ambiguous drops the conversation.
- **System prompt and effective tools are kept before delivery can go wrong**, as `deliver` does today (`recordStep` then `dropBase`): an interrupted step must not lose tool additions and removals, which the session history cannot give back.
- **Jobs have identity.** A late provider answer, a timer, or a cleanup of an abandoned dispatch acts only on the job whose id it holds, never on a newer job of the same loop.
- **Errors stay text replies** prefixed `[provider-router]`, carried in the SSE answer with the stop reason Task 2 selects.
- **Rejected alternatives.** (1) A `tool.check` hook answering `allow`: runs a third-party model's calls unreviewed while the session says auto mode. (2) Passing the shadow's `engine` chunks around hook-made chunks: tested, no effect. (3) Document the limit only: lands in Task 1 as the interim state.

## Technical Details

### Job
```ts
type JobPhase =
  | 'registered'   // turn.step hook registered it, no engine request seen
  | 'captured'     // the shadow request matched; system/tools kept on the loop
  | 'answered'     // provider replied (or failed); outcome staged
  | 'handed'       // the SSE answer was returned to the engine
  | 'abandoned'    // timeout, Esc, hook budget, or dispatch abandonment

type Job = {
  id: number                      // unique per job; every async continuation checks it
  messageCount: number
  route: Route; config: Config; event: StepEvent; signal: AbortSignal
  phase: JobPhase
  outcome?: { sent: any; anchors: Anchors; assistant: any[]; usage?: Usage; kind: 'reply' | 'error'; messageId: string }
}
```
- Module-level `Map<loopKey, Job>`, one job per loop. A job is removed by whichever comes first, each checking the job id: the `turn.step` hook's `finally` (success, error, iterator closed with `.return()`), or an `abort` listener on the dispatch's `next.signal` (Esc, the enclosing hook settling, budget exhaustion, the dispatch abandoned). A generator left suspended is never cleaned up by garbage collection, so the listener is the only cleanup for that case. Listeners and timers are removed when the job settles.
- A reload empties it; a stray shadow request is then refused by the no-entry rule (unchanged).

### Delivery decision (in the `turn.step` hook, after the stream)
| Job phase | Engine result | Signal | Action |
|---|---|---|---|
| `handed`, outcome `reply` | `stopReason`, `answer` text, and every tool use's name and arguments equal the staged reply's | not aborted | record the step (conversation, anchors) |
| `handed`, outcome `error` | text reply delivered | not aborted | record the error text as the assistant turn (today's invariant) |
| `handed` | `stopReason` null, or any of those differ | any | drop the conversation (system and tools stay) |
| `answered`, `captured` | any | any | drop the conversation |
| `registered` | any | not aborted | drop the conversation; circuit-breaker rule as today |
| any | any | aborted before `handed` | record nothing (Esc before delivery) |
| any | iterator closed or abandoned mid-stream | any | drop the conversation |

Task 2 checks that the engine's result (`answer`, `toolUses`) corresponds to the SSE answer field by field, including for two replies with the same stop reason and counts but different content. There is no weaker fallback: if a reliable correspondence cannot be established for a step, its conversation is dropped and the next continue is rebuilt from the session history, which keeps the invariant at the cost of a rebuild per step. If that cost applies to every step, Task 2 reports it as a GO question for the user.

### Reply → Anthropic SSE (`hooks/sse.ts`, new)
- `toSse(reply: Reply, id: string): string`: `message_start` (id, `model`, usage per Task 2), per block `content_block_start` / one delta (`text_delta`, or `input_json_delta` with the whole arguments JSON) / `content_block_stop`, `message_delta` (`stop_reason`, `usage.output_tokens`), `message_stop`.
- Empty text blocks dropped; indexes count the blocks sent, from 0 (same rule as `toChunks`).
- `errorSse(error: ErrorReply, id)`: one text block and the stop reason Task 2 selects.
- Message ids are minted by the router, unique per reply. Task 2 checks whether the next continue's `previous_message_id` equals that id; if so anchors are bound to known ids.

### Classifier predicate (final form pinned by Task 2; shown as the minimum)
```
evaluated only after the unconditional refusals
next.origin.plugin === 'engine'
AND method POST AND URL is the first-party Messages endpoint (host and path pinned by Task 2)
AND body parses AND typeof body.model === 'string' AND classifyModel(body.model).kind === 'unprefixed'
AND body.tools, body.thread, body.safeguards, body.context_management are absent
AND <classifier marker from Task 2: a header or metadata field naming the auto-mode query source>
AND the status of loopKey(headers) is `routed`
```
An unparseable or unreadable body never matches.

### Timeout, Esc and abandonment inside the `http.fetch` hook
- Task 2 selects and **proves end to end** one of: (a) `raceCall` in the fetch-side handler, if a `$.clock.sleep` racing an in-flight nested fetch is not cut at 10 s; (b) the `turn.step` hook owns the timer and marks the job `abandoned`, and the handler awaits `Promise.race([providerCall, job.abandonedPromise])`. If neither works for 600 s, the plan stops.
- Cases the handler and the hook must each handle, by job id: fetch-hook budget exhaustion; the `turn.step` dispatch abandoned while the fetch-side handler lingers; timeout followed by a new step on the same loop; a late provider success or rejection after abandonment. In every case the late result is discarded and the newer job is untouched.
- A provider call already sent still cannot be cancelled; it is billed (unchanged).

### Usage and compaction
- The handler stores the reply's usage on the job; the `turn.step` hook calls `recordUsage` after a recorded step.
- Whether `context.ts` stays as is depends on Task 2: once the engine parses a real response it may account usage itself and trigger its own compaction for the shadow model's assumed window. Task 2 probes that; Task 9 implements what follows.

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): code, tests, scripts and docs in this repo.
- **Post-Completion** (no checkboxes): interactive checks only a person can do, release.

## Implementation Steps

### Task 1: Land the interim state (Fable limits, documented limitation, probe records)

**Files:**
- Modify: `hooks/limits.ts`, `hooks/limits.test.ts`, `README.md`, `docs/design-notes.md` (already edited on `auto-mode-limit-fable-limits`, uncommitted)
- Create: `docs/plans/20261115-auto-mode-answer-in-place.md` (this file)

- [x] review the uncommitted diff on `auto-mode-limit-fable-limits`
- [x] confirm the tests for the limits row are present (`maxOutputTokens('anthropic:claude-fable-5-2')`, `windowFor('anthropic:claude-fable-5-2')`)
- [x] run `npm test`, `npm run typecheck`, `npm run validate` - must pass
- [x] commit as three commits: `fix(limits): add anthropic:claude-fable limits`; `docs: auto mode cannot review a routed model's tool calls`; `docs: answer-in-place probes and plan`
- [x] create `feat/answer-in-place` from that state

### Task 2: Go/no-go spike with kept probe scripts

**Files:**
- Create: `scripts/probes/mock-provider.py`, `scripts/probes/mock-gateway.py`, `scripts/probes/drive-pty.py`, `scripts/probes/README.md` (how to run each probe and what result is expected; the probe mods themselves are generated into a temp dir, never committed as plugin code). These stay in the repo: they are how the engine facts are re-checked after a Claude Code release
- Create: `tests/observer-plugin/.claude-plugin/plugin.json`, `tests/observer-plugin/hooks/hooks.json`, `tests/observer-plugin/hooks/register.ts`
- Modify: `docs/design-notes.md` (findings), this plan (revise Tasks 3–11)

Each item is answered live and recorded as a row in `docs/design-notes.md` with the engine version, the sanitized request shape, the hook order and the outcome. A "no" on a **GO** item stops the plan for a decision by the user.

- [ ] reproduce every row of "Answer in place" with the kept scripts, in `-p` and in a pty-driven interactive session
- [ ] observer plugin: establish which load order puts its `http.fetch` hook beneath the router's, and confirm it sees the router's nested provider fetch and every request the router passes with `next(e)`
- [ ] **GO: classifier predicate.** Capture the classifier request (URL, method, all headers, body keys, `metadata`) for a main loop and a subagent loop, in `-p` and interactively, for first and later tool calls and for the engine's retry. Produce the explicit predicate and a list of counterexamples tried against it: a thread create, a thread continue, a compaction request, a title or summary side request, a fallback-model retry of the conversation, a request to a non-Messages path. No-go if the only distinguishing marker is the system-prompt opening, or if any counterexample matches
- [ ] **GO: classifier timing and attribution.** Record the order of: the step's stream ending, the job's removal, `tool.check`, the classifier send, its retries; for several tool calls in one reply, for a later turn, and for a resumed subagent. Confirm the classifier request carries the loop's agent header. Decide whether the per-loop status is sufficient to attribute it
- [ ] **GO: long hold.** A nested fetch of 300 s and of 600 s inside the `http.fetch` hook completes and the engine accepts the answer; record any engine request timeout
- [ ] **GO: timeout mechanism.** Prove (a) or (b) of "Timeout, Esc and abandonment" end to end: a 15 s limit against a 25 s provider yields the timeout reply, and the next step on the loop works
- [ ] reload: a `/config` change (also one that sets `autoModeClassifier` to `false`) between the reply being handed over and the classifier send or retry: what the freshly loaded module sees, and that the `unknown`-status rule refuses it under the opt-out
- [ ] abandonment: what the host does when the consumer stops reading the `turn.step` stream (is `.return()` called, does `next.signal` abort), so the listener-based cleanup is proven
- [ ] **GO: Esc.** Interactive Esc during the held request: what the `http.fetch` hook and the `turn.step` hook each observe (signal, iterator closed, hook abandoned), what the engine records, and that the next step works
- [ ] nested dispatch: confirm the provider fetch made from the `http.fetch` hook does not re-enter the router's hook, and that the observer still sees it
- [ ] delivery: what the hook reads as the `turn.step` result (`answer`, `toolUses`, `stopReason`, `usage`) for a good reply; for two replies with the same stop reason and counts but different text and arguments; for a truncated SSE body; for malformed SSE; for an SSE answer the engine rejects; whether a `stopReason: null` result can follow a handed answer; whether `answer` and `toolUses` match the SSE content exactly (whitespace, key order of arguments)
- [ ] error replies: which `stop_reason` in the SSE answer shows the `[provider-router]` text to the person and to a parent agent with no engine retry and no API-refusal report (`end_turn`, `refusal`, `model_context_window_exceeded`); also an HTTP 4xx with `x-should-retry: false`, and why it is or is not usable
- [ ] model and usage: with real usage and the provider's model name in the SSE, what `/cost`, `modelUsage`, transcript entries and `$.session.usage()` show; the same with zero usage and `SHADOW_MODEL`; choose one
- [ ] compaction: with real usage reported, does the engine compact a long routed session by itself, at what size, and how that interacts with the mod's `$.session.compact()`; recovery after an engine compaction fork and after `/model` to a subscription model and back
- [ ] thread anchors: after an SSE answer with a minted id, the `previous_message_id` of the next continue
- [ ] classifier denial: a tool call the classifier blocks is not executed and the model gets the engine's own denial text
- [ ] non-auto modes: default and accept-edits behave as in `v0.1.2` (no classifier request; prompts and rules work)
- [ ] write the findings into `docs/design-notes.md`; revise Technical Details and Tasks 3–11; send the revised plan for review; stop if any GO item failed

### Task 3: Reply → Anthropic SSE module

**Files:**
- Create: `hooks/sse.ts`, `hooks/sse.test.ts`

- [ ] write tests for `toSse`: text only; tool call only; text and two tool calls; empty text block dropped; indexes from 0; `stop_reason` and usage carried; arguments JSON round-trips (nested objects, unicode, empty object)
- [ ] write tests for `errorSse`: the `[provider-router]` text, the stop reason chosen in Task 2, zero usage
- [ ] write a test that every emitted event parses as `event:` / `data:` JSON and that ids from two calls differ
- [ ] implement `toSse`, `errorSse` and the id minting in `hooks/sse.ts`
- [ ] run tests, typecheck, validate - must pass before Task 4

### Task 4: Jobs in `shadow.ts`, behind today's `shadowStep`

**Files:**
- Modify: `hooks/shadow.ts`, `hooks/shadow.test.ts`

`shadowStep` stays, as a wrapper over the new job functions that registers a job with no handler (so the stub is answered and the body returned, exactly as today). `register.ts` is untouched and the suite stays green.

- [ ] write tests for `beginShadow(key, job)` / `endShadow(key, id)`: one job per loop; a second begin for a pending loop is refused; `endShadow` with a stale id does nothing
- [ ] write tests: a matching shadow request with a job that has a handler calls it once and returns its answer; the handler throwing or rejecting gives a local error answer, never `next`; zero network calls for the shadow request in each case
- [ ] write tests that today's fail-closed cases hold unchanged through the wrapper: no job → refused; unparseable body while pending → refused; non-engine request naming the shadow model → refused and counted; `shadowFetchFailed` refuses while anything is pending
- [ ] write tests for the circuit breaker with jobs: a job that ends in phase `registered`, without Esc, with no engine request seen sets `blind`; an engine request clears it
- [ ] implement `Job`, `JobPhase`, `beginShadow`, `endShadow`, the handler call in `shadowFetch`, and `shadowStep` as the wrapper
- [ ] run tests, typecheck, validate - must pass before Task 5

### Task 5: Unconditional refusals and the classifier exception

**Files:**
- Modify: `hooks/shadow.ts`, `hooks/shadow.test.ts`, `hooks/config.ts`, `hooks/config.test.ts`, `.claude-plugin/plugin.json`, `hooks/register.ts`, `hooks/register.test.ts`

- [ ] write tests for the new unconditional rule, each refused with zero network calls, with and without a pending job: an engine request naming a router-prefixed model (`custom:x:y`, `anthropic:...`, `zai:...`, `openai:...`); a malformed prefix (`openai:`, `custom:gw`); a prefixed id in the URL; an unreadable body while any job is pending
- [ ] write tests for the predicate from Task 2: the classifier request of a `routed` loop reaches `next` exactly once; with `autoModeClassifier: false` it is refused; for an `unrouted` loop it is treated as an ordinary request (rule 4 or 5)
- [ ] write negative tests, each refused with zero network calls while a job is pending: the classifier marker with a shadow URL; with `tools`; with `thread` (create and continue); with a non-engine origin; for another loop's job; an ordinary conversation request rewritten to a real model id; a retry of the conversation with a real model id and no marker
- [ ] write tests for `shadowFetchFailed`: with `next.called` false and a job pending, a request that would match the predicate is refused; with `next.called` true it is replayed; a predicate function that throws leads to a refusal
- [ ] write tests for loop status: `routed` after a routed step, `unrouted` after an unprefixed step of the same loop, `unknown` for a loop with no step since load
- [ ] write tests for the reload rule: with `autoModeClassifier: false`, a classifier-shaped request of an `unknown` loop is refused; with it `true`, it passes as ordinary traffic
- [ ] write tests for `shadowFetchFailed` with no pending job and `autoModeClassifier: false`: an unforwarded engine request of a `routed` loop and of an `unknown` loop is refused with zero forwards, also when the predicate function throws and when the hook overran its budget; the predicate is not called from `.catch`
- [ ] add the `autoModeClassifier` option (`userConfig` boolean, default `true`) to `plugin.json` and `loadConfig`
- [ ] implement the rule order of "Solution Overview" in `shadowFetch` and the stricter `.catch`
- [ ] run tests, typecheck, validate - must pass before Task 6

### Task 6: The fetch-side handler (`answerShadow`) with the outbound guard

**Files:**
- Create: `hooks/answer.ts`, `hooks/answer.test.ts`
- Modify: `hooks/call.ts`, `hooks/call.test.ts`

Built and tested on its own; nothing calls it from the hooks yet.

- [ ] write tests: create and continue bodies resolve, normalize and build as today; the provider's reply comes back as SSE and the outcome is staged on the job; the job's phase moves `captured` → `answered`
- [ ] write tests for failures, each an error SSE and a staged `error` outcome: provider HTTP error; thrown fetch; unreadable reply; a missing or unrebuildable conversation (the clear error)
- [ ] write tests for the outbound guard, each answered locally with zero network calls: a routed model equal to `SHADOW_MODEL` (`custom:gw:provider-router-shadow`); a custom endpoint URL containing the shadow model's name; and one positive test: a conversation that merely quotes the name is sent
- [ ] write tests that the step's system prompt and effective tools (after `tool_addition` / `tool_removal`) are kept on the loop when the handler captures the request, while the conversation and anchors are not
- [ ] write tests for the timeout mechanism chosen in Task 2 and for job identity: a late provider success and a late rejection after abandonment change nothing; a newer job on the same loop is untouched
- [ ] implement `answerShadow(job, body, io)` and the changes to `call.ts`
- [ ] run tests, typecheck, validate - must pass before Task 7

### Task 7: `routedStep` drives the engine's stream; delivery decision

**Files:**
- Modify: `hooks/register.ts`, `hooks/register.test.ts`, `hooks/thread.test.ts`, `tests/harness.ts`

- [ ] write tests for the new `routedStep`: it registers a job with the handler, yields the engine's chunks unchanged, returns the engine's result, and ends the job in `finally`; an early failure (missing key, unknown endpoint) still answers without calling `next`
- [ ] write one test per row of the "Delivery decision" table
- [ ] port the thread-invariant tests in `hooks/thread.test.ts` to the new flow: error step recorded with its text; Esc before delivery records nothing; delivery cut short drops the conversation and keeps system and tools; failure before capture drops it; an interrupted first create; an interrupted step with tool additions and removals; an iterator left suspended, not only closed; anchors kept per step
- [ ] write tests for abandonment: the fetch-side handler lingering after the step's dispatch ended; a timeout followed at once by a new step on the loop; the dispatch's signal aborting while the generator stays suspended (no `.return()`): the job is removed by the listener, the next step on the loop can start, and the old continuation cannot touch the new job; listeners and timers are gone after a job settles
- [ ] implement the new `routedStep` and wire the `http.fetch` hook to give the handler its own `$.http.fetch` / `$.clock.sleep`
- [ ] keep the outer guarantees: the `turn.step` hook's try/catch and `.catch` still turn any failure into a local reply; a prefixed model never reaches the engine with its own id
- [ ] run tests, typecheck, validate - must pass before Task 8

### Task 8: Remove what the new flow no longer uses

**Files:**
- Modify: `hooks/shadow.ts`, `hooks/shadow.test.ts`, `hooks/chunks.ts`, `hooks/chunks.test.ts`, `hooks/errors.ts`, `hooks/errors.test.ts`

- [ ] remove the `shadowStep` wrapper and the empty-stub path if nothing calls them; keep a defensive local answer for a job with no outcome
- [ ] remove `toChunks` / `toResult` if nothing calls them; keep `errorChunks` for failures before `next`
- [ ] update or remove the tests of what was removed; add a test that the public surface each module still exports is used
- [ ] run tests, typecheck, validate - must pass before Task 9

### Task 9: Usage, compaction and `/providers`

**Files:**
- Modify: `hooks/register.ts`, `hooks/context.ts`, `hooks/context.test.ts`, `hooks/providers-command.ts`, `hooks/providers-command.test.ts`

- [ ] write tests: a recorded step's usage reaches `recordUsage`; an error step keeps the previous record; a dropped step records none
- [ ] write tests for compaction as Task 2 found it must work (the mod's own scheduling kept, changed or removed)
- [ ] write a test that `/providers` shows `autoModeClassifier`, a count of classifier requests passed and refused, and the existing counters
- [ ] implement the usage hand-off, the compaction change and the `/providers` lines
- [ ] run tests, typecheck, validate - must pass before Task 10

### Task 10: Local auto-mode check and smoke test update

**Files:**
- Create: `scripts/automode-check.sh`
- Modify: `scripts/probes/mock-provider.py`, `scripts/probes/README.md`, `scripts/smoke.sh`, `package.json`

- [ ] `scripts/probes/mock-provider.py` (shared by the probes and the check): main loop → an `Agent` call; a subagent → a harmless Bash call writing a marker file outside the working directory (in a temp dir the script owns), then text after its result; logs what it received; no keys
- [ ] `scripts/automode-check.sh`, routed main session in auto mode: `Agent` ran; the observer's record holds only the provider's host and classifier requests that satisfy the predicate; no request names the shadow model or a prefixed id
- [ ] same script, subscription main session with a routed subagent in auto mode: the subagent's Bash call was judged and its marker file exists
- [ ] same script, a call the classifier blocks: the tool did not run (its marker file is absent) and the model received a denial
- [ ] same script, `autoModeClassifier: false`: the call is refused and the observer's record holds no classifier request
- [ ] update `scripts/smoke.sh` assertions to Task 2's findings on usage and model names; add `npm run automode`
- [ ] run `scripts/automode-check.sh` - must pass before Task 11

### Task 11: Verify acceptance criteria

- [ ] auto mode, routed main session: `Agent` runs (automode check)
- [ ] auto mode, subscription main session, routed subagent: its unsettled Bash call is judged, not refused for lack of a verdict
- [ ] a blocked call does not execute
- [ ] default and accept-edits modes behave as in `v0.1.2`
- [ ] by the observer's record: no shadow request, no routed conversation and no prefixed model id reached the first-party host in any run
- [ ] no secret in any output (`hooks/secrets.test.ts` passes)
- [ ] run `npm test`, `npm run typecheck`, `npm run validate` - all pass
- [ ] run `code-reviewer` on the branch, fix findings with `review-fixer`, re-review (max 3 rounds)

### Task 12: Documentation

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `docs/design-notes.md`

- [ ] README "How it works": the new flow diagram
- [ ] README Limits: replace the auto-mode limitation with what now holds: auto mode works; the classifier runs on the subscription and sees the conversation's actions; the session classifies locally from the first routed step on; the `autoModeClassifier` opt-out, and that right after a reload with it set a subscription loop's classifier request can be refused once; routed replies are still not streamed
- [ ] README: correct "Your subscription is never routed and never pays for a routed call" to state the classifier exception exactly
- [ ] README Troubleshooting: the no-verdict row now points at `autoModeClassifier: false` or an old plugin version
- [ ] `CLAUDE.md`: the fail-closed list gains the outbound guard, the prefixed-id rule, the classifier predicate with its stated residual, and the strict `.catch`; the thread-invariant wording follows the delivery table
- [ ] `docs/design-notes.md`: "The shadow step" rewritten for answer in place; the spike tables kept, each pointing at the probe in `scripts/probes/` that reproduces it
- [ ] `CLAUDE.md` Commands: `scripts/automode-check.sh` and the probes, with the note to re-run them after a Claude Code release
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification** (interactive session, a person at the keyboard):
- auto mode with a routed Fable main session dispatching `cto`: the subagent starts and can run commands
- Esc during a long routed step ends it and the next step continues correctly
- `/rewind` and automatic compaction in a routed auto-mode session
- the notice Claude Code shows when auto mode falls back to billed classifier requests

**Release** (only with the user's go-ahead):
- bump to `0.2.0`, merge to `main`, tag, push, run Trivy on `main`
- update the plugin entry in the `oleggohman/cc-things` marketplace
