# Provider Router for Claude Code

Use OpenAI, Z.ai (GLM), the Anthropic Platform API or any OpenAI-compatible
server from inside Claude Code, without giving up your Claude subscription.
Provider Router is a Claude Code plugin that routes each model request by the
prefix of its model id: `zai:glm-5.3`, `openai:gpt-5`, `anthropic:claude-opus-4-6`
or `custom:<name>:<model>` go to that provider with your API key, and every
unprefixed model (`opus`, `sonnet`, `haiku`, ...) stays on your signed-in
subscription. The main session can stay on Claude while a subagent works on
GLM or GPT, in parallel, in the same session. It runs on unmodified Claude Code
releases: no fork, no proxy server, no `ANTHROPIC_BASE_URL` tricks.

## Quick start (60 seconds)

1. Install the plugin (Claude Code 2.1.323 or later; tested on 2.1.323):

   ```
   /plugin marketplace add oleggohman/cc-things
   /plugin install provider-router@oleggohman-cc-things
   ```

2. Set one key in the shell you start Claude Code from:

   ```bash
   export ZAI_API_KEY=...                              # for zai:<model>
   # or: export OPENAI_API_KEY=sk-...                  # for openai:<model>
   # or: export ROUTER_ANTHROPIC_API_KEY=sk-ant-...    # for anthropic:<model>
   ```

