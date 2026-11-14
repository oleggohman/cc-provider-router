# Provider router: verification spike (Task 1)

**Verdict: GO.** Every hard requirement has a working path. Claude Code 2.1.323, run on 2026-11-14.

The spike plugin in this folder is a throwaway test harness. Each `spike-*` model id runs one check and
writes JSON lines to `/private/tmp/claude/provider-spike/log.jsonl`. Experiments ran from a scratch dir:

```
claude -p "<prompt>" --plugin-dir <repo>/spike --model <spike-model> [--allowedTools ...]
claude plugin validate ./spike    # passes (directory-profile notes only: no README/LICENSE/icon at repo root)
claude plugin test ./spike        # 1 pass, 0 fail (test file since renamed spike.test-disabled.ts so the root mod's test run skips it)
```

## Key discovery: the "shadow step" (option (c), made to work per step)

A `turn.step` hook for a routed model calls `next({ ...e, model: 'claude-haiku-4-5' })` after setting a
capture flag. The engine then builds **the exact request it would send for this step** (system prompt,
tools with `input_schema`, messages with system reminders, `max_tokens`, `thinking`) and passes it
through `http.fetch`. The mod's own `http.fetch` hook reads the body and answers it locally with a stub
SSE response, so the request never reaches the network and costs nothing. The hook drains and discards
the stub stream, then calls the real provider with the captured request.

This works for routed subagents too: the subagent's step is the one calling `next`, so the engine builds
the subagent's request (its own tools and system prompt). The plan's note that (c) "never fires for a
routed subagent" is true only for passive capture; the per-step shadow request removes that limit.

Engine requests are told apart from the mod's own `$.http.fetch` calls (which also pass through the
mod's `http.fetch` hook) by `init.compress` (`"gzip"` on engine requests, absent on the mod's own) and
the `x-claude-code-session-id` header. A subagent's engine request carries `x-claude-code-agent-id`.

## Results per item

### 1. GO/NO-GO: tools - **works** (via (c), shadow step)
- (a) `$.tool.list()`: **doesn't**. 663 entries, 0 with `inputSchema` (types: "Never on a tool the session lists").
- (b) `tool.describe`: **doesn't**. It carries the description and deferral, no schema.
- (c) engine request body, per step: **works**, for main and subagent.
  - main, `--model spike-echo`: `toolNames` 17 (Agent, Bash, Edit, Read, ..., mcp__...), `toolsWithSchema: 17`,
    Bash schema keys `command, timeout, description, run_in_background, dangerouslyDisableSandbox, allowed_domains`.
  - subagent `provider-spike:echo-agent` (`model: spike-echo`, `tools: Read, Bash`), main on `haiku`:
    `toolNames: ["Read","Bash","SubagentHandback"]`, `toolsWithSchema: 3`.
  - request keys: `model, messages, system, tools, metadata, max_tokens, thinking, context_management,
    safeguards, thread, diagnostics, stream`.
- (d) hand-written table: not needed. (`.claude-plugin/types/claude-code-tools/index.d.ts` holds typed
  built-in schemas if ever needed.)
- Caveat seen: the subagent did not call `SubagentHandback`, so the engine ran extra steps (index 1-3);
  the requests it built for those had no `tools` and a 157-char system prompt. That is what the engine
  itself would have sent, so forwarding it is correct, but the router must match a capture to its own
  step (agent id header + one pending capture per loop), never take a request from another loop.

### 2. GO/NO-GO: system prompt - **works** (same capture)
- main: `system` 7,959 chars. subagent: 1,939 chars and contains the agent file's body
  (`systemHasAgentMarker: true`).
- system reminders: present in the captured `messages` (`reminderInRequest: true`) and also in
  `$.session.messages({ as: 'api' })` in this build (`reminderInApiMessages: true`). Message counts match
  (1/1, 9/9). Decision: take `messages` from the captured request too, so one source gives all of it.

