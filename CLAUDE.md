# CLAUDE.md

Guidance for coding agents working in this repository.

## What this is

A Claude Code plugin with a TypeScript hooks module (a "mod"). `hooks/hooks.json`
loads `hooks/register.ts`, which registers hooks on `turn.step`, `http.fetch`,
`turn.complete`, `session.start` and `command.run` (`/providers`). User docs
are in `README.md`; the engine behaviour the design depends on is in
`docs/design-notes.md`; the implementation plan is in `docs/plans/`.

## Layout

- `hooks/register.ts`: wiring and `routedStep` (drives the engine's stream,
  delivery decision). `hooks/answer.ts`: the fetch-side handler that captures
  the engine's request and answers it with the provider's reply.
  `hooks/sse.ts`: reply → Anthropic SSE, the empty stub, `sameDelivery`.
- `hooks/route.ts`: model-id prefix parsing. `hooks/config.ts`: keys, custom
  endpoints, context windows, `autoModeClassifier` from `options` + env.
- `hooks/shadow.ts`: the per-loop job registry, the refusal rules and the
  classifier exception. `hooks/thread.ts`:
  per-loop conversation state for message-thread continues, body normalization.
- `hooks/request.ts`, `hooks/translate.ts`, `hooks/providers/{anthropic,openai}.ts`:
  request building and the two adapters. `hooks/limits.ts`: per-model
  context windows and max output tokens (one prefix-matched table).
  `hooks/call.ts`: timeout/cancel of a provider call and the shared fetch and
  adapter-result types. `hooks/transport.ts`: provider calls through a `curl`
  child (`$.process.spawn`, argv `curl --disable --config -`, key and body
  on stdin only; `$.http.fetch` as the fallback, 30 s host limit).
  `hooks/chunks.ts`, `hooks/errors.ts`,
  `hooks/context.ts`, `hooks/providers-command.ts`.
- `tests/harness.ts`, `tests/fixtures/`: shared test stand-ins and transcripts.
  `tests/observer-plugin/`: a fetch observer loaded beneath the router.
- `scripts/smoke.sh`: live smoke tests. `scripts/automode-check.sh`: local
  auto-mode check (mock provider). `scripts/probes/`: engine-fact probes.
  `examples/agents/`: routed subagents.

## Conventions

- Hooks have the shape `($, e, next)`; `turn.step` is
  `async function* ($, e, next)` and passes unprefixed models through with
  `return yield* next(e)` untouched.
- Config is read only from `register`'s `options` and env (`$.env.get` with
  literal names). A `/config` change reloads the module; no live `$.config`
  reads. Never call `$.session.authorize()` or set `init.auth`: routed calls
  bill the configured key, never the subscription.
- **The shadow capture fails closed.** Do not weaken the rules in
  `hooks/shadow.ts` (rule order in its header): strict match; one pending job
  per loop held until the stream ends; refuse every unmatched shadow-model
  request and every engine request naming a router-prefixed or malformed
  model id (the engine sends side requests under the session's prefixed id —
  prompt suggestion, its own compaction, the classifier's retry — that
  bypass `turn.step`); `shadowLeaks` must stay 0; the circuit breaker that
  refuses every later shadow step before `next` once one ended uncaptured,
  without Esc, while the hook saw no engine request, until the hook sees an
  engine request; for the breaker only the host-set
  `next.origin.plugin === 'engine'` proves an engine request, never the
  caller-controlled `compress` or session header, which stay the wide
  rule for refusing. The one pass-through is the auto-mode classifier
  predicate (`isClassifierRequest`, after the unconditional refusals):
  engine origin, exactly the first-party Messages URL, the
  `auto-mode-classifier-<date>` beta token, no agent header, an allowlisted
  body with an unprefixed model. Its residual, stated in the README: the
  marker is a header a hook above the router could write, and `next.origin`
  proves who raised the request, not that it is unmodified; the
  `autoModeClassifier: false` opt-out (session-wide flags plus the reload
  rule in `shadow.ts`) removes the exception. Any change there needs a test
  asserting zero network calls. The `http.fetch` hook carries a `.catch`
  (`shadowFetchFailed`, which never evaluates the predicate and never grants
  the exception) and the `turn.step` hook a try/catch plus `.catch`: a
  failing hook must never let a shadow request, a prefixed model or (under
  the opt-out) an engine request reach the network or the engine.
- **The provider send is guarded after the shadow rules** (`hooks/answer.ts`):
  a nested `$.http.fetch` skips the mod's own `http.fetch` hook, so the
  handler itself refuses, before anything is sent, a routed model equal to
  `SHADOW_MODEL` and a custom endpoint URL naming it; a conversation that
  merely quotes the name is sent.
- **The curl transport leaks nothing and never retries.** argv is exactly
  `curl --disable --config -` (no `.curlrc`); the URL, headers and body go
  through one config encoder on the child's stdin, and anything that could
  break out of a config line is rejected before curl starts; every key
  source is blanked in the child's environment; stdout and stderr are
  capped while reading. `$.http.fetch` is the fallback only when curl
  failed to start (nothing was sent); any later curl failure is the call's
  error, never a retry through `$.http.fetch`.
- **The SSE answer reports zero usage and the provider's model name**
  (`hooks/sse.ts`): real usage would make the engine price the shadow model
  at invented rates in `/cost` and start its own compaction at an assumed
  1M window, through a request that bypasses `turn.step`; the mod records
  the reply's real usage itself (`context.ts`, from the job, only for a
  delivered step). Only ordinary stop reasons (`end_turn`, `tool_use`,
  `max_tokens`, `stop_sequence`) are answered in place; every other reply
  takes the error path (the empty stub from the fetch side, hook-made
  `errorChunks` from the step side), since the engine acts on those itself.
