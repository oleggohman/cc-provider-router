#!/usr/bin/env bash
# Live smoke tests for provider-router. These call real providers and cost
# real (small) money; each case runs only when its provider is configured.
#
# Keys are read from the plugin's own env names only:
#   ROUTER_ANTHROPIC_API_KEY  -> anthropic:<id>
#   ZAI_API_KEY               -> zai:<id>
#   OPENAI_API_KEY            -> openai:<id>
#   SMOKE_CUSTOM_URL          -> custom:<name>:<id> (OpenAI-compatible base URL,
#                                e.g. http://host:4000/v1); key, if any, via
#                                ROUTER_CUSTOM_API_KEYS="<name>=<key>"
# Optional: SMOKE_ANTHROPIC_MODEL, SMOKE_ZAI_MODEL, SMOKE_OPENAI_MODEL,
#   SMOKE_CUSTOM_NAME (default smoke), SMOKE_CUSTOM_MODEL (required with the URL),
#   SMOKE_MAIN_MODEL (main-on-subscription model for subagent cases; default:
#   your default model), SMOKE_CASES (space-separated subset of: main sub
#   parallel background; default all), SMOKE_ONLY (space-separated provider
#   labels to run, e.g. "zai custom"), SMOKE_KEEP=1 keeps the output dir.
#
# Every case asserts: the reply carries the marker, the marker came from a
# real Bash tool run, routed steps were answered by the routed model, and the
# zero-leak rules: /providers shows shadowLeaks 0, usage lists no model other
# than the session's own plus a zero-cost shadow entry, and the transcript has
# no shadow-model or stub entries. Never prints key values.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
command -v claude >/dev/null || { echo "claude not found"; exit 2; }
command -v jq >/dev/null || { echo "jq not found"; exit 2; }

SHADOW=provider-router-shadow
ANTHROPIC_MODEL="${SMOKE_ANTHROPIC_MODEL:-claude-haiku-5-5}"
ZAI_MODEL="${SMOKE_ZAI_MODEL:-glm-5.3}"
OPENAI_MODEL="${SMOKE_OPENAI_MODEL:-gpt-5-mini}"
CUSTOM_NAME="${SMOKE_CUSTOM_NAME:-smoke}"
CUSTOM_URL="${SMOKE_CUSTOM_URL:-}"
CUSTOM_MODEL="${SMOKE_CUSTOM_MODEL:-}"
CASES="${SMOKE_CASES:-main sub parallel background}"
TIMEOUT="${SMOKE_TIMEOUT:-600}"

OUT="$(mktemp -d "${TMPDIR:-/tmp}/provider-router-smoke.XXXXXX")"
[ -n "${SMOKE_KEEP:-}" ] || trap 'rm -rf "$OUT"' EXIT

PASS=0 FAIL=0 SKIP=0
pass() { PASS=$((PASS + 1)); echo "PASS  $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL  $1: $2"; }
skip() { SKIP=$((SKIP + 1)); echo "SKIP  $1: $2"; }

# Configured providers as "label model-id" pairs (model ids prefixed).
PROVIDERS=()
[ -n "${ROUTER_ANTHROPIC_API_KEY:-}" ] && PROVIDERS+=("anthropic anthropic:$ANTHROPIC_MODEL") || skip anthropic "ROUTER_ANTHROPIC_API_KEY not set"
[ -n "${ZAI_API_KEY:-}" ] && PROVIDERS+=("zai zai:$ZAI_MODEL") || skip zai "ZAI_API_KEY not set"
[ -n "${OPENAI_API_KEY:-}" ] && PROVIDERS+=("openai openai:$OPENAI_MODEL") || skip openai "OPENAI_API_KEY not set"
if [ -n "$CUSTOM_URL" ] && [ -n "$CUSTOM_MODEL" ]; then
  PROVIDERS+=("custom custom:$CUSTOM_NAME:$CUSTOM_MODEL")
else
  skip custom "SMOKE_CUSTOM_URL / SMOKE_CUSTOM_MODEL not set"
fi
# SMOKE_ONLY="zai custom" restricts the run to those providers.
if [ -n "${SMOKE_ONLY:-}" ]; then
  kept=()
  for p in ${PROVIDERS[@]+"${PROVIDERS[@]}"}; do
    case " $SMOKE_ONLY " in *" ${p%% *} "*) kept+=("$p") ;; *) skip "${p%% *}" "not in SMOKE_ONLY" ;; esac
  done
  PROVIDERS=(${kept[@]+"${kept[@]}"})
