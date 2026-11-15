// Timeout and cancel for a provider call. `$.http.fetch` has no timeout and
// no abort signal, so the call is raced against `$.clock.sleep(timeout)`.
// The sleep takes the mod's own AbortController, linked to the dispatch's
// `next.signal`: when the reply wins the controller stops the timer; when
// the person presses Esc the step ends at once (raced on its own, not only
// through the timer).
// A provider call already sent cannot be cancelled (its cost still accrues);
// its late answer or failure is ignored.
//
// Verified live (docs/design-notes.md): a `$.clock.sleep` racing an in-flight
// `$.http.fetch` does not use up the hook's 10 s budget (25 s fetch won over
// a 60 s timer; a 15 s timer won over a 25 s fetch).

import type { Reply } from './chunks.ts'
import type { ErrorReply } from './errors.ts'

export const DEFAULT_TIMEOUT_MS = 600_000

// What an adapter sends through `$.http.fetch` and gets back.
export type FetchInit = { method: string; headers: Record<string, string>; body: string }
export type FetchResponse = { status: number; ok: boolean; text: string }
export type Fetch = (url: string, init: FetchInit) => Promise<FetchResponse>

// An adapter's answer: the provider's reply, or the error reply to show.
export type AdapterResult = { ok: true; reply: Reply } | { ok: false; error: ErrorReply }

export type Sleep = (ms: number, options?: { signal?: AbortSignal }) => Promise<void>

export type Outcome<T> = { kind: 'done'; value: T } | { kind: 'timeout'; ms: number } | { kind: 'cancelled' } | { kind: 'failed'; error: unknown }

export async function raceCall<T>(sleep: Sleep, signal: AbortSignal, work: () => Promise<T>, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<Outcome<T>> {
  if (signal.aborted) return { kind: 'cancelled' }
  const timer = new AbortController()
  // Esc ends the race on its own, whatever the timer does (a timer that
  // failed earlier leaves only the call, which may hang).
  let onEsc: () => void = () => undefined
  const esc = new Promise<Outcome<T>>(resolve => {
    onEsc = () => resolve({ kind: 'cancelled' })
  })
  const onAbort = () => {
    timer.abort()
    onEsc()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    // All three promises settle to an outcome (esc only on Esc), so a loser
    // never rejects unhandled.
    const call: Promise<Outcome<T>> = Promise.resolve()
      .then(work)
      .then(
        value => ({ kind: 'done', value }) as const,
        error => ({ kind: 'failed', error }) as const,
      )
    const wait: Promise<Outcome<T>> = sleep(timeoutMs, { signal: timer.signal }).then(
      () => ({ kind: 'timeout', ms: timeoutMs }) as const,
      // A timer that failed without Esc leaves the call to decide.
      () => (signal.aborted ? ({ kind: 'cancelled' } as const) : call),
    )
    const first = await Promise.race([call, wait, esc])
    // Esc wins over a reply that arrived in the same moment.
    return signal.aborted ? { kind: 'cancelled' } : first
  } finally {
    signal.removeEventListener('abort', onAbort)
    timer.abort()
  }
}