- **Thread-state invariants** (`hooks/thread.ts`, `routedStep`; delivery
  table in `routedStep`'s header): at capture the step's system prompt and
  effective tools (after its `tool_addition` / `tool_removal` blocks) are
  kept on the loop at once, the conversation and anchors withheld; a reply
  is recorded only when the engine's result reflects the handed answer
  (`sameDelivery`: text trimmed, tool arguments deep-equal whatever the key
  order, the stop reason) with no Esc — the minted `msg_pr_*` id is bound as
  an anchor then; a step that reached the provider and failed is recorded
  with its error text as the assistant turn once its error chunks were read
  to the end without Esc; Esc records nothing; anything ambiguous (a
  mismatch, a stream failure, a step never captured or never handed, a
  stream closed or left mid-stream) drops the loop's conversation
  (`dropBase`), to be rebuilt from
  `$.session.messages({ as: 'api' })`; a dispatch cancelled without Esc
  yields a visible error step, not silence; a late continuation acts on the
  loop's state only while its job is the loop's newest (`latestJob`); a
  history with no
  assistant turn is never used (the clear error, or for a fork the forked
  loop's conversation); a loop with no state takes another loop's system
  prompt and tools only when `$.agent.list()` shows it is a fork; every
  recorded step keeps its `previous_message_id` anchors. Breaking these
  misaligns every later continue; any change needs `thread.test.ts` coverage.
- The hooks module checker allows `$` only as `$.noun.call(...)` or passed to
  a top-level function of this module (not a closure).
- No secrets anywhere: not in code, tests, fixtures, logs, errors or commits.
  Tests use obvious fake keys; `hooks/secrets.test.ts` checks no output
  contains a key. Error text goes through `sanitize` / `redact` in
  `hooks/errors.ts`.
- TDD: write the test first and see it fail. Each module has a `*.test.ts`
  beside it, with success and error paths.
- Imports use the `.ts` extension. Code comments in English.
- Conventional Commits, one logical change per commit.

## Adding a provider

- Anthropic-compatible: a row in `ANTHROPIC_ROWS` (`hooks/providers/anthropic.ts`).
  OpenAI-compatible: a branch in `targetFor` (`hooks/providers/openai.ts`). An
  endpoint quirk goes in the `OpenAITarget` fields (`rejectsStop`,
  `effortScale`), passed through `ChatOptions` to `toChat`, as xAI does.
- Its prefix in `SimpleProvider` and `SIMPLE` (`hooks/route.ts`; error text and
  `KeyedProvider` follow) and the dispatch in `routedStep`.
- Key: `KEY_SOURCES` plus a literal `$.env.get('<NAME>')` in `loadConfig`
  (`hooks/config.ts`), and a `userConfig` field in `.claude-plugin/plugin.json`.
- A row in `rows()` (`hooks/providers-command.ts`) for `/providers`.
- Its models in `MODEL_LIMITS` (`hooks/limits.ts`).
- README (keys table, limits) and a smoke case in `scripts/smoke.sh`.

## Commands

Run sequentially, never in parallel (also `npm test`, `npm run typecheck`,
`npm run validate`):

```bash
claude plugin test .                                                       # unit tests
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/curl-integration.mts  # real-curl checks (npm test runs both)
npm_config_cache="$TMPDIR/npm-cache" npx -y -p typescript@5.6.3 tsc -p .   # type check (exit 0)
claude plugin validate .                                                   # manifest + hooks
scripts/automode-check.sh                                                  # auto mode vs the mock provider (classifier requests on the subscription)
scripts/smoke.sh                                                           # live, costs money, needs keys
```

`scripts/automode-check.sh` and the probes in `scripts/probes/` (see the
README there) re-check the engine behaviour the design depends on
(`docs/design-notes.md`); re-run them after a Claude Code release that
changes the plugin API or auto mode.

`claude plugin validate .` reports TS5097 warnings for `.ts` import paths in
test files; those are known and not failures.
`.claude-plugin/types/` is generated on first load and git-ignored.

`scripts/smoke.sh` reads `ROUTER_ANTHROPIC_API_KEY`, `ZAI_API_KEY`,
`OPENAI_API_KEY`, `XAI_API_KEY`, and for a custom endpoint `SMOKE_CUSTOM_URL`,
`SMOKE_CUSTOM_NAME`, `SMOKE_CUSTOM_MODEL`, `ROUTER_CUSTOM_API_KEYS`; see its
header for the rest. It passes plugin options via `--settings` with
`pluginConfigs["provider-router@inline"]`.

## Test-kit quirks (`claude-code/testing`)

- Read a `$.turn.step(...)` stream with `.next()` until `done`;
  `stream.result` is `undefined` in the kit.
- Stub `clock.sleep` (`on('clock.sleep', () => ({ value: undefined }))`),
  otherwise sleeps wait on the mocked clock. Op hooks (`http.fetch`,
  `tool.list`, `clock.sleep`, `session.messages`) answer `{ value }`.
- The kit refuses `$.http.fetch` from a test's own hooks, and the kit's mod
  instance is separate from the test's imports. Inject `fetch` / `sleep` /
  `signal` (`StepIO`) and test `routedStep`, `shadowFetch` and
  the adapters directly; plugin-level tests cover key loading, the shadow
  model and zero network.
- The kit's `$` has no `env` noun: `loadConfig` tests pass a fake `$`.