3. Start Claude Code on a routed model:

   ```bash
   claude --model zai:glm-5.3
   ```

   Claude Code prints `doesn't recognize the model "zai:glm-5.3", so it assumes
   a context window of 1m tokens`. That is expected (see
   [Context windows](#context-windows)).

4. Check what the router sees:

   ```
   /providers
   ```

Plain `claude` (no `--model`) keeps the session on your subscription; routed
subagents (below) then do the provider work.

### Switching with `/model`

`/model <prefixed id>` is rejected by Claude Code (`Model 'zai:glm-5.3' not
found`): `/model` checks typed ids against Anthropic's model list. To switch a
running session, name one routed model in `ANTHROPIC_CUSTOM_MODEL_OPTION` when
you start Claude Code; `/model` then accepts it:

```bash
ANTHROPIC_CUSTOM_MODEL_OPTION=zai:glm-5.3 claude
```

```
/model zai:glm-5.3      # routed
/model sonnet           # back to the subscription
```

`--model`, the `model` setting in a settings file, and an agent's `model:`
field take any prefixed id without this.

### Try it without installing

Clone the repo and load it for one session:

```bash
git clone https://github.com/oleggohman/cc-provider-router
claude --plugin-dir ./cc-provider-router --model zai:glm-5.3
```

## Configuration

Only a key for each provider you use is needed. Everything else is optional,
and there is nothing more: timeouts and output limits have fixed defaults (see
[Limits](#limits)).

### API keys

Each key comes from an environment variable or from `/config` (the plugin's
options; the `/config` value wins). Keys entered in `/config` are kept in
Claude Code's secure storage.

| Prefix | Provider | Env variable | `/config` field |
|---|---|---|---|
| `anthropic:` | Anthropic Platform (`https://api.anthropic.com`) | `ROUTER_ANTHROPIC_API_KEY` | `anthropicApiKey` |
| `openai:` | OpenAI Platform (`https://api.openai.com/v1`) | `OPENAI_API_KEY` | `openaiApiKey` |
| `zai:` | Z.ai, Anthropic-compatible endpoint (`https://api.z.ai/api/anthropic`) | `ZAI_API_KEY` | `zaiApiKey` |
| `custom:<name>:` | an OpenAI-compatible endpoint you add | `ROUTER_CUSTOM_API_KEYS` | - |

### Custom endpoints

A custom endpoint is any server that speaks the OpenAI Chat Completions API:
LiteLLM, vLLM, Ollama, OpenRouter, a company gateway, or Z.ai's own
OpenAI-compatible API. Add one `name=url` entry per endpoint to the `/config`
list field `customEndpoints`, then use `custom:<name>:<model>`. The URL is the
base that `/chat/completions` and `/models` are appended to.

Copy-paste entries:

| `customEndpoints` entry | Model id to use |
|---|---|
| `zaioa=https://api.z.ai/api/paas/v4` | `custom:zaioa:glm-5.3` (Z.ai OpenAI-compatible, pay as you go) |
| `zaicoding=https://api.z.ai/api/coding/paas/v4` | `custom:zaicoding:glm-5.3` (Z.ai Coding Plan endpoint) |
| `litellm=http://localhost:4000/v1` | `custom:litellm:<a model name from your LiteLLM config>` |
| `ollama=http://localhost:11434/v1` | `custom:ollama:qwen3:32b` |
| `openrouter=https://openrouter.ai/api/v1` | `custom:openrouter:deepseek/deepseek-chat` |

Names may use letters, digits, `-` and `_`. Keys for custom endpoints come
from one env variable holding `name=key` pairs separated by commas; an
endpoint without a key is called without an `Authorization` header (fine for
a local server):

```bash
export ROUTER_CUSTOM_API_KEYS="litellm=sk-...,zaioa=..."
```

#### In a settings file

Plugin options can also go in a Claude Code settings file
(`~/.claude/settings.json`, or `.claude/settings.json` in a project), under the
plugin's id. After the marketplace install the id is
`provider-router@oleggohman-cc-things`:

```json
{
  "pluginConfigs": {
    "provider-router@oleggohman-cc-things": {
      "options": {
        "customEndpoints": ["litellm=http://localhost:4000/v1", "zaioa=https://api.z.ai/api/paas/v4"],
        "contextWindows": ["custom:litellm:my-model=128000"]
      }
    }
  }
}
```

With `--plugin-dir` (and in `claude -p` scripts) the id is
`provider-router@inline`; pass the file with `--settings`:

```bash
cat > router-settings.json <<'EOF'
{ "pluginConfigs": { "provider-router@inline": { "options": {
    "customEndpoints": ["ollama=http://localhost:11434/v1"] } } } }
EOF
claude --plugin-dir ./cc-provider-router --settings router-settings.json
```

Keep API keys in env variables or `/config`, not in settings files.

### Context windows

Claude Code assumes a 1M-token window for model ids it does not know, so on
its own it would not compact a routed conversation in time. The router knows
the windows of these model families, matched by id prefix (so dated and newer
ids such as `openai:gpt-5.1` or `anthropic:claude-sonnet-4-6` are covered):
`openai:gpt-5*` (400K; `gpt-5-chat*` 128K), `openai:gpt-4.1*` (~1M),
`openai:gpt-4o*` (128K), `openai:o1*`, `o3*`, `o4-mini*` (200K; `o1-mini` 128K),
`anthropic:claude-opus*`, `claude-sonnet*`, `claude-haiku*` (200K),
`zai:glm*` (200K; `glm-4.5*` 128K). It compacts a routed main session after a
turn that used 85% of the input room: the window less the model's output
limit (below), which every request reserves, so `openai:gpt-5` compacts at
about 231K input tokens, not 340K. Automatic compaction needs an interactive
session: under `claude -p` there is none, and a context-length error ends the
step. `custom:` models and anything else need a `model=tokens` entry, with the
full prefixed id (matched exactly), in the `/config` list field
`contextWindows`:

```
custom:ollama:qwen3:32b=32768
openai:gpt-5.1=400000
```

The router does not compact subagents. Set `autoCompactWindow` in a routed
agent's definition (below) to a value under the model's real window. Claude
Code accepts only 100000 to 1000000 there, so a subagent on a model with a
smaller window (such as the 32K example above) cannot be covered: keep its
tasks small.

### Invalid entries

A malformed entry (for example a `customEndpoints` entry without `=`, or a
URL with credentials in it, `https://user:pass@...`: put the key in
`ROUTER_CUSTOM_API_KEYS` instead) is skipped and shown as a warning in
`/providers`; the session keeps working.

## Model ids

```
anthropic:<model>         anthropic:claude-opus-4-6
openai:<model>            openai:gpt-5
zai:<model>               zai:glm-5.3
custom:<name>:<model>     custom:litellm:my-model, custom:ollama:qwen3:32b
anything else             your Claude subscription, untouched
```

`<model>` goes to the provider as is and may contain `/` and `:`. A router
prefix with nothing usable after it (`openai:`, `custom:gw`) is answered with
a `[provider-router]` error, never sent to your subscription.
`/providers models` asks each configured provider for its models and lists
them already prefixed, ready to copy.

## Subagents on another provider

Give a subagent a prefixed `model:`. The main session stays on your
subscription; the subagent's steps go to the provider. Save this as
`~/.claude/agents/glm-worker.md` (or in a project's `.claude/agents/`):

```markdown
---
name: glm-worker
description: General worker on a Z.ai GLM model (via provider-router). Use for self-contained tasks that should not spend the Claude subscription.
model: zai:glm-5.3
tools: Read, Grep, Glob, Bash
autoCompactWindow: 160000
---
You are a focused worker. Do exactly the task you are given with the tools you have,
then report the result briefly: what you did, what you found, and any command output
the task asked for, verbatim.
```

Then ask: "Use the glm-worker agent to list every TODO in src/". More in
[`examples/agents/`](examples/agents/): `gpt-worker` (`openai:gpt-5-mini`) and
`platform-opus` (`anthropic:claude-opus-4-6`, billed to a Platform key
instead of the subscription). Several routed subagents can run in parallel,
also in the background while the main session keeps working.

## How it works

```
                        Claude Code engine
                                |
                          turn.step(e)
                                |
                     provider-router hook:
                     prefix of e.model?
               +----------------+------------------+
           no prefix                            prefix
               |                                   |
       next(e), unchanged         1. shadow step: the engine builds this
               |                     step's request (system prompt, tools,
      Claude subscription            messages) for a model id that does not
                                     exist; the router's http.fetch hook
                                     captures it and answers it locally
                                     (it is never sent)
                                  2. rebuild the full conversation
                                     (history kept per loop)
                                  3. send it to the provider with your key
                                        |                     |
                             Anthropic Messages API   OpenAI Chat Completions
                             anthropic:, zai:         openai:, custom:<name>:
                             (as is)                  (translated both ways)
                                        |                     |
                                  4. reply -> text and tool-call chunks;
                                     Claude Code runs the tools as usual
```

Claude Code still runs tools, permissions, hooks, subagents and the
transcript; only the model call moves. The engine behaviour this relies on is
written up in [`docs/design-notes.md`](docs/design-notes.md).

## Limits

- **No streaming** for routed models: a reply appears when it is complete.
- **No extended thinking on any routed model**, and `effort` is ignored,
  except that it becomes `reasoning_effort` for OpenAI reasoning models (`o*`,
  `gpt-5*` except `gpt-5-chat*`). Thinking blocks in a reply are dropped.
- **Prompt caching and server tools** (web search, code execution): the
  request's cache breakpoints and tool definitions are passed to `anthropic:`
  and `zai:` as Claude Code wrote them (at most 4 breakpoints), so whether
  they work is up to the provider; not verified live. On `openai:` and
  `custom:` neither is translated.
- **Deferred tools** (tool search): a deferred tool is sent once it has been
  loaded; until then it is left out, on every provider.
- **Output limits are fixed per model** (`max_tokens`, by id prefix):
  `openai:gpt-5*` 128000 (`gpt-5-chat*` 16384), `openai:gpt-4.1*` 32768,
  `openai:gpt-4o*` 16384, `openai:o1*` / `o3*` / `o4-mini*` 100000
  (`o1-mini` 65536), `anthropic:claude-opus*` 32000,
  `anthropic:claude-sonnet*` / `claude-haiku*` 64000, `zai:glm*` 32768.
  Everything else, including every `custom:` model, gets 8192, which is not
  configurable: a very long file write on such a model can stop at the limit.
- **Esc does not cancel a call already sent.** The step ends at once, but the
  provider still finishes the request and bills it. Provider timeout: 600 s.
  Esc while a reply is being handed to Claude Code drops the router's copy of
  the conversation; the next step rebuilds it from the session history.
- **An organization-managed guard can switch routing off.** The router sees
  the request Claude Code builds through its own `http.fetch` hook. Where an
  organization's guard loads, Claude Code shows engine requests to the
  guard's own plugins only. Then the first routed step's stand-in request
  (full conversation, for the non-existent model `provider-router-shadow`)
  goes to Anthropic's API under your session (refused there, not billed), the
  step answers `routing is off ...`, and every later routed step answers the
  same without sending anything. `/providers` shows `routing is off` then.
  Routing turns back on by itself as soon as the router sees any Claude Code
  request (a step on a model without a router prefix), which cannot happen
  under such a guard; otherwise restart Claude Code. A routed step that
  sends no request at all (another plugin answered it, or Claude Code failed
  before sending) looks the same to the router and also turns routing off
  until then; in a session where every step is routed, that lasts until a
  restart.
- **Your subscription is never routed** and never pays for a routed call. The
  router does not use your Claude sign-in.
- **History in memory.** Claude Code sends a conversation as a thread (after
  the first request, only the new messages), so the router keeps each routed
  conversation's history itself. When it has none for a step (after a step
  that failed before its request was captured, Esc on a conversation's first
  routed step or while a reply was handed over, an engine fork such as
  compaction, a subagent resumed after
  its turn ended, or a switch from a subscription model), it rebuilds it from
  the session's own history. An engine fork such as compaction takes the
  system prompt and tools of the conversation it forks; a subagent never
  takes the main conversation's. A `/config` change or a plugin reload clears
  the system prompt and tools as well; then, or when the session cannot give
  the history, the next routed step says so: run `/clear` or `/compact`, then
  continue (a subagent: start a new one). After a `/rewind`, a continue from
  an earlier turn drops the turns after it.
- **Errors** come back as the model's reply, prefixed `[provider-router]`,
  with stop reason `refusal` (Claude Code has no error stop reason), or
  `model_context_window_exceeded` for a context-length error. A parent agent
  gets the same text from a routed subagent.
- **`/cost` shows a `provider-router-shadow` line with 0 tokens and $0.** That
  is the local stand-in for the captured request. It is expected and never
  costs anything. Routed usage is on each provider's own dashboard.

## Verified status (v0.1.0, Claude Code 2.1.323)

| Provider | Status |
|---|---|
| Z.ai (`zai:glm-5.3`) | live-verified: routed main session, subagent, two parallel subagents, background subagent |
| custom: Z.ai OpenAI-compatible (`https://api.z.ai/api/paas/v4`) | live-verified, same cases |
| custom: LiteLLM proxy with a key | live-verified, same cases |
| Anthropic Platform (`anthropic:`) | unit-tested; requests reach the API and `/providers models` works, but no full live run at release |
| OpenAI Platform (`openai:`) | unit-tested only; not live-verified at release |

Not yet checked by hand in an interactive session: Esc during a routed step,
automatic compaction of a routed main session, `/rewind` in a routed
session, and rebuilding a routed conversation from the session history
(after `/model` from a subscription model, a compaction fork, or a resumed
subagent). Reports welcome.

## Why not `ANTHROPIC_API_KEY`?

When `ANTHROPIC_API_KEY` is set, Claude Code itself uses it for every request
instead of your subscription sign-in. The router reads its Anthropic Platform
key from `ROUTER_ANTHROPIC_API_KEY` (or `/config`), so only `anthropic:`
models use it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `[provider-router] openai error: no API key for openai ...` | set the env variable the message names, in the shell that starts `claude`, or the `/config` field |
| `/providers` says `key: no` though you exported the key | the variable must be set where `claude` starts; check the name (`ROUTER_ANTHROPIC_API_KEY`, not `ANTHROPIC_API_KEY`) |
| `Model '...' not found` after `/model` | see [Switching with `/model`](#switching-with-model) |
| `error 401` / `error 403` | wrong key, or the key has no access to that model |
| `error 404` | wrong model id or base URL; compare with `/providers models` |
| `error 429`, or `credit balance is too low` | rate limit, or no credit on the provider account |
| `unknown custom endpoint "x"` | the name in `custom:<name>:` must match a `customEndpoints` entry |
| `the conversation so far is not known to the router` | the plugin reloaded mid-conversation (or the history could not be rebuilt): run `/clear` or `/compact` |
| `routing is off: this plugin saw no engine request ...` | an organization-managed guard may hide Claude Code's requests from this plugin (see Limits); routing cannot work in that setup. If no guard is involved (another plugin answered a routed step), it turns back on after any step on a model without a router prefix, or restart Claude Code |
| `malformed model id "..."` | a router prefix with nothing after it (`openai:`, `custom:gw`): use `<prefix>:<model>` or `custom:<name>:<model>` |
| context-length error in a subagent | the task was too large for the model: lower `autoCompactWindow` or split the task |
| anything else | `/providers` (status, warnings, counters), `/providers models` (calls each provider), `claude --debug` |

`/providers` also shows two safety counters, `shadowLeaks` and
`shadowRefused`. `shadowLeaks` must be 0; if it is not, please open an issue.
It adds a `routing is off` line when the router has switched itself off
because it saw no Claude Code request for a routed step (see Limits).

## Security

- Keys are read from the env variables above and from `/config` (stored by
  Claude Code in its secure storage). The router writes keys nowhere: not to
  disk, logs, state, transcripts or replies.
- Provider error text is scrubbed of configured keys, and of anything shaped
  like a key, before it is shown.
- A key is sent only to its own provider's base URL. Custom endpoint URLs are
  yours to choose; use `https` for anything not on your machine.
- The captured request never leaves your machine: the router answers it
  locally, its model id does not exist, and any request the router cannot
  match is refused (it fails closed).
- The router never uses your Claude sign-in to pay for a routed call.

## Development

```bash
claude plugin test .                                                       # unit tests
npm_config_cache="$TMPDIR/npm-cache" npx -y -p typescript@5.6.3 tsc -p .   # type check
claude plugin validate .                                                   # manifest and hooks
```

The live smoke test calls real providers and costs a little. Each provider
runs only when its key is set:

```bash
ZAI_API_KEY=... scripts/smoke.sh
OPENAI_API_KEY=sk-... SMOKE_ONLY=openai scripts/smoke.sh
SMOKE_CUSTOM_URL=http://localhost:4000/v1 SMOKE_CUSTOM_NAME=litellm \
  SMOKE_CUSTOM_MODEL=my-model ROUTER_CUSTOM_API_KEYS="litellm=sk-..." scripts/smoke.sh
```

Requirements: `claude`, `jq`, and `timeout` (GNU coreutils; on macOS
`brew install coreutils` provides `gtimeout`, which the script uses). Other
settings: `SMOKE_CASES` (any of `main turns switch sub parallel background
errors`; default all), `SMOKE_ONLY` (provider labels: `anthropic zai openai
custom`), `SMOKE_ANTHROPIC_MODEL` (default `claude-haiku-5-5`),
`SMOKE_ZAI_MODEL` (default `glm-5.3`), `SMOKE_OPENAI_MODEL` (default
`gpt-5-mini`), `SMOKE_CUSTOM_NAME` (default `smoke`), `SMOKE_MAIN_MODEL` (the
subscription model for the subagent and switch cases; default your default
model), `SMOKE_TIMEOUT` (seconds per session, default 600), `SMOKE_KEEP=1`.
Transcripts are read from `${CLAUDE_CONFIG_DIR:-~/.claude}/projects`.
Conventions for contributors are in [CLAUDE.md](CLAUDE.md).

## License

MIT, see [LICENSE](LICENSE).
