# CLAUDE.md

Guidance for coding agents working in this repository.

## What this is

A Claude Code plugin with a TypeScript hooks module (a "mod"). `hooks/hooks.json`
loads `hooks/register.ts`, which registers hooks on `turn.step`, `http.fetch`,
`turn.complete`, `session.start` and `command.run` (`/providers`). User docs
are in `README.md`; the engine behaviour the design depends on is in
`docs/design-notes.md`; the implementation plan is in `docs/plans/`.

## Layout

- `hooks/register.ts`: wiring and `routedStep` (shadow step, provider call, reply).
- `hooks/route.ts`: model-id prefix parsing. `hooks/config.ts`: keys, custom
  endpoints, context windows from `options` + env.
- `hooks/shadow.ts`: captures the engine's request locally. `hooks/thread.ts`:
  per-loop conversation state for message-thread continues, body normalization.
- `hooks/request.ts`, `hooks/translate.ts`, `hooks/providers/{anthropic,openai}.ts`:
  request building and the two adapters. `hooks/limits.ts`: per-model
  context windows and max output tokens (one prefix-matched table).
  `hooks/call.ts`: timeout/cancel of a provider call and the shared fetch and
  adapter-result types. `hooks/chunks.ts`, `hooks/errors.ts`,
  `hooks/context.ts`, `hooks/providers-command.ts`.
- `tests/harness.ts`, `tests/fixtures/`: shared test stand-ins and transcripts.
- `scripts/smoke.sh`: live smoke tests. `examples/agents/`: routed subagents.

## Conventions

- Hooks have the shape `($, e, next)`; `turn.step` is
  `async function* ($, e, next)` and passes unprefixed models through with
  `return yield* next(e)` untouched.
- Config is read only from `register`'s `options` and env (`$.env.get` with
  literal names). A `/config` change reloads the module; no live `$.config`
  reads. Never call `$.session.authorize()` or set `init.auth`: routed calls
  bill the configured key, never the subscription.
- **The shadow capture fails closed.** Do not weaken the rules in
  `hooks/shadow.ts` (strict match, one pending capture per loop held until the
  stream ends, refuse every unmatched shadow-model request, `shadowLeaks` must
  stay 0). Any change there needs a test asserting zero network calls. The
  `http.fetch` hook carries a `.catch` (`shadowFetchFailed`) and the
  `turn.step` hook a try/catch plus `.catch`: a failing hook must never let a
  shadow request or a prefixed model reach the network or the engine.
- **Thread-state invariants** (`hooks/thread.ts`, `routedStep`): a step that
  reached the provider and failed is recorded with its error text as the
  assistant turn; a step is recorded only once its reply is delivered (the
  engine read every chunk and asked for the result without Esc); a step
  cancelled (Esc) before delivery records nothing; a step whose delivery was
  cut short, or that failed before its request was captured, drops the loop's
  conversation (`dropBase`), to be rebuilt from
  `$.session.messages({ as: 'api' })`; recorded tools are the ones in force
  after the step's tool additions and removals; a history with no
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
  OpenAI-compatible: a branch in `targetFor` (`hooks/providers/openai.ts`).
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
npm_config_cache="$TMPDIR/npm-cache" npx -y -p typescript@5.6.3 tsc -p .   # type check (exit 0)
claude plugin validate .                                                   # manifest + hooks
scripts/smoke.sh                                                           # live, costs money, needs keys
```

`claude plugin validate .` reports TS5097 warnings for `.ts` import paths in
test files; those are known and not failures.
`.claude-plugin/types/` is generated on first load and git-ignored.

`scripts/smoke.sh` reads `ROUTER_ANTHROPIC_API_KEY`, `ZAI_API_KEY`,
`OPENAI_API_KEY`, and for a custom endpoint `SMOKE_CUSTOM_URL`,
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
  `signal` (`StepIO`) and test `routedStep`, `shadowFetch`, `shadowStep` and
  the adapters directly; plugin-level tests cover key loading, the shadow
  model and zero network.
- The kit's `$` has no `env` noun: `loadConfig` tests pass a fake `$`.
