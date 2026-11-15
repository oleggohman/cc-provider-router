#!/usr/bin/env bash
# Runs one interactive probe through drive-pty.py, with the same plugins,
# settings and output files as run-probe.sh.
#
# usage: PROBE_ROOT=<temp dir> scripts/probes/run-pty.sh <run-name> <seconds> <step>...
#
# Steps are drive-pty.py steps; the trust dialog is answered for you at
# seconds 8 and 9, so the first prompt belongs at second 20 or later.
# Environment: as run-probe.sh (PROBE_ROOT, MOCK_PORT, MODE, MODEL, OBSERVER,
# PLUGIN, OPTIONS, PROBE_*). Output in $PROBE_ROOT/runs/<run-name>/:
# screen.raw (read it with `drive-pty.py show`), debug.log, probe.jsonl,
# observer.jsonl, settings.json (edit it mid-run to probe a reload).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
: "${PROBE_ROOT:?set PROBE_ROOT to a temp directory}"
NAME="${1:?usage: run-pty.sh <run-name> <seconds> <step>...}"
SECONDS_TOTAL="${2:?usage: run-pty.sh <run-name> <seconds> <step>...}"
shift 2
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

export PROBE_LOG="$RUN/probe.jsonl"
python3 "$HERE/drive-pty.py" run "$RUN/cwd" "$RUN/screen.raw" "$SECONDS_TOTAL" 8:down 9:enter "$@" -- \
  "${DIRS[@]}" --settings "$RUN/settings.json" --permission-mode "$MODE" \
  --model "${MODEL:-custom:mock:m}" --debug-file "$RUN/debug.log"
echo "done -> $RUN"
