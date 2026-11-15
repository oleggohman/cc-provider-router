#!/usr/bin/env bash
# Generates a throwaway mod whose `turn.step` hook sits above the router and
# stops reading the stream beneath after two chunks (env ABANDON_MODE:
# `break` leaves the loop, which calls `.return()` on the stream; `hang`
# keeps the stream open and never reads again; unset: passes everything on).
# Used by the abandonment probe: what does the router's hook observe?
#
# usage: scripts/probes/make-abandoner.sh <out-dir>
set -euo pipefail
OUT="${1:?usage: make-abandoner.sh <out-dir>}"
rm -rf "$OUT"
mkdir -p "$OUT/.claude-plugin" "$OUT/hooks"
cat > "$OUT/.claude-plugin/plugin.json" <<'JSON'
{ "name": "step-abandoner", "version": "0.0.1", "description": "Probe-only: a turn.step hook that stops reading the stream beneath.", "license": "MIT", "author": { "name": "cc-provider-router contributors" } }
JSON
echo '{ "modules": ["./register.ts"] }' > "$OUT/hooks/hooks.json"
cat > "$OUT/hooks/register.ts" <<'TS'
import type { Register } from 'claude-code'

async function mode($: any): Promise<string> {
  return (await $.env.get('ABANDON_MODE')) || 'pass'
}

export const register: Register = on => {
  on('turn.step', async function* ($, e, next) {
    const m = await mode($)
    if (m === 'pass') return yield* next(e)
    let n = 0
    for await (const chunk of next(e)) {
      yield chunk
      if (++n < 2) continue
      if (m === 'hang') await new Promise(() => undefined)
      break
    }
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: e.model }
    yield { kind: 'text', index: 0, text: 'ABANDONED' }
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: e.turnId, index: e.index, answer: 'ABANDONED', toolUses: [], stopReason: 'end_turn', usage } as any
  })
}
TS
echo "abandoner mod generated in $OUT"
