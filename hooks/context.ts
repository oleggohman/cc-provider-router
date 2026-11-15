// Context windows and compaction for routed models.
//
// The engine assumes a 1M window for an unknown model id, and a routed
// step's `stop.usage` does not feed `$.session.usage()` (spike/README.md),
// so the engine would not compact in time. The mod keeps its own last
// input-token count per loop and, at the end of a main-loop turn whose last
// routed step passed 85% of the model's known window, schedules
// `$.session.compact()` with `$.clock.after`: never synchronously inside the
// `turn.complete` hook (compact rejects while a turn runs) and never during
// `turn.step`. Subagents do not compact from here: the agent definition's
// `autoCompactWindow` is the knob (README), plus a clear message when a
// provider says the context is too long.

import type { ErrorReply } from './errors.ts'

export const COMPACT_AT = 0.85

const MAIN = 'main'

function loopOf(agentId: string | undefined): string {
  return agentId || MAIN
}

// The known context window of a prefixed model id, if any.
export function windowFor(model: string, windows: ReadonlyMap<string, number>): number | undefined {
  return windows.get(model)
}

export type LoopUsage = { model: string; inputTokens: number }

export type Tracker = {
  record(agentId: string | undefined, model: string, usage: unknown): void
  clear(agentId: string | undefined): void
  get(agentId: string | undefined): LoopUsage | undefined
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

// Last routed step's input size per loop: what the next request starts from.
export function createTracker(): Tracker {
  const loops = new Map<string, LoopUsage>()
  return {
    record(agentId, model, usage) {
      if (!usage || typeof usage !== 'object') return
      const u = usage as Record<string, unknown>
      const inputTokens = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens)
      loops.set(loopOf(agentId), { model, inputTokens })
    },
    clear(agentId) {
      loops.delete(loopOf(agentId))
    },
    get(agentId) {
      return loops.get(loopOf(agentId))
    },
  }
}

// Passes a routed step through and records its result's usage for its loop.
export async function* trackUsage<Y, R>(
  tracker: Tracker,
  e: { readonly model: string; readonly agentId?: string },
  inner: AsyncGenerator<Y, R, unknown>,
): AsyncGenerator<Y, R, unknown> {
  const result = yield* inner
  tracker.record(e.agentId, e.model, (result as { usage?: unknown } | undefined)?.usage)
  return result
}

export type CompactDeps = {
  after: (ms: number, fn: () => void) => unknown
  compact: () => Promise<unknown>
}

// Called from `turn.complete` after `next(e)` returned. Main loop only.
// Returns whether a compaction was scheduled. The loop's record is cleared
// once acted on, so a skipped (`{ skip }`) or failed compaction is not
// retried for the same usage; the next routed step records afresh.
export function maybeCompact(
  tracker: Tracker,
  windows: ReadonlyMap<string, number>,
  e: { readonly agentId?: string; readonly turnId?: string },
  deps: CompactDeps,
): boolean {
  if (e.agentId) {
    tracker.clear(e.agentId)
    return false
  }
  const rec = tracker.get(undefined)
  if (!rec) return false
  const window = windowFor(rec.model, windows)
  if (!window || rec.inputTokens < window * COMPACT_AT) return false
  tracker.clear(undefined)
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
