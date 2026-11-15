import { describe, expect, test } from 'claude-code/testing'
import { COMPACT_AT, maybeCompact, recordUsage, withContextHint, type UsageMap } from './context.ts'
import { errorChunks, localError, providerError } from './errors.ts'
import { routedStep } from './register.ts'
import { resetShadow } from './shadow.ts'
import { cfg, drain, engine, provider, sleeper, step, tick } from '../tests/harness.ts'


// Stand-ins for `$.clock.after` and `$.session.compact`: `after` only queues
// the callback; the test runs it, so "scheduled, not run" is observable.
function compactor(answer: () => Promise<any> = async () => ({ messages: [] })) {
  const queued: { ms: number; fn: () => void }[] = []
  let compacts = 0
  const deps = {
    after: (ms: number, fn: () => void) => {
      queued.push({ ms, fn })
      return { cancel: () => {} }
    },
    compact: async () => {
      compacts++
      return answer()
    },
  }
  return {
    deps,
    queued,
    get compacts() {
      return compacts
    },
    runQueued: async () => {
      for (const q of queued.splice(0)) q.fn()
      await tick()
    },
  }
}

const usage = (input: number, cacheRead = 0) => ({ input_tokens: input, output_tokens: 10, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 })

describe('compaction from turn.complete', () => {
  const windows = new Map<string, number>()
  const fresh = (): UsageMap => new Map()

  test('main loop over 85%: compact is scheduled with clock.after, not run synchronously', async () => {
    const t = fresh()
    const c = compactor()
    recordUsage(t, 'main', 'openai:gpt-5', usage(Math.ceil(400000 * COMPACT_AT)))
    expect(maybeCompact(t, windows, c.deps)).toBe(true)
    // Scheduled, not called inside the hook.
    expect(c.queued.length).toBe(1)
    expect(c.queued[0]!.ms).toBe(0)
    expect(c.compacts).toBe(0)
    await c.runQueued()
    expect(c.compacts).toBe(1)
  })

  test('cache reads count toward the input tokens', async () => {
    const t = fresh()
    recordUsage(t, 'main', 'openai:gpt-5', usage(1000, 350000))
    expect(maybeCompact(t, windows, compactor().deps)).toBe(true)
  })

  test('the built-in window matches by prefix (gpt-5.1 has one too)', async () => {
    const t = fresh()
    recordUsage(t, 'main', 'openai:gpt-5.1', usage(390000))
    expect(maybeCompact(t, windows, compactor().deps)).toBe(true)
  })

  test('under 85%: nothing scheduled', async () => {
    const t = fresh()
    const c = compactor()
    recordUsage(t, 'main', 'openai:gpt-5', usage(300000))
    expect(maybeCompact(t, windows, c.deps)).toBe(false)
    expect(c.queued.length).toBe(0)
  })

  test('unknown window: nothing scheduled', async () => {
    const t = fresh()
    recordUsage(t, 'main', 'openai:mystery', usage(900000))
    expect(maybeCompact(t, windows, compactor().deps)).toBe(false)
  })

  test('a subagent over 85% does not trigger compaction of the main loop', async () => {
    const t = fresh()
    recordUsage(t, 'agent-1', 'openai:gpt-5', usage(399000))
    expect(maybeCompact(t, windows, compactor().deps)).toBe(false)
  })

  test('an error step (zero usage) keeps the loop record: a large step then a failure still compacts', async () => {
    const t = fresh()
    recordUsage(t, 'main', 'openai:gpt-5', usage(390000))
    const err: any = await drain(errorChunks({ turnId: 't', index: 1, model: 'openai:gpt-5' }, localError('openai', 'rate limited')) as any)
    recordUsage(t, 'main', 'openai:gpt-5', err.result.usage)
    recordUsage(t, 'main', 'openai:gpt-5', null)
    expect(t.get('main')).toEqual({ model: 'openai:gpt-5', inputTokens: 390000 })
    expect(maybeCompact(t, windows, compactor().deps)).toBe(true)
  })

  test('{ skip } is respected: no retry, no throw', async () => {
    const t = fresh()
    const c = compactor(async () => ({ skip: 'vetoed by a hook' }))
    recordUsage(t, 'main', 'openai:gpt-5', usage(390000))
    maybeCompact(t, windows, c.deps)
    await c.runQueued()
    expect(c.compacts).toBe(1)
    // The same turn's usage is not acted on again.
    expect(maybeCompact(t, windows, c.deps)).toBe(false)
    await c.runQueued()
    expect(c.compacts).toBe(1)
  })

  test('compact that rejects (turn running, or -p "no session is bound") is caught', async () => {
    const t = fresh()
    const c = compactor(async () => {
      throw new Error('$.session.compact is not available in this mode: no session is bound in this process')
    })
    recordUsage(t, 'main', 'openai:gpt-5', usage(390000))
    maybeCompact(t, windows, c.deps)
    await c.runQueued()
    expect(c.compacts).toBe(1)
  })

  test('clock.after that throws is caught', async () => {
    const t = fresh()
    recordUsage(t, 'main', 'openai:gpt-5', usage(390000))
    const deps = {
      after: () => {
        throw new Error('refused')
      },
      compact: async () => ({ messages: [] }),
    }
    expect(maybeCompact(t, windows, deps as any)).toBe(false)
  })

  test('compact is never called during turn.step; usage is recorded from the routed result', async () => {
    resetShadow()
    const t = fresh()
    const c = compactor()
    const eng = engine()
    const reply = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 380000, completion_tokens: 5 } })
    const p = provider([{ status: 200, text: reply }])
    const io = { fetch: p.fetch, sleep: sleeper().sleep, signal: new AbortController().signal }
    const e = step('openai:gpt-5')
    const { result } = await drain(routedStep(e, eng.next, { provider: 'openai', model: 'gpt-5' }, cfg({ openai: 'k-openai-1' }), io, new Map()))
    recordUsage(t, 'main', e.model, result.usage)
    expect(result.answer).toBe('done')
    expect(c.compacts).toBe(0)
    expect(c.queued.length).toBe(0)
    expect(t.get('main')).toEqual({ model: 'openai:gpt-5', inputTokens: 380000 })
    expect(maybeCompact(t, windows, c.deps)).toBe(true)
    expect(c.compacts).toBe(0)
    await c.runQueued()
    expect(c.compacts).toBe(1)
  })
})

