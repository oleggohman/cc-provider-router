# xAI (Grok) provider: `xai:<model>`

## Overview
- Adds Grok as a built-in provider: `xai:<model>` (for example `xai:grok-4.7`), billed to an xAI API key, next to `anthropic:`, `openai:`, `zai:` and `custom:`.
- Today Grok works only as a `custom:` endpoint (`customEndpoints: ["xai=https://api.x.ai/v1"]`, `ROUTER_CUSTOM_API_KEYS="xai=<key>"`), which gets no reasoning settings, no built-in context window (a `contextWindows` entry works) and the 8192 output default. A built-in row fixes all three and makes `/providers` and the README name it.
- Ships from `main` on its own (target `v0.1.3`); the `feat/answer-in-place` branch picks it up by rebase later.

## Context (from discovery)
- xAI's documented API (docs.x.ai, checked 2026-11-15):
  - base URL `https://api.x.ai/v1`, OpenAI-compatible Chat Completions at `/chat/completions`, `Authorization: Bearer <key>`; the conventional key variable is `XAI_API_KEY`;
  - the Anthropic-compatible `/v1/messages` is listed under "Legacy & Deprecated" ("The Anthropic SDK compatibility is fully deprecated"), so the OpenAI-compatible adapter is used;
  - xAI's docs file Chat Completions under "legacy" too (the Responses API is preferred), but it is served and documented; a Responses adapter is out of scope here and noted as a follow-up in the README;
  - current models: `grok-4.7`, `grok-4.6`, `grok-4.5` (500k context), `grok-4.3`, `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning`, `grok-4.20-multi-agent-0309` (1M), `grok-build-0.1` (256k); aliases `<model>` and `<model>-latest`, dated ids `<model>-<date>`;
  - reasoning: every Grok 4.x model reasons ("Reasoning cannot be disabled") except the `-non-reasoning` variants; `reasoning_effort` takes `low`, `medium`, `high`, and `xhigh` on models that support it (others treat `xhigh` as `high`); default `high`;
  - "`presencePenalty`, `frequencyPenalty`, and `stop` cannot be used with reasoning models. Requests that include them return an error."
  - no maximum output size is published on the model pages.
- Code: `hooks/route.ts` (`SimpleProvider`, `SIMPLE`, `ID_FORMS`, `classifyModel`), `hooks/config.ts` (`KEY_SOURCES`, `loadConfig` literal `$.env.get`), `.claude-plugin/plugin.json` (`userConfig`), `hooks/providers/openai.ts` (`targetFor`, `isReasoningModel`, `OpenAITarget`), `hooks/translate.ts` (`toChat`: `reasoning` drops `temperature` / `top_p` and maps effort; `stop` is always copied), `hooks/register.ts` (`routedStep` dispatch: non-Anthropic routes go to `targetFor`), `hooks/providers-command.ts` (`rows()`), `hooks/limits.ts` (`MODEL_LIMITS`), `hooks/secrets.test.ts`, `README.md`, `scripts/smoke.sh`. `CLAUDE.md` "Adding a provider" lists exactly these places.
- No xAI key is available on this machine (`XAI_API_KEY` unset): nothing in this plan can be live-verified here. The README states the status as "unit-tested only" until a smoke run.

## Development Approach
- **testing approach**: TDD (tests first), as `CLAUDE.md` requires
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task, success and error paths
- **CRITICAL: every task ends green**: `npm test`, `npm run typecheck`, `npm run validate`, in that order, never in parallel
- **CRITICAL: update this plan file when scope changes during implementation**
- commit per task (Conventional Commits, no Co-Authored-By); merge, tag and publish only with the user's go-ahead

## Testing Strategy
- **unit tests**: `claude plugin test .`, beside each changed module; the adapter is tested with an injected `fetch`, never the network.
- **secrets**: `hooks/secrets.test.ts` covers the new key in every output.
- **live smoke**: a `scripts/smoke.sh` case that runs only when `XAI_API_KEY` is set (not runnable here).

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix; blockers with ⚠️ prefix

