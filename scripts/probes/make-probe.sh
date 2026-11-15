#!/usr/bin/env bash
# Generates the probe mod: a throwaway copy of the plugin at HEAD, rewired to
# scripts/probes/probe-mod/probe.ts (a rough "answer in place" that logs what
# it sees). Nothing under hooks/ in the repo is touched.
#
# usage: scripts/probes/make-probe.sh <out-dir>
#
# The copy is loaded with `claude --plugin-dir <out-dir>`; see README.md.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:?usage: make-probe.sh <out-dir>}"
case "$OUT" in "$ROOT"|"$ROOT"/*) echo "the probe must not be generated inside the repo" >&2; exit 2 ;; esac

rm -rf "$OUT"
mkdir -p "$OUT"
git -C "$ROOT" archive HEAD | tar -x -C "$OUT"
cp "$ROOT/scripts/probes/probe-mod/probe.ts" "$OUT/hooks/probe.ts"

python3 - "$OUT" <<'PY'
import json, sys
out = sys.argv[1]

def patch(path, pairs):
    text = open(path).read()
    for old, new in pairs:
        if text.count(old) != 1:
            sys.exit(f"make-probe: anchor not found exactly once in {path}: {old[:70]!r}")
        text = text.replace(old, new)
    open(path, 'w').write(text)

patch(f"{out}/hooks/register.ts", [
    # the handler needs the recovery sources of the step
    ("async function recoveryFor(", "export async function recoveryFor("),
    ("import { dropBase, normalizeBody,",
     "import { probeFetch, probeFetchFailed, probeInit, probeStep, probeToolCheck, probeTurnComplete, probeUnprefixed } from './probe.ts'\nimport { dropBase, normalizeBody,"),
    ("  const state: LoopState = { usage: new Map(), threads: new Map() }\n",
     "  const state: LoopState = { usage: new Map(), threads: new Map() }\n"
     "  probeInit(options)\n"
     "  on('tool.check', async ($, e, next) => probeToolCheck($, e, next))\n"),
    ("on('http.fetch', async (_$, e, next) => shadowFetch(e, next, shadowOptions) as any).catch((_$, e, next) => shadowFetchFailed(e, next, shadowOptions) as any)",
     "on('http.fetch', async ($, e, next) => probeFetch($, e, next) as any).catch(($, e, next) => probeFetchFailed($, e, next) as any)"),
    ("      onUnprefixedStep(state, e.agentId)\n",
     "      onUnprefixedStep(state, e.agentId)\n      await probeUnprefixed($, e)\n"),
    ("const result = yield* routedStep(e, next, model.route, cfg, io, state.threads)",
     "const result = yield* probeStep($, e, next, model.route, cfg, io, state.threads)"),
    ("    const result = await next(e)\n    if (e.agentId) {",
     "    const result = await next(e)\n    await probeTurnComplete($, e)\n    if (e.agentId) {"),
])

# the opt-out the plan proposes, so a reload probe can flip it
p = f"{out}/.claude-plugin/plugin.json"
m = json.load(open(p))
m["userConfig"]["autoModeClassifier"] = {"type": "boolean", "title": "Auto mode classifier", "description": "Probe copy only.", "default": True}
json.dump(m, open(p, "w"), indent=2)
PY

echo "probe mod generated in $OUT"