fi
[ ${#PROVIDERS[@]} -gt 0 ] || { echo "no provider configured; nothing to test"; exit 0; }

# Plugin options for a --plugin-dir run (`name@inline` in pluginConfigs).
SETTINGS="$OUT/settings.json"
if [ -n "$CUSTOM_URL" ]; then
  jq -n --arg e "$CUSTOM_NAME=$CUSTOM_URL" '{pluginConfigs: {"provider-router@inline": {options: {customEndpoints: [$e]}}}}' >"$SETTINGS"
else
  echo '{}' >"$SETTINGS"
fi

# One subagent definition per provider, from the example agents (body and
# tools), with the model under test and Bash only.
AGENTS="$OUT/agents.json"
example_body() { awk 'BEGIN{n=0} /^---$/{n++; next} n>=2{print}' "$1"; }
BODY="$(example_body examples/agents/glm-worker.md)"
{
  echo '{}'
  for p in "${PROVIDERS[@]}"; do
    set -- $p
    file=examples/agents/glm-worker.md
    [ "$1" = anthropic ] && file=examples/agents/platform-opus.md
    [ "$1" = openai ] && file=examples/agents/gpt-worker.md
    jq -n --arg n "smoke-$1" --arg m "$2" --arg b "$(example_body "$file")" \
      '{($n): {description: ("Smoke test worker on " + $m + ". Use only when asked for " + $n + "."), prompt: $b, model: $m, tools: ["Bash"]}}'
  done
} | jq -s 'add' >"$AGENTS"
[ -n "$BODY" ] || { echo "examples/agents/glm-worker.md has no body"; exit 2; }

# All markers of a case appear in the session's results so far.
markers_seen() {
  local f="$1" m; shift
  for m in "$@"; do grep '"type":"result"' "$f" 2>/dev/null | grep -q "$m" || return 1; done
}

# run <name> <prompt> <markers, space-separated> [claude args...]: one
# session. /providers is sent only once every marker has reached a reply (a
# background subagent's result arrives as a later turn), so the counters are
# read after all routed work; then stdin closes and the session ends.
run() {
  local name="$1" prompt="$2" markers="$3"; shift 3
  : >"$OUT/$name.raw"
  {
    jq -nc --arg c "$prompt" '{type: "user", message: {role: "user", content: $c}}'
    local i=0
    while [ "$i" -lt "$TIMEOUT" ] && ! markers_seen "$OUT/$name.raw" $markers; do sleep 2; i=$((i + 2)); done
    jq -nc '{type: "user", message: {role: "user", content: "/providers"}}'
    i=0
    while [ "$i" -lt 120 ] && ! grep -q 'shadowLeaks' "$OUT/$name.raw"; do sleep 2; i=$((i + 2)); done
  } | timeout "$TIMEOUT" claude -p --plugin-dir "$ROOT" --settings "$SETTINGS" --agents "$AGENTS" \
    --input-format stream-json --output-format stream-json --verbose \
    --allowedTools Bash,Agent "$@" >"$OUT/$name.raw" 2>"$OUT/$name.err"
  grep '^{' "$OUT/$name.raw" >"$OUT/$name.jsonl" || true
}

# check <name> <routed model ids, space-separated> <main is routed: 0|1> <markers...>
check() {
  local name="$1" routed="$2" mainRouted="$3"; shift 3
  local f="$OUT/$name.jsonl" err="" m r
  [ -s "$f" ] || { fail "$name" "no output (see stderr: $(head -c 300 "$OUT/$name.err" | tr '\n' ' '))"; return; }
  local reply; reply="$(jq -r 'select(.type=="result") | .result' "$f")"
  local results; results="$(jq -r 'select(.type=="user") | .message.content[]? | select(.type=="tool_result") | (.content | if type=="string" then . else (map(.text? // "") | join(" ")) end)' "$f")"
  for m in "$@"; do
    case "$reply" in *"$m"*) ;; *) err="$err reply lacks $m;" ;; esac
    case "$results" in *"$m"*) ;; *) err="$err no tool result with $m;" ;; esac
  done
  for r in $routed; do
    if [ "$mainRouted" = 1 ]; then
      jq -e --arg r "$r" 'select(.type=="assistant" and .parent_tool_use_id==null and .message.model==$r)' "$f" >/dev/null || err="$err main not answered by $r;"
    else
      jq -e --arg r "$r" 'select(.type=="assistant" and .parent_tool_use_id!=null and .message.model==$r)' "$f" >/dev/null || err="$err no subagent step answered by $r;"
    fi
  done
  # Zero leak: counters, usage, transcript.
  jq -r 'select(.type=="result") | .result' "$f" | grep -q 'shadowLeaks 0,' || err="$err shadowLeaks not 0 (or /providers missing);"
  local mainModel; mainModel="$(jq -r 'select(.type=="system" and .subtype=="init") | .model' "$f" | head -1)"
  local bad; bad="$(jq -r --arg main "$mainModel" --arg sh "$SHADOW" 'select(.type=="result") | .modelUsage // {} | to_entries[]
      | select(.key != $main and (.key != $sh or (.value.inputTokens + .value.outputTokens + .value.cacheReadInputTokens + .value.cacheCreationInputTokens) > 0 or .value.costUSD > 0)) | .key' "$f" | sort -u | tr '\n' ' ')"
  [ -z "$bad" ] || err="$err unexpected usage entries: $bad;"
  local sid; sid="$(jq -r 'select(.type=="result") | .session_id' "$f" | head -1)"
  local tr; tr="$(ls "$HOME"/.claude/projects/*/"$sid".jsonl 2>/dev/null | head -1)"
  if [ -n "$tr" ]; then
    local dirty; dirty="$(cat "$tr" "$(dirname "$tr")/$sid"/subagents/*.jsonl 2>/dev/null \
      | jq -r --arg sh "$SHADOW" 'select(.type=="assistant" and .message.model==$sh) | "shadow-model assistant entry"' | head -1)"
    [ -z "$dirty" ] || err="$err transcript: $dirty;"
    grep -q 'shadow request refused locally' "$tr" && err="$err transcript has a refused-shadow error;"
  else
    err="$err transcript for session not found;"
  fi
  if [ -z "$err" ]; then pass "$name"; else fail "$name" "$err"; fi
}