## Solution Overview
- `xai` joins `SimpleProvider` and `SIMPLE`, so `xai:<id>` parses, `xai:` alone is malformed (local error, never sent to the engine), and `ID_FORMS` names it.
- `targetFor` gains an `xai` branch: base `https://api.x.ai/v1`, key `cfg.keys.xai`, `reasoning: isXaiReasoningModel(model)`, and a new target field `rejectsStop: true` for reasoning models.
- `toChat` drops `stop` when the target says `rejectsStop` (xAI documents an error otherwise); `presence_penalty` / `frequency_penalty` are never sent today, so nothing else changes. For xAI, effort `xhigh` and `max` are sent as `xhigh` (xAI treats it as `high` where unsupported); OpenAI's mapping stays as it is.
- Limits: a row per documented family by prefix, most specific first.

## Technical Details
- `isXaiReasoningModel(model)`: true unless the id contains `non-reasoning`. Unknown future ids are treated as reasoning (the safer side: no `stop`, no sampling fields).
- `OpenAITarget` gains `rejectsStop: boolean` and `effortScale: 'openai' | 'xai'`; `ChatOptions` carries both. Defaults keep today's behaviour for `openai:` and `custom:`.
- Effort mapping for `xai`: `low`/`medium`/`high` as is; `xhigh` and `max` → `xhigh`; a numeric effort → none.
- `MODEL_LIMITS` rows (window, maxOutput): `xai:grok-build` 256 000 / 32 768; `xai:grok-4.20` 1 000 000 / 32 768; `xai:grok-4.3` 1 000 000 / 32 768; `xai:grok-4` 500 000 / 32 768 (covers 4.5, 4.6, 4.7 and newer 4.x until a row says otherwise). The 32 768 output limit is a stated assumption (no published maximum); the README says so and a successful smoke run is the check.
- Key: `KEY_SOURCES.xai = { env: 'XAI_API_KEY', field: 'xaiApiKey' }`; `loadConfig` reads `$.env.get('XAI_API_KEY')` (literal); `plugin.json` `userConfig.xaiApiKey` (`sensitive: true`), as the other keys.

## What Goes Where
- **Implementation Steps**: code, tests and docs in this repo.
- **Post-Completion**: the live smoke run with a real xAI key; release.

## Implementation Steps

### Task 1: Route, key, adapter target and request translation

One task, because adding `xai` to `SimpleProvider` makes `routedStep` hand xAI routes to `targetFor` (the existing non-Anthropic dispatch), which must accept them for the type check to pass. No new dispatch branch is needed.

**Files:**
- Modify: `hooks/route.ts`, `hooks/route.test.ts`, `hooks/config.ts`, `hooks/config.test.ts`, `.claude-plugin/plugin.json`, `hooks/providers/openai.ts`, `hooks/providers/openai.test.ts`, `hooks/translate.ts`, `hooks/translate.test.ts`, `hooks/register.test.ts`

- [x] write tests: `parseModel('xai:grok-4.7')` → `{ provider: 'xai', model: 'grok-4.7' }`; ids with `/` and `:` after the prefix; `xai:` alone is malformed (`classifyModel` → `malformed`); `ID_FORMS` names `xai:<id>`; a model id merely containing `xai` without the prefix stays unprefixed
- [x] write tests: the key comes from the `xaiApiKey` option over `XAI_API_KEY`; env-only loading; missing key → `missingKeyMessage('xai')` names both
- [x] write tests for `targetFor` with an `xai` route: base URL `https://api.x.ai/v1`, bearer key, label `xai`, `reasoning` true for `grok-4.7` and `grok-4.7-latest`, false for `grok-4.20-0309-non-reasoning`, `grok-4.20-non-reasoning` and `grok-4.20-non-reasoning-latest`, `rejectsStop` follows `reasoning`, `effortScale` `xai`; missing key → the missing-key error
- [x] write tests for `toChat` on an xAI reasoning target: no `stop` even when the request has `stop_sequences`, no `temperature` / `top_p`, `reasoning_effort` `xhigh` for effort `xhigh` and `max`, `low`/`medium`/`high` as is, none for a number and none when effort is omitted; on an xAI non-reasoning target: `stop`, `temperature` and `top_p` kept, no `reasoning_effort`
- [x] widen `ChatRequest.reasoning_effort` to include `xhigh`, and forward `rejectsStop` and `effortScale` from the target through `complete()` into `toChat`; assert the serialized POST body through `complete()` (not only `toChat`)
- [x] write regression tests through `complete()` that `openai:` reasoning and non-reasoning requests and `custom:` requests (including a `custom:` endpoint serving a Grok model id) are byte-for-byte as before: `stop` kept, OpenAI effort mapping unchanged, no `xhigh`
- [x] write `routedStep` tests: an `xai:` step posts to `https://api.x.ai/v1/chat/completions` with `authorization: Bearer <fake key>` and the reply comes back as chunks; a malformed `xai:` id and an `xai:` step with no key each answer locally with zero engine and zero provider calls
- [x] implement the route, `KEY_SOURCES`, the literal `$.env.get('XAI_API_KEY')`, the `userConfig` field (plugin description lists `xai:`), `isXaiReasoningModel`, the `targetFor` branch and the `ChatOptions` / `OpenAITarget` fields
- [x] run tests, typecheck, validate - must pass before Task 2