describe('context length exceeded', () => {
  test('main loop: the message says to run /compact', () => {
    const err = providerError('openai', 400, JSON.stringify({ error: { message: "This model's maximum context length is 128000 tokens" } }))
    expect(err.stopReason).toBe('model_context_window_exceeded')
    const r = withContextHint(err, undefined)
    expect(r.text).toContain('[provider-router] openai')
    expect(r.text).toContain('/compact')
    expect(r.stopReason).toBe('model_context_window_exceeded')
  })

  test('subagent: the message says the task was too large', () => {
    const err = providerError('zai', 400, JSON.stringify({ error: { message: 'prompt is too long' } }))
    const r = withContextHint(err, 'agent-7')
    expect(r.text).toContain('task was too large')
    expect(r.text).toContain('autoCompactWindow')
    expect(r.text).not.toContain('/compact')
  })

  test('other errors are left unchanged', () => {
    const err = localError('openai', 'no reply within 10 ms (timed out)')
    expect(withContextHint(err, undefined)).toEqual(err)
  })

  test('routed step: a context-length error carries the per-loop hint', async () => {
    resetShadow()
    const eng = engine()
    const p = provider([{ status: 400, text: JSON.stringify({ error: { message: 'context_length_exceeded' } }) }])
    const io = { fetch: p.fetch, sleep: sleeper().sleep, signal: new AbortController().signal }
    const main = await drain(routedStep(step('openai:gpt-5'), eng.next, { provider: 'openai', model: 'gpt-5' }, cfg({ openai: 'k1' }), io, new Map()))
    expect(main.result.stopReason).toBe('model_context_window_exceeded')
    expect(main.result.answer).toContain('/compact')
    const sub = await drain(routedStep(step('openai:gpt-5', { agentId: 'ag-1' }), eng.next, { provider: 'openai', model: 'gpt-5' }, cfg({ openai: 'k1' }), io, new Map()))
    expect(sub.result.answer).toContain('task was too large')
  })
})

describe('through the plugin', () => {
  test('turn.complete passes the result through and does not compact without routed usage', async ($, on) => {
    let compacts = 0
    on('session.compact', () => {
      compacts++
      return { skip: 'test' } as any
    })
    on('turn.complete', () => ({ text: 'final answer' }) as any)
    const r: any = await ($ as any).turn.complete({ turnId: 't1', answer: 'final answer', durationMs: 5, isAborted: false, reason: 'answer' })
    expect(r.text).toBe('final answer')
    expect(compacts).toBe(0)
  })
})