### 3. Subagent with `model: spike-echo` reaches the hook - **works**
`{"model":"spike-echo","agentId":"adb31dfe37ddccc6d","index":0,...}`; plugin agent type is
`provider-spike:echo-agent`.

### 4. Self-made `tool` + `input` + `stop{tool_use}` - **works**
`claude -p "run it" --model spike-tool --allowedTools Bash` printed `SPIKE-TOOL-RESULT "SPIKE-TOOL-RAN"`.
Next step's last API message: `{"tool_use_id":"toolu_spike_1","type":"tool_result","content":"SPIKE-TOOL-RAN","is_error":false}`.
Arguments split across two `input` chunks were joined correctly.

### 5. `$.http.fetch` and timeout race - **works**; Esc **partial (manual)**
- POST with JSON body + headers to `https://api.anthropic.com/v1/messages` with a bad key:
  `{"status":401,"ok":false,"contentType":"application/json","body":"{\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"},\"request_id\":\"req_...\"}"}`.
- `Promise.race([$.clock.sleep(5000), $.clock.sleep(200, { signal })])` -> `race: "timeout"` after 201 ms.
- `next.signal` exists on the `turn.step` `next` (`nextHasSignal: true`).
- Esc during a step: not automatable in `-p` mode. Left for the Task 8 manual check.

### 6. `claude plugin test` with `on('http.fetch')` beneath the mod - **works**
`hooks/spike.test.ts`: the test's `http.fetch` hook received the mod's POST (url, method, headers, body)
and its 401 answer reached the mod. Notes for Task 2+ tests:
- an op hook answers `{ value: ... }` (`http.fetch`, `tool.list`, `fs.write`, `clock.sleep`, `session.messages`);
- stub `clock.sleep` (`() => ({ value: undefined })`), otherwise sleeps wait for the mocked clock;
- read the `$.turn.step(...)` stream with `.next()` until `done`; `stream.result` was `undefined` in the kit.

### 7. Config, `/model`, usage, compaction, stop reason
| Check | Result | Evidence / decision |
|---|---|---|
| `userConfig` `sensitive: true` string | works | validates; `options.spikeKey === ""` when unset |
| `userConfig` string list | **partial** | `"type": "string[]"` is rejected by validate (`expected one of "string"\|"number"\|"boolean"\|"directory"\|"file"`). `"type": "string", "multiple": true` validates and arrives as `[]`. Use that. |
| `$.config` live values | n/a | `$.config.list()` returned no plugin rows in `-p`. reference.md: a `/config` change **reloads the module with the new `options`**. Decision: read `options` in `register`; no live `$.config` reads. |
| prefixed model id | works (`--model`) | `--model 'spike:my-gw:org/model:v1'` reached `turn.step` as `e.model` unchanged; engine prints "doesn't recognize the model ... assumes 1m". Interactive `/model` not automatable; same resolver assumed, check in Task 8. |
| `stop.usage` feeds the context meter | **doesn't** (headless) | usage `input_tokens: 150000` in the stop chunk and in the result; `$.session.usage().context` stayed `{"window":1000000}` (no tokens). Fallback: the mod tracks its own last input tokens per loop (already planned). |
| `$.session.compact` from `turn.complete` | **unverified** | in `-p`: `HooksError: $.session.compact is not available in this mode: no session is bound in this process`. Interactive not automatable here. Must catch the error; check interactively in Task 8. |
| routed subagent's own auto-compact threshold | works (by types) | agent definition field `autoCompactWindow` (100000-1000000, "only lowers the window"). Session-wide env knobs also exist: `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. Not live-tested. |
| error stop reason | doesn't exist | `TurnStopReason` = `end_turn \| max_tokens \| stop_sequence \| tool_use \| pause_turn \| compaction \| refusal \| model_context_window_exceeded \| null`. Fallback `refusal`: verified the step ends cleanly, text shown, exit 0. `model_context_window_exceeded` is available for the context-length case. |

