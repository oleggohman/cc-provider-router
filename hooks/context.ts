// Context windows and compaction for routed models.
//
// The engine assumes a 1M window for an unknown model id, and a routed
// step's `stop.usage` does not feed `$.session.usage()` (docs/design-notes.md),
// so the engine would not compact in time. The mod keeps its own last
// input-token count per loop and, at the end of a main-loop turn whose last
// routed step passed 85% of the model's known window, schedules
// `$.session.compact()` with `$.clock.after`: never synchronously inside the
// `turn.complete` hook (compact rejects while a turn runs) and never during
// `turn.step`. Subagents do not compact from here: the agent definition's
// `autoCompactWindow` is the knob (README), plus a clear message when a
// provider says the context is too long.

import { num } from './chunks.ts'
import type { ErrorReply } from './errors.ts'
import { windowFor } from './limits.ts'
import { loopKeyOf } from './shadow.ts'

export const COMPACT_AT = 0.85

// Last routed input size per loop key: what the next request starts from.
export type LoopUsage = { model: string; inputTokens: number }
export type UsageMap = Map<string, LoopUsage>

// A usage count, negatives as 0.
function positive(v: unknown): number {
  return Math.max(0, num(v))
}

function inputTokensOf(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0
  const u = usage as Record<string, unknown>
  return positive(u.input_tokens) + positive(u.cache_read_input_tokens) + positive(u.cache_creation_input_tokens)
}

// Records a routed step's input size for its loop. A step without an input
// count (an error reply reports zero, a cancelled one none) keeps the
// previous record, so a failure after a large step still leads to compaction.
export function recordUsage(map: UsageMap, key: string, model: string, usage: unknown): void {
  const inputTokens = inputTokensOf(usage)
  if (inputTokens > 0) map.set(key, { model, inputTokens })
}

export type CompactDeps = {
  after: (ms: number, fn: () => void) => unknown
  compact: () => Promise<unknown>
}

// Called from `turn.complete` of the main loop after `next(e)` returned.
// Returns whether a compaction was scheduled. The main loop's record is
// cleared once acted on, so a skipped (`{ skip }`) or failed compaction is not
// retried for the same usage; the next routed step records afresh.
export function maybeCompact(map: UsageMap, windows: ReadonlyMap<string, number>, deps: CompactDeps): boolean {
  const main = loopKeyOf(undefined)
  const rec = map.get(main)
  if (!rec) return false
  const window = windowFor(rec.model, windows)
  if (!window || rec.inputTokens < window * COMPACT_AT) return false
  map.delete(main)
  const run = async () => {
    try {
      // A `{ skip }` answer is a veto: accepted as is.
      await deps.compact()
    } catch {
      // Rejects while a turn runs; throws in `-p` ("no session is bound").
    }
  }
  try {
    deps.after(0, () => void run())
    return true
  } catch {
    return false
  }
}

const MAIN_HINT = "the conversation no longer fits this model's context window: run /compact, then retry"
const AGENT_HINT = "the task was too large for this model's context window: split it into smaller tasks, or set autoCompactWindow in the agent definition"

// A context-length error reply with what to do about it, per loop type.
export function withContextHint(err: ErrorReply, agentId: string | undefined): ErrorReply {
  if (err.stopReason !== 'model_context_window_exceeded') return err
  return { ...err, text: `${err.text}\n${agentId ? AGENT_HINT : MAIN_HINT}` }
}