### Task 2: Limits, `/providers` and secrets

**Files:**
- Modify: `hooks/limits.ts`, `hooks/limits.test.ts`, `hooks/providers-command.ts`, `hooks/providers-command.test.ts`, `hooks/secrets.test.ts`

- [x] write tests: `maxOutputTokens` and `windowFor` for `xai:grok-4.7`, `xai:grok-4.7-latest`, `xai:grok-4.3`, `xai:grok-4.20-0309-reasoning`, `xai:grok-4.20-multi-agent-0309`, `xai:grok-build-0.1`; an unknown `xai:` id outside the `grok-4` family gets the default; a `contextWindows` entry for an exact `xai:` id wins over the row
- [x] write tests: `/providers` lists an `xai` row with its base URL and key status; `/providers models` calls `GET https://api.x.ai/v1/models` with the bearer key and lists the ids (as the `openai` row does); an unkeyed `xai` row is skipped with no call
- [x] extend `hooks/secrets.test.ts` so the xAI key appears in no output (errors, `/providers`, `/providers models` failures)
- [x] implement the rows in `MODEL_LIMITS` and `rows()`
- [x] run tests, typecheck, validate - must pass before Task 3

### Task 3: Docs and smoke case

**Files:**
- Modify: `README.md`, `scripts/smoke.sh`, `CLAUDE.md`

- [ ] README: the keys table (`XAI_API_KEY` / `xaiApiKey`); an `xai:grok-4.7` example; every list of accepted prefixes and the adapter-dispatch description (`xai:` → Chat Completions, translated); the limits list with the 32 768 output assumption; the effort sentence (today "only OpenAI reasoning models") extended with xAI's mapping (`xhigh`/`max` → `xhigh`) and the dropped `stop` sequences on xAI reasoning models; the smoke-provider list; a note that xAI's Anthropic-compatible endpoint is deprecated and its Chat Completions is filed as legacy (a Responses adapter is a possible follow-up); and the verified-status row "xAI (`xai:`): unit-tested only; not live-verified at release"
- [ ] `scripts/smoke.sh`: an `xai xai:$XAI_MODEL` provider case when `XAI_API_KEY` is set (`SMOKE_XAI_MODEL`, default `grok-4.7`), skipped otherwise; header comment lists it
- [ ] `CLAUDE.md`: the smoke key-variable list gains `XAI_API_KEY`; the "Adding a provider" list mentions the `OpenAITarget` / `ChatOptions` fields an OpenAI-compatible provider may need
- [ ] bump `package.json` and `.claude-plugin/plugin.json` version to `0.1.3`
- [ ] run tests, typecheck, validate - all pass

### Task 4: Verify

- [ ] `npm test`, `npm run typecheck`, `npm run validate` - all pass
- [ ] run `code-reviewer` on the branch, fix findings with `review-fixer`, re-review (max 3 rounds)

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

- A live smoke run with `XAI_API_KEY` set (`SMOKE_ONLY=xai scripts/smoke.sh`): confirms that, for the default model, a request with the 32 768 output cap is accepted and tool calls round-trip. It does not establish the true maximum, other model families, or that every `reasoning_effort` value is accepted (the smoke run sends the session's default effort only). Until then the README row stays "unit-tested only".
- Release `v0.1.3` from `main` (merge, tag, push, Trivy) with the user's go-ahead; then rebase `feat/answer-in-place` on it.
