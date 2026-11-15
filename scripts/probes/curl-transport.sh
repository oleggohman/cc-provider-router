#!/usr/bin/env bash
# Probe for the curl transport (plan Task 7): can the `http.fetch` hook hold a
# provider call through `$.process.spawn(["curl", "--disable", "--config", "-"])`
# with the config on stdin, and is the child killed when the stream is ended?
#
# usage: PROBE_ROOT=<temp dir> scripts/probes/curl-transport.sh [case...]
#   cases (default: all, in this order):
#     hold60    a 60 s wait on the mock's /slow, then the provider reply
#     hold300   the same for 300 s
#     return    return() on the stream 20 s into a 60 s wait (a pull pending)
#     esc       interactive, Esc 15 s into a 60 s wait (next.signal aborts)
#
# Needs: the probe mod in $PROBE_ROOT/probe (make-probe.sh) and
# mock-provider.py listening on $MOCK_PORT (default 8765), logging to
# $PROBE_ROOT/mock.jsonl. Permission mode `default`, the custom mock route
# only: no key, no subscription request beyond what the engine sends itself.
# Each case uses its own wait length and tag, so cases may run side by side.
#
# What to read afterwards: `slow_end` lines in mock.jsonl (`dropped: true`
# means the child's connection closed during the wait) and the `hold-spawn-*`
# lines of $PROBE_ROOT/runs/curl-<case>/probe.jsonl.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
: "${PROBE_ROOT:?set PROBE_ROOT to a temp directory}"
PORT="${MOCK_PORT:-8765}"
SLOW="http://127.0.0.1:$PORT/v1/slow"
export MODE=default
CASES=("$@")
[ ${#CASES[@]} -eq 0 ] && CASES=(hold60 hold300 return esc)

for c in "${CASES[@]}"; do
  case "$c" in
    hold60)
      PROBE_HOLD_SPAWN_URL="$SLOW?s=60&tag=hold60" LIMIT=200 PROMPT="scenario=text go" \
        "$HERE/run-probe.sh" curl-hold60 ;;
    hold300)
      PROBE_HOLD_SPAWN_URL="$SLOW?s=300&tag=hold300" LIMIT=480 PROMPT="scenario=text go" \
        "$HERE/run-probe.sh" curl-hold300 ;;
    return)
      PROBE_HOLD_SPAWN_URL="$SLOW?s=60&tag=return" PROBE_SPAWN_RETURN_MS=20000 LIMIT=200 PROMPT="scenario=text go" \
        "$HERE/run-probe.sh" curl-return ;;
    esc)
      PROBE_HOLD_SPAWN_URL="$SLOW?s=60&tag=esc" PROBE_ESC=stub PROBE_ERR_STOP=hookmade \
        "$HERE/run-pty.sh" curl-esc 110 '22:text:scenario=text go' 23:enter 38:esc 39:esc \
        '75:text:i' '76:text:scenario=text again' 77:enter ;;
    *) echo "unknown case $c" >&2; exit 2 ;;
  esac
  R="$PROBE_ROOT/runs/curl-$c"
  echo "== $c: probe record"
  jq -c 'select(.ev|tostring|test("^hold-spawn|signal-abort|answer-outcome|fetch-catch")) | del(.load)' "$R/probe.jsonl" 2>/dev/null | cut -c1-400 || true
  echo "== $c: mock"
  jq -c --arg tag "$c" 'select(.tag==$tag)' "$PROBE_ROOT/mock.jsonl" 2>/dev/null || true
  if [ -s "$R/out.jsonl" ]; then
    jq -c 'select(.type=="result") | {result: (.result|tostring|.[0:200]), is_error}' "$R/out.jsonl"
  fi
done