## Fallbacks chosen
- Tools + system prompt + messages: (c) per-step shadow request, not (a)/(b)/(d).
- String list config: `"type": "string", "multiple": true`.
- Config refresh: `options` at `register` (module reloads on change).
- Context meter: mod-side usage tracking; `$.session.usage()` is not fed by routed steps.
- Error stop: `refusal`; context overflow: `model_context_window_exceeded`.

## Task 4 live check: the shadow model id (2026-11-14)

`spike-echo` now runs two shadow captures in one step, `claude-haiku-4-5` then `provider-router-shadow`
(real first: MCP connectors still connecting on the first step otherwise skew the tool list), and
compares them. The spike's `http.fetch` hook refuses (local 400) any `provider-router-shadow` request it
did not capture. Runs: main `--model spike-echo` (3 runs), subagent `echo-agent` with main on `haiku` (1 run).

| Item | Main loop | Subagent |
|---|---|---|
| tool names (order) | identical (17) | identical (`Read, Bash, SubagentHandback`) |
| tool `input_schema` | identical | identical |
| tool `description` | differs for some built-ins (Agent, Bash, Edit, Read, Skill, ToolSearch, Workflow, Write) | differs for Read, Bash on step 0 |
| `system` | identical (7,992 chars) | identical (1,939 chars) |
| `messages` | differ in wording (reminder text variant) | - |
| `max_tokens` | 32000 both | 32000 both |
| `thinking` | shadow `{type:"adaptive"}`, haiku `{type:"enabled",budget_tokens:31999}` | same |
| extra keys | shadow adds `output_config: {effort:"high"}` | same |

What the engine does with the unknown id: it does **not** reject it. It logs
`[claude-code:unrecognized_model] {"model":"provider-router-shadow"}`, then builds and sends the request
like for its newest models (adaptive thinking, `output_config.effort`, the newer tool-description and
reminder wording). `max_tokens` is not shrunk (32000).

Verdict: keep `SHADOW_MODEL = provider-router-shadow`. Names, schemas and system prompt match; only
prose (descriptions, reminders) follows the newest-model variant, which suits a non-Claude provider at
least as well. `thinking` and `output_config` are first-party fields and are dropped by `buildRequest`.

Safety: across the runs every `provider-router-shadow` request was captured locally (8/8 in the
subagent run; 0 refused, 0 reached the network).

`e.messageCount` is NOT the API message count: live, the main step had `messageCount: 22` and the
captured request 2 messages (stored rows merge into fewer API messages). The strict match therefore
uses `1 <= messages.length <= messageCount`, not equality.

Test kit note: a test's own hooks cannot call `$.http.fetch` (refused, "its hooks module does not call
it"), and the test body's `$` has no `http` noun. Shadow tests drive `shadowFetch` / `shadowStep` /
`routedStep` directly with a counting `next` as the network; one plugin-level test checks the routed
step reaches the engine with the shadow model and yields none of its chunks.

## Task 5 live check: timeout race vs the hook budget (2026-11-14)

The reference says a `$.clock.sleep` counts against a hook's 10 s budget, while a `$` call in flight
does not. Question: does a long timeout sleep, raced against an in-flight `$.http.fetch`, use up the
budget? Throwaway `--plugin-dir` mod (scratch dir, not kept), `turn.step` for model `budget-test`,
no `next()`, local HTTP server that answers after 25 s:

| Race | Result |
|---|---|
| `$.http.fetch` (25 s) vs `$.clock.sleep(60000, { signal })` | fetch won after 25,032 ms; `next.signal` not aborted; step ended normally |
| `$.http.fetch` (25 s) vs `$.clock.sleep(15000, { signal })` | timer won after 15,004 ms; `next.signal` not aborted |

Verdict: the race design in `hooks/call.ts` holds; a sleep running beside an in-flight fetch does not
end the hook at 10 s. Default provider timeout: 600 s (non-streamed replies can be long).

Test kit note: the kit loads the mod in its own module instance, so a test hook cannot reach the mod's
shadow map through an import; plugin-level routed tests stop at "shadow request failed" and the
success path is tested through `routedStep` with injected `fetch` / `sleep` / `signal`.
