import { describe, expect, test } from 'claude-code/testing'
import { DEFAULT_TIMEOUT_MS, raceCall } from './call.ts'

// A stand-in for `$.clock.sleep`: rejects at once when its signal aborts (as
// the real one does), resolves when the test calls `fire()`.
function fakeSleep() {
  const calls: { ms: number; signal?: AbortSignal; settled: boolean }[] = []
  let fireFn: (() => void) | undefined
  const sleep = (ms: number, opts?: { signal?: AbortSignal }) =>
    new Promise<void>((resolve, reject) => {
      const c = { ms, signal: opts?.signal, settled: false }
      calls.push(c)
      fireFn = () => {
        c.settled = true
        resolve()
      }
      if (opts?.signal?.aborted) {
        c.settled = true
        reject(new Error('aborted'))
        return
      }
      opts?.signal?.addEventListener('abort', () => {
        c.settled = true
        reject(new Error('aborted'))
      })
    })
  return { sleep, calls, fire: () => fireFn?.() }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function tick() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('raceCall', () => {
  test('success: the reply wins and the timer is aborted (no leftover sleep)', async () => {
    const s = fakeSleep()
    const parent = new AbortController()
    const out = await raceCall(s.sleep, parent.signal, async () => 'reply', 1000)
    expect(out).toEqual({ kind: 'done', value: 'reply' })
    await tick()
    expect(s.calls.length).toBe(1)
    expect(s.calls[0]!.ms).toBe(1000)
    expect(s.calls[0]!.signal?.aborted).toBe(true)
    expect(s.calls[0]!.settled).toBe(true)
    // The mod's own controller, never the dispatch's signal itself.
    expect(s.calls[0]!.signal).not.toBe(parent.signal)
    expect(parent.signal.aborted).toBe(false)
  })

  test('timeout: the timer wins and the outcome says so', async () => {
    const s = fakeSleep()
    const work = deferred<string>()
    const p = raceCall(s.sleep, new AbortController().signal, () => work.promise, 50)
    await tick()
    s.fire()
    expect(await p).toEqual({ kind: 'timeout', ms: 50 })
    // A reply arriving later is ignored, without an unhandled rejection.
    work.reject(new Error('late failure'))
    await tick()
  })

  test('Esc before the reply: cancelled, the timer stopped, a late reply ignored', async () => {
    const s = fakeSleep()
    const parent = new AbortController()
    const work = deferred<string>()
    const p = raceCall(s.sleep, parent.signal, () => work.promise, 1000)
    await tick()
    parent.abort()
    expect(await p).toEqual({ kind: 'cancelled' })
    expect(s.calls[0]!.settled).toBe(true)
    work.resolve('too late')
    await tick()
  })

  test('Esc before the call starts: the work is never started', async () => {
    const s = fakeSleep()
    const parent = new AbortController()
    parent.abort()
    let started = false
    const out = await raceCall(
      s.sleep,
      parent.signal,
      async () => {
        started = true
        return 1
      },
      1000,
    )
    expect(out).toEqual({ kind: 'cancelled' })
    expect(started).toBe(false)
    expect(s.calls.length).toBe(0)
  })

  test('the work failing is an outcome, not a throw', async () => {
    const s = fakeSleep()
    const out = await raceCall(
      s.sleep,
      new AbortController().signal,
      async () => {
        throw new Error('connect ECONNREFUSED')
      },
      1000,
    )
    expect(out.kind).toBe('failed')
    expect(String((out as any).error)).toContain('ECONNREFUSED')
    await tick()
    expect(s.calls[0]!.signal?.aborted).toBe(true)
  })

  test('the work throwing synchronously is caught too', async () => {
    const s = fakeSleep()
    const out = await raceCall(
      s.sleep,
      new AbortController().signal,
      () => {
        throw new Error('sync boom')
      },
      1000,
    )
    expect(out.kind).toBe('failed')
  })

  test('a default timeout exists and is generous for non-streamed replies', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000)
  })
})