MAINARGS=()
[ -n "${SMOKE_MAIN_MODEL:-}" ] && MAINARGS=(--model "$SMOKE_MAIN_MODEL")

for c in $CASES; do
  case "$c" in
    main)
      # Main loop routed, one tool round trip.
      for p in "${PROVIDERS[@]}"; do
        set -- $p
        mk="SMOKE_MAIN_$(echo "$1" | tr a-z A-Z)"
        run "main-$1" "Use the Bash tool to run \`echo $mk\` and reply with only its output." "$mk" --model "$2"
        check "main-$1" "$2" 1 "$mk"
      done
      ;;
    sub)
      # Main on the subscription, one routed subagent per provider.
      for p in "${PROVIDERS[@]}"; do
        set -- $p
        mk="SMOKE_SUB_$(echo "$1" | tr a-z A-Z)"
        run "sub-$1" "Use the Agent tool with subagent_type smoke-$1 and the task: run \`echo $mk\` with Bash and return its output. Then reply with only the output the agent returned." "$mk" ${MAINARGS[@]+"${MAINARGS[@]}"}
        check "sub-$1" "$2" 0 "$mk"
      done
      ;;
    parallel)
      # Two routed subagents at once (two providers, or two instances of one).
      set -- ${PROVIDERS[0]}; a1="$1" m1="$2"
      if [ ${#PROVIDERS[@]} -gt 1 ]; then set -- ${PROVIDERS[1]}; fi
      a2="$1" m2="$2"
      run parallel "In ONE message, make two Agent tool calls in parallel: subagent_type smoke-$a1 with the task 'run \`echo SMOKE_PAR_ONE\` with Bash and return its output', and subagent_type smoke-$a2 with the task 'run \`echo SMOKE_PAR_TWO\` with Bash and return its output'. When both are done, reply with both outputs on one line." "SMOKE_PAR_ONE SMOKE_PAR_TWO" ${MAINARGS[@]+"${MAINARGS[@]}"}
      check parallel "$(printf '%s\n' "$m1" "$m2" | sort -u | tr '\n' ' ')" 0 SMOKE_PAR_ONE SMOKE_PAR_TWO
      ;;
    background)
      # Main keeps working on the subscription while a routed subagent runs.
      set -- ${PROVIDERS[0]}
      run background "Start the Agent tool with subagent_type smoke-$1 and run_in_background true, task: 'run \`sleep 5; echo SMOKE_BG_SUB\` with Bash and return its output'. While it runs, use the Bash tool yourself to run \`echo SMOKE_BG_MAIN\`. Then wait for the agent's result and reply with both outputs on one line." "SMOKE_BG_SUB SMOKE_BG_MAIN" ${MAINARGS[@]+"${MAINARGS[@]}"}
      check background "$2" 0 SMOKE_BG_SUB SMOKE_BG_MAIN
      # Main's own Bash ran before the subagent finished (in parallel).
      f="$OUT/background.jsonl"
      mainAt="$(jq -s 'to_entries | map(select(.value.type=="assistant" and .value.parent_tool_use_id==null and ([.value.message.content[]? | select(.type=="tool_use" and .name=="Bash")] | length) > 0)) | .[0].key // -1' "$f")"
      subEnd="$(jq -s 'to_entries | map(select(.value.type=="assistant" and .value.parent_tool_use_id!=null)) | .[-1].key // -1' "$f")"
      if [ "$mainAt" -ge 0 ] && [ "$subEnd" -ge 0 ] && [ "$mainAt" -lt "$subEnd" ]; then pass "background-overlap"; else fail "background-overlap" "main Bash at event $mainAt, last subagent step at event $subEnd (no overlap seen)"; fi
      ;;
    *) echo "unknown case: $c"; exit 2 ;;
  esac
done

echo "smoke: $PASS passed, $FAIL failed, $SKIP skipped${SMOKE_KEEP:+ (output in $OUT)}"
[ "$FAIL" -eq 0 ]
