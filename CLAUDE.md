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
  request building and the two adapters. `hooks/chunks.ts`, `hooks/call.ts`,
  `hooks/errors.ts`, `hooks/context.ts`, `hooks/providers-command.ts`.
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
  stay 0). Any change there needs a test asserting zero network calls.
- No secrets anywhere: not in code, tests, fixtures, logs, errors or commits.
  Tests use obvious fake keys; `hooks/secrets.test.ts` checks no output
  contains a key. Error text goes through `sanitize` / `redact` in
  `hooks/errors.ts`.
- TDD: write the test first and see it fail. Each module has a `*.test.ts`
  beside it, with success and error paths.
- Imports use the `.ts` extension. Code comments in English.
- Conventional Commits, one logical change per commit.

## Commands

Run sequentially, never in parallel:

```bash
claude plugin test .                                                       # unit tests
npm_config_cache="$TMPDIR/npm-cache" npx -y -p typescript@5.6.3 tsc -p .   # type check (exit 0)
claude plugin validate .                                                   # manifest + hooks
scripts/smoke.sh                                                           # live, costs money, needs keys
```

`claude plugin validate .` reports TS5097 warnings for `.ts` import paths in
test files and missing author/icon; those are known and not failures.
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
  otherwise sleeps wait on the mocked clock. Op hooks answer `{ value }`.
- The kit refuses `$.http.fetch` from a test's own hooks, and the kit's mod
  instance is separate from the test's imports. Inject `fetch` / `sleep` /
  `signal` (`StepIO`) and test `routedStep`, `shadowFetch`, `shadowStep` and
  the adapters directly; plugin-level tests cover key loading, the shadow
  model and zero network.
- The kit's `$` has no `env` noun: `loadConfig` tests pass a fake `$`.
