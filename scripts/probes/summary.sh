#!/usr/bin/env bash
# Prints what one probe run recorded.
# usage: scripts/probes/summary.sh <run-dir> [all]
#   <run-dir>  $PROBE_ROOT/runs/<name> (run-probe.sh) or a drive-pty.py directory
#   all        also list every chunk the step hook read
set -euo pipefail
R="${1:?usage: summary.sh <run-dir> [all]}"
if [ -s "$R/out.jsonl" ]; then
  echo "== result"
  jq -c 'select(.type=="result") | {result: (.result|tostring|.[0:300]), is_error, stop_reason, denials: (.permission_denials|map(.tool_name)), usage: (.modelUsage|map_values({inputTokens,outputTokens,costUSD}))}' "$R/out.jsonl"
  echo "== tool results"
  jq -c 'select(.type=="user") | .message.content[]? | select(.type=="tool_result") | (.content|tostring|.[0:260])' "$R/out.jsonl"
fi
if [ -s "$R/probe.jsonl" ]; then
  echo "== probe mod record"
  jq -c --arg all "${2:-}" 'select($all=="all" or .ev!="chunk")
    | {t: (.t%1000000), load, ev, seq, key, job: (.job|if type=="object" then "\(.id)/\(.phase)" else . end), phase, decision, model, fails: (.predicateFails|if . then join(",") else null end),
       thread: (.thread|if . then "\(.type) \(.previous_message_id//"")" else null end), how, kind, stopReason, tool, ms, status, aborted, messageId, recorded, match,
       result: (.result|if . then tostring|.[0:330] else null end), err, error, called, n, text, name, json}
    | with_entries(select(.value!=null))' "$R/probe.jsonl" | cut -c1-560
fi
if [ -s "$R/observer.jsonl" ]; then
  echo "== observer (what left the router)"
  jq -r '[.origin.plugin, .method, .url, (.model//"-"), ((.bodyKeys//[])|join(","))] | @tsv' "$R/observer.jsonl" | sort | uniq -c
fi
if [ -s "$R/debug.log" ]; then
  echo "== debug log"
  grep -E "server-classifier|classifier_request|classifier unavailable|permission denied|hook_denied|temporarily unavailable|answered http.fetch|hook failed closed|no complete answer|lingering" "$R/debug.log" | cut -c1-330 | head -40 || true
fi
