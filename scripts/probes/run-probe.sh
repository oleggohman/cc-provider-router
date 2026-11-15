#!/usr/bin/env bash
# Runs one headless probe: `claude -p` in its own temp directory, with the
# probe mod, the fetch observer and the mock provider's endpoint.
#
# usage: PROBE_ROOT=<temp dir> scripts/probes/run-probe.sh <run-name> [extra claude args...]
#
# Needs: the probe mod in $PROBE_ROOT/probe (make-probe.sh) and
# mock-provider.py listening on $MOCK_PORT (default 8765).
#
# Environment:
#   PROBE_ROOT   temp directory that owns every file of the run (required)
#   MOCK_PORT    port of mock-provider.py (default 8765)
#   MODE         permission mode (default auto); never a bypass mode
#   MODEL        session model (default custom:mock:m, the routed mock)
#   PROMPT       the prompt (default "scenario=agent go")
#   PROMPT2      a second prompt, sent in the same process after the first
#   PROMPT3      a third one (stream-json input; the turns run in order)
#   OBSERVER     after | before | none: where the observer's --plugin-dir
#                goes relative to the router's (default after)
#   ABOVE        an extra plugin directory loaded above the router (first)
#   PLUGIN       plugin directory to load as the router (default $PROBE_ROOT/probe)
#   OPTIONS      extra JSON members for the router's plugin options,
#                e.g. '"autoModeClassifier":false'
#   LIMIT        seconds before the run is killed (default 150)
#   PROBE_*      knobs of the probe mod, see README.md
#
# Output in $PROBE_ROOT/runs/<run-name>/: out.jsonl (stream-json), err.txt,
# debug.log, probe.jsonl (the probe mod's record), observer.jsonl.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${PROBE_ROOT:?set PROBE_ROOT to a temp directory}"
NAME="${1:?usage: run-probe.sh <run-name> [extra claude args...]}"
shift
MODE="${MODE:-auto}"
case "$MODE" in bypassPermissions|dontAsk) echo "refusing permission mode $MODE" >&2; exit 2 ;; esac
PORT="${MOCK_PORT:-8765}"
PLUGIN="${PLUGIN:-$PROBE_ROOT/probe}"
RUN="$PROBE_ROOT/runs/$NAME"
rm -rf "$RUN"
mkdir -p "$RUN/cwd"

cat > "$RUN/settings.json" <<JSON
{"pluginConfigs":{
  "provider-router@inline":{"options":{"customEndpoints":["mock=http://127.0.0.1:$PORT/v1"]${OPTIONS:+,$OPTIONS}}},
  "fetch-observer@inline":{"options":{"logFile":"$RUN/observer.jsonl"}}}}
JSON

case "${OBSERVER:-after}" in
  after) DIRS=(--plugin-dir "$PLUGIN" --plugin-dir "$ROOT/tests/observer-plugin") ;;
  before) DIRS=(--plugin-dir "$ROOT/tests/observer-plugin" --plugin-dir "$PLUGIN") ;;
  none) DIRS=(--plugin-dir "$PLUGIN") ;;
  *) echo "OBSERVER must be after, before or none" >&2; exit 2 ;;
esac

[ -n "${ABOVE:-}" ] && DIRS=(--plugin-dir "$ABOVE" "${DIRS[@]}")

export PROBE_LOG="$RUN/probe.jsonl"
cd "$RUN/cwd"
ARGS=("${DIRS[@]}" --settings "$RUN/settings.json" --permission-mode "$MODE" --model "${MODEL:-custom:mock:m}"
  --output-format stream-json --verbose --debug-file "$RUN/debug.log" "$@")
set +e
if [ -n "${PROMPT2:-}" ]; then
  for p in "${PROMPT:-scenario=agent go}" "$PROMPT2" ${PROMPT3:+"$PROMPT3"}; do
    jq -cn --arg t "$p" '{type:"user",message:{role:"user",content:$t}}'
  done > "$RUN/input.jsonl"
  timeout "${LIMIT:-150}" claude -p "${ARGS[@]}" --input-format stream-json < "$RUN/input.jsonl" > "$RUN/out.jsonl" 2> "$RUN/err.txt"
else
  timeout "${LIMIT:-150}" claude -p "${ARGS[@]}" "${PROMPT:-scenario=agent go}" > "$RUN/out.jsonl" 2> "$RUN/err.txt"
fi
echo "exit $? -> $RUN"
