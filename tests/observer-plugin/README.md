# fetch-observer (test-only mod)

A second mod whose only hook is an `http.fetch` hook: it appends one JSON
line per request it sees to a file and returns `next(e)` untouched. Loaded
beneath provider-router it records what actually left the router, which is
what the probes (`scripts/probes/`) and the auto-mode check assert on.

Each line: `t`, `seq`, `url`, `method`, `model` and `bodyKeys` (when the body
is JSON), `bodyType`, `origin` (the host-set `next.origin`), `headers` (names
only; a name that carries a credential is listed with `redacted: true`),
`agent` (`subagent` when the request has `x-claude-code-agent-id`),
`classifierBeta` (the `anthropic-beta` token matching
`^auto-mode-classifier-\d{4}-\d{2}-\d{2}$`, else `null`; no other header
value is ever written). With these fields the classifier predicate can be
evaluated from the record: `scripts/probes/check-predicate.py --observer`
checks the schema and classifies each line.

The file is the plugin option `logFile`, else env `FETCH_OBSERVER_LOG`:

```json
{"pluginConfigs":{"fetch-observer@inline":{"options":{"logFile":"/tmp/x/observer.jsonl"}}}}
```

## Load order (checked live, Claude Code 2.1.325)

Mods of the same tier nest in the order of the `--plugin-dir` flags, first
outermost (the debug log lists them as `environment 1`, `environment 2`):

| Flags | The observer sees |
|---|---|
| `--plugin-dir <router> --plugin-dir <observer>` (beneath the router) | the router's nested provider fetch (`origin.plugin: "provider-router"`), every engine request the router passes with `next(e)`, other plugins' fetches (telemetry). Not the shadow request, which the router answers |
| `--plugin-dir <observer> --plugin-dir <router>` (above the router) | all of that, and the engine's shadow request before the router answers it |

A fetch a hook makes with `$.http.fetch` skips only the calling mod's own
hook (`http.fetch skipped: re-entry`); every other mod's hook runs for it
(`http.fetch nested in provider-router#1`), whichever side of the caller it
sits on. So the observer sees the router's provider call in both orders, and
"beneath" matters only for engine requests.

`$.fs` has no append: the observer keeps its lines in memory and rewrites the
file per request, keeping in front what the file held when the module loaded.
