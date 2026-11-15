import { describe, expect, test } from 'claude-code/testing'
import { answerShadow, guardFetch, stage, type AnswerIO, type AnswerJob, type AnswerStep } from './answer.ts'
import { DEFAULT_TIMEOUT_MS } from './call.ts'
import { maxOutputTokens } from './limits.ts'
import { buildRequest } from './request.ts'
import { SHADOW_MODEL, beginShadow, endShadow, resetShadow } from './shadow.ts'
import { stubSse } from './sse.ts'
import { HostLimitError } from './transport.ts'
import { normalizeBody, type ThreadState } from './thread.ts'
import { cfg, provider, sleeper, tick } from '../tests/harness.ts'

// Captured shadow request shapes (as in thread.test.ts): a create with a
// deferred tool added, a continue carrying only the new messages.
const BILLING = { type: 'text', text: 'x-anthropic-billing-header: cc_version=0.0.0; cch=abc' }
const SYS = [BILLING, { type: 'text', text: 'You are an agent.' }]
const BASH = { name: 'Bash', description: 'run', input_schema: { type: 'object' } }
const READ = { name: 'Read', description: 'read', input_schema: { type: 'object' } }
const LATE = { name: 'mcp__x__late', description: 'late tool', input_schema: { type: 'object' } }

const createBody = {
  model: SHADOW_MODEL,
  thread: { type: 'create' },
  system: SYS,
  tools: [BASH, READ],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'run echo' }] },
    {
      role: 'system',
      content: [
        { type: 'text', text: 'Deferred tools: mcp__x__late' },
        { type: 'tool_addition', tool: { type: 'tool_definition', definition: LATE } },
        { type: 'tool_removal', tool: { name: 'Read' } },
      ],
    },
  ],
}

const REPLY = [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'echo' } }]

const continueBody = {
  model: SHADOW_MODEL,
  thread: { type: 'continue', previous_message_id: 'msg_pr_x_1' },
  system: [BILLING],
  messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'OK' }] }],
}

const ZAI = { provider: 'zai', model: 'glm-5.3' } as const
const KEY = 'k-zai-fake-key-1234'
const toolReply = JSON.stringify({ model: 'glm-5.3-0901', content: REPLY, stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 7 } })
const textReply = (text: string, stop = 'end_turn') => JSON.stringify({ model: 'glm-5.3-0901', content: [{ type: 'text', text }], stop_reason: stop, usage: { input_tokens: 6, output_tokens: 1 } })

// A job as the shadow capture leaves it when it calls the handler.
function capturedJob(key = 'main'): AnswerJob {
  const job = beginShadow(key, { messageCount: 10 }) as AnswerJob
  job.phase = 'captured'
  return job
}

function stepOf(over: Partial<AnswerStep> = {}, threads = new Map<string, ThreadState>()): AnswerStep {
  return { event: { model: 'zai:glm-5.3' }, route: ZAI, config: cfg({ zai: KEY }), threads, ...over }
}

function ioOf(fetch: AnswerIO['fetch'], over: Partial<AnswerIO> = {}): AnswerIO {
  return { fetch, sleep: sleeper().sleep, signal: new AbortController().signal, ...over }
}

// The SSE text as its events.
function events(sse: string): { event: string; data: any }[] {
  return sse
    .split('\n\n')
    .filter(Boolean)
    .map(f => {
      const [ev, data] = f.split('\n')
      return { event: ev!.slice('event: '.length), data: JSON.parse(data!.slice('data: '.length)) }
    })
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

describe('answerShadow: a reply', () => {
  test('a create body resolves, normalizes and builds as today; one provider call', async () => {
    resetShadow()
    const p = provider([{ status: 200, text: toolReply }])
    await answerShadow(capturedJob(), createBody, stepOf(), ioOf(p.fetch))
    expect(p.calls.length).toBe(1)
    expect(p.calls[0]!.url).toBe('https://api.z.ai/api/anthropic/v1/messages')
    expect(JSON.parse(p.calls[0]!.init.body)).toEqual(JSON.parse(JSON.stringify(buildRequest(normalizeBody(createBody), 'glm-5.3', maxOutputTokens('zai:glm-5.3')))))
  })

  test('a continue body is rebuilt from the loop state, as today', async () => {
    resetShadow()
    const threads = new Map<string, ThreadState>([['main', { system: SYS, tools: [BASH], base: [createBody.messages[0], { role: 'assistant', content: REPLY }] }]])
    const p = provider([{ status: 200, text: textReply('DONE') }])
    const job = capturedJob()
    await answerShadow(job, continueBody, stepOf({}, threads), ioOf(p.fetch))
    const sent = JSON.parse(p.calls[0]!.init.body)
    expect(sent.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(sent.messages[1].content).toEqual(REPLY)
    expect(sent.tools.map((t: any) => t.name)).toEqual(['Bash'])
    expect(JSON.stringify(sent.system)).toContain('You are an agent.')
    expect(JSON.stringify(sent)).not.toContain('x-anthropic-billing-header')
    // The resolved body and its anchors are on the job, for the step to record.
    expect(job.sent.messages.length).toBe(3)
    expect(job.anchors).toEqual({ msg_pr_x_1: 2 })
  })

  test('the reply comes back as SSE: zero usage, the provider model, a minted id; the outcome holds the real usage', async () => {
    resetShadow()
    const p = provider([{ status: 200, text: toolReply }])
    const job = capturedJob()
    const sse = await answerShadow(job, createBody, stepOf(), ioOf(p.fetch))
    const ev = events(sse)
    expect(ev[0]!.event).toBe('message_start')
    const msg = ev[0]!.data.message
    expect(msg.model).toBe('glm-5.3-0901')
    expect(msg.id).toMatch(/^msg_pr_/)
    expect(Object.values(msg.usage).every(v => v === 0)).toBe(true)
    expect(ev.map(x => x.event).slice(-2)).toEqual(['message_delta', 'message_stop'])
    expect(ev.find(x => x.event === 'message_delta')!.data.delta.stop_reason).toBe('tool_use')
    expect(ev.find(x => x.event === 'content_block_delta')!.data.delta.partial_json).toBe('{"command":"echo"}')
    expect(job.outcome?.kind).toBe('reply')
    if (job.outcome?.kind !== 'reply') return
    expect(job.outcome.messageId).toBe(msg.id)
    expect(job.outcome.reply.usage.input_tokens).toBe(5)
    expect(job.outcome.reply.usage.output_tokens).toBe(7)
    expect(job.outcome.reply.content).toEqual(REPLY as any)
  })

  test('two replies get different message ids', async () => {
    resetShadow()
    const p = provider([{ status: 200, text: textReply('A') }])
    const a = capturedJob()
    await answerShadow(a, createBody, stepOf(), ioOf(p.fetch))
    endShadow('main', a.id)
    const b = capturedJob()
    await answerShadow(b, createBody, stepOf(), ioOf(p.fetch))
    expect(a.outcome?.kind === 'reply' && b.outcome?.kind === 'reply' && a.outcome.messageId !== b.outcome.messageId).toBe(true)
  })

  test('phases: captured during the provider call, handed once the answer is returned', async () => {
    resetShadow()
    const job = capturedJob()
    const during: string[] = []
    const p = provider([{ status: 200, text: textReply('X') }])
    const fetch: AnswerIO['fetch'] = (url, init) => {
      during.push(job.phase)
      return p.fetch(url, init)
    }
    await answerShadow(job, createBody, stepOf(), ioOf(fetch))
    expect(during).toEqual(['captured'])
    expect(job.phase).toBe('handed')
  })

  test('stage: moves a captured job to answered with its outcome; any other phase is left alone', () => {
    resetShadow()
    const job = capturedJob()
    expect(stage(job, { kind: 'cancelled' })).toBe(true)
    expect(job.phase).toBe('answered')
    expect(job.outcome).toEqual({ kind: 'cancelled' })
    // Staged once: a second outcome does not replace the first.
    expect(stage(job, { kind: 'error', error: { text: 'x', stopReason: 'refusal' } })).toBe(false)
    expect(job.outcome).toEqual({ kind: 'cancelled' })
    for (const phase of ['registered', 'handed', 'abandoned'] as const) {
      const other = { id: 99, messageCount: 1, phase } as AnswerJob
      expect(stage(other, { kind: 'cancelled' })).toBe(false)
      expect(other.phase).toBe(phase)
      expect(other.outcome).toBeUndefined()
    }
  })
})

describe('answerShadow: failures answer the empty stub and stage the error', () => {
  async function failing(fetch: AnswerIO['fetch'], over: Partial<AnswerIO> = {}, body: any = createBody, step: AnswerStep = stepOf()) {
    resetShadow()
    const job = capturedJob()
    const sse = await answerShadow(job, body, step, ioOf(fetch, over))
    expect(sse).toBe(stubSse())
    expect(job.outcome?.kind).toBe('error')
    expect(job.phase).toBe('handed')
    return job.outcome?.kind === 'error' ? job.outcome.error : { text: '', stopReason: 'refusal' as const }
  }

  test('provider HTTP error', async () => {
    const err = await failing(provider([{ status: 500, text: '{"error":{"message":"boom"}}' }]).fetch)
    expect(err.text).toContain('[provider-router] zai error 500')
    expect(err.text).toContain('boom')
  })

  test('a thrown fetch', async () => {
    const err = await failing(provider([new Error('connect ECONNREFUSED 127.0.0.1')]).fetch)
    expect(err.text).toContain('[provider-router] zai error: request failed')
    expect(err.text).toContain('ECONNREFUSED')
  })

  test("the host's 30 s fetch limit on the fetch transport becomes the fallback sentence; not on curl", async () => {
    const host = new Error('HooksError: $.http.fetch(...) aborted: no complete answer within 30000ms')
    const fallback = await failing(provider([host]).fetch)
    expect(fallback.text).toContain('the reply took longer than 30 s, the limit without curl')
    const curl = await failing(provider([host]).fetch, { transport: 'curl' })
    expect(curl.text).not.toContain('the limit without curl')
    expect(curl.text).toContain('no complete answer within 30000ms')
  })

  test('a curl call that fell back to $.http.fetch and hit its 30 s limit gives the fallback sentence on the curl transport too', async () => {
    const err = await failing(provider([new HostLimitError('the reply took longer than 30 s, the limit without curl (x)')]).fetch, { transport: 'curl' })
    expect(err.text).toContain('request failed: the reply took longer than 30 s, the limit without curl')
    expect(err.text).not.toContain('HostLimitError')
  })

  test('a curl transport error is shown with its text', async () => {
    const err = await failing(provider([new Error('curl transport: reply too large (over 4 MiB)')]).fetch, { transport: 'curl' })
    expect(err.text).toContain('request failed: Error: curl transport: reply too large')
  })

  test('an unreadable reply', async () => {
    const err = await failing(provider([{ status: 200, text: '<html>gateway</html>' }]).fetch)
    expect(err.text).toContain('unreadable reply')
  })

  test('a reply whose stop reason the in-place gate rejects', async () => {
    for (const stop of ['refusal', 'pause_turn', 'compaction', 'model_context_window_exceeded']) {
      const err = await failing(provider([{ status: 200, text: textReply('PARTIAL', stop) }]).fetch)
      expect(err.text).toContain('[provider-router] zai error')
      expect(err.text).toContain(stop)
      expect(err.text).toContain('PARTIAL')
    }
  })

  test('a missing or unrebuildable conversation: the clear error, no provider call, the conversation dropped', async () => {
    const p = provider([{ status: 200, text: textReply('X') }])
    const err = await failing(p.fetch, {}, continueBody)
    expect(err.text).toContain('/clear')
    // History with no assistant turn, and a recovery that fails, are no conversation either.
    const threads = new Map<string, ThreadState>([['main', { system: SYS, tools: [BASH], base: undefined }]])
    const err2 = await failing(p.fetch, { recovery: async () => ({ history: [createBody.messages[0]] }) }, continueBody, stepOf({}, threads))
    expect(err2.text).toContain('/clear')
    const err3 = await failing(p.fetch, { recovery: () => Promise.reject(new Error('session unreadable')) }, continueBody, stepOf({}, threads))
    expect(err3.text).toContain('/clear')
    expect(p.calls.length).toBe(0)
    expect(threads.get('main')).toEqual({ system: SYS, tools: [BASH], base: undefined, anchors: undefined })
  })

  test('the conversation is rebuilt from the recovery when the loop has none', async () => {
    resetShadow()
    const threads = new Map<string, ThreadState>([['main', { system: SYS, tools: [BASH], base: undefined }]])
    const p = provider([{ status: 200, text: textReply('X') }])
    const history = [createBody.messages[0], { role: 'assistant', content: REPLY }, ...continueBody.messages]
    const job = capturedJob()
    await answerShadow(job, continueBody, stepOf({}, threads), ioOf(p.fetch, { recovery: async () => ({ history }) }))
    expect(job.outcome?.kind).toBe('reply')
    expect(JSON.parse(p.calls[0]!.init.body).messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  test('no key at capture: a local error, no provider call', async () => {
    const p = provider([{ status: 200, text: textReply('X') }])
    const err = await failing(p.fetch, {}, createBody, stepOf({ config: cfg({}) }))
    expect(err.text).toContain('no API key for zai')
    expect(p.calls.length).toBe(0)
  })

  test('an unknown custom endpoint at capture: a local error, no provider call', async () => {
    const p = provider([{ status: 200, text: textReply('X') }])
    const err = await failing(p.fetch, {}, createBody, stepOf({ route: { provider: 'custom', name: 'gw', model: 'm' }, event: { model: 'custom:gw:m' } }))
    expect(err.text).toContain('unknown custom endpoint "gw"')
    expect(p.calls.length).toBe(0)
  })

  test('error text never holds a configured key', async () => {
    const err = await failing(provider([new Error(`proxy said: bad key ${KEY}`)]).fetch)
    expect(err.text).not.toContain(KEY)
    expect(err.text).toContain('[redacted]')
  })

  test('an internal failure (the timer throwing) is a local error, never a throw', async () => {
    const p = provider([{ status: 200, text: textReply('X') }])
    const err = await failing(p.fetch, {
      sleep: () => {
        throw new Error('clock gone')
      },
    })
    expect(err.text).toContain('internal error')
    expect(err.text).toContain('clock gone')
  })
})

describe('answerShadow: Esc', () => {
  test('the signal aborting during the call: the stub at once and a cancelled outcome', async () => {
    resetShadow()
    const esc = new AbortController()
    const calls: string[] = []
    const fetch: AnswerIO['fetch'] = async url => {
      calls.push(url)
      return new Promise<never>(() => {})
    }
    const job = capturedJob()
    const answer = answerShadow(job, createBody, stepOf(), ioOf(fetch, { signal: esc.signal }))
    await tick()
    expect(calls.length).toBe(1)
    esc.abort()
    expect(await answer).toBe(stubSse())
    expect(job.outcome).toEqual({ kind: 'cancelled' })
    expect(job.phase).toBe('handed')
  })

  test('a signal already aborted at capture: the stub, cancelled, no provider call, no state read or written', async () => {
    resetShadow()
    const esc = new AbortController()
    esc.abort()
    const p = provider([{ status: 200, text: textReply('X') }])
    let recovered = 0
    const threads = new Map<string, ThreadState>([['main', { system: SYS, tools: [BASH], base: [createBody.messages[0]!, { role: 'assistant', content: REPLY }] }]])
    const before = JSON.stringify([...threads])
    const job = capturedJob()
    const sse = await answerShadow(job, continueBody, stepOf({}, threads), ioOf(p.fetch, { signal: esc.signal, recovery: async () => (recovered++, {}) }))
    expect(sse).toBe(stubSse())
    expect(job.outcome).toEqual({ kind: 'cancelled' })
    expect(p.calls.length).toBe(0)
    expect(recovered).toBe(0)
    expect(JSON.stringify([...threads])).toBe(before)
  })
})

describe('answerShadow: the outbound guard', () => {
  test('a routed model equal to the shadow model is answered locally, zero network calls', async () => {
    resetShadow()
    const p = provider([{ status: 200, text: textReply('X') }])
    const step = stepOf({
      route: { provider: 'custom', name: 'gw', model: SHADOW_MODEL },
      event: { model: `custom:gw:${SHADOW_MODEL}` },
      config: cfg({}, { custom: new Map([['gw', { url: 'https://gw.example/v1', key: 'k-gw-fake-1234' }]]) }),
    })
    const job = capturedJob()
    expect(await answerShadow(job, createBody, step, ioOf(p.fetch))).toBe(stubSse())
    expect(p.calls.length).toBe(0)
    expect(job.outcome?.kind === 'error' && job.outcome.error.text).toContain('shadow model')
  })

  test('a custom endpoint URL containing the shadow model name (plain or escaped) is answered locally, zero network calls', async () => {
    for (const url of [`https://gw.example/${SHADOW_MODEL}/v1`, 'https://gw.example/provider%2Drouter%2Dshadow/v1']) {
      resetShadow()
      const p = provider([{ status: 200, text: textReply('X') }])
      const step = stepOf({
        route: { provider: 'custom', name: 'gw', model: 'm' },
        event: { model: 'custom:gw:m' },
        config: cfg({}, { custom: new Map([['gw', { url, key: undefined }]]) }),
      })
      const job = capturedJob()
      expect(await answerShadow(job, createBody, step, ioOf(p.fetch))).toBe(stubSse())
      expect(p.calls.length).toBe(0)
      expect(job.outcome?.kind === 'error' && job.outcome.error.text).toContain('shadow model')
    }
  })

  test('a conversation that merely quotes the shadow model name is sent', async () => {
    resetShadow()
    const p = provider([{ status: 200, text: textReply('X') }])
    const body = { ...createBody, messages: [{ role: 'user', content: [{ type: 'text', text: `what is ${SHADOW_MODEL}?` }] }] }
    const job = capturedJob()
    await answerShadow(job, body, stepOf(), ioOf(p.fetch))
    expect(p.calls.length).toBe(1)
    expect(p.calls[0]!.init.body).toContain(SHADOW_MODEL)
    expect(job.outcome?.kind).toBe('reply')
  })

  test('guardFetch: refuses a URL or body model naming the shadow model without calling the transport; passes the rest', async () => {
    const p = provider([{ status: 200, text: '{}' }])
    const guarded = guardFetch(p.fetch)
    const init = (model: string) => ({ method: 'POST', headers: {}, body: JSON.stringify({ model, messages: [{ role: 'user', content: SHADOW_MODEL }] }) })
    for (const [url, model] of [
      [`https://gw.example/${SHADOW_MODEL}`, 'm'],
      ['https://gw.example/provider%2Drouter-shadow', 'm'],
      ['https://gw.example/v1', SHADOW_MODEL],
    ] as const) {
      let threw = false
      try {
        await guarded(url, init(model))
      } catch (err) {
        threw = true
        expect(String(err)).toContain('shadow model')
      }
      expect(threw).toBe(true)
    }
    expect(p.calls.length).toBe(0)
    await guarded('https://gw.example/v1', init('m'))
    expect(p.calls.length).toBe(1)
  })
})

describe("answerShadow: the step's system prompt and effective tools are kept at capture", () => {
  test('kept before the provider call, without the conversation or anchors; left so after the reply', async () => {
    resetShadow()
    const threads = new Map<string, ThreadState>([['main', { system: 'OLD', tools: [READ], base: [{ role: 'user', content: 'old' }], anchors: { msg_old: 1 } }]])
    const seen: (ThreadState | undefined)[] = []
    const p = provider([{ status: 200, text: toolReply }])
    const fetch: AnswerIO['fetch'] = (url, init) => {
      seen.push(threads.get('main'))
      return p.fetch(url, init)
    }
    await answerShadow(capturedJob(), createBody, stepOf({}, threads), ioOf(fetch))
    for (const s of [seen[0], threads.get('main')]) {
      expect(s?.system).toEqual(SYS)
      // tool_addition applied, tool_removal applied.
      expect(s?.tools?.map((t: any) => t.name)).toEqual(['Bash', 'mcp__x__late'])
      expect(s?.base).toBeUndefined()
      expect(s?.anchors).toBeUndefined()
    }
  })

  test('kept per loop: a subagent capture leaves the main loop untouched', async () => {
    resetShadow()
    const main: ThreadState = { system: 'MAIN', tools: [READ], base: [{ role: 'user', content: 'm' }] }
    const threads = new Map<string, ThreadState>([['main', main]])
    const p = provider([{ status: 200, text: textReply('X') }])
    await answerShadow(capturedJob('ag-1'), createBody, stepOf({ event: { model: 'zai:glm-5.3', agentId: 'ag-1' } }, threads), ioOf(p.fetch))
    expect(threads.get('main')).toBe(main)
    expect(threads.get('ag-1')?.system).toEqual(SYS)
    expect(threads.get('ag-1')?.base).toBeUndefined()
  })
})

describe('answerShadow: timeout and job identity', () => {
  test(`a timeout (default ${DEFAULT_TIMEOUT_MS} ms) gives the stub and an error outcome with the timed-out text`, async () => {
    resetShadow()
    const s = sleeper()
    const late = deferred<any>()
    const job = capturedJob()
    const answer = answerShadow(job, createBody, stepOf(), ioOf(() => late.promise, { sleep: s.sleep }))
    await tick()
    expect(s.calls[0]!.ms).toBe(570_000)
    s.fire()
    expect(await answer).toBe(stubSse())
    expect(job.outcome?.kind === 'error' && job.outcome.error.text).toContain('no reply within 570000 ms (timed out)')
    // A late rejection after the timeout changes nothing and is handled.
    late.reject(new Error('late failure'))
    await tick()
    expect(job.outcome?.kind === 'error' && job.outcome.error.text).toContain('timed out')
    expect(job.phase).toBe('handed')
  })

  test('the timeout comes from io.timeoutMs when set', async () => {
    resetShadow()
    const s = sleeper()
    const job = capturedJob()
    const answer = answerShadow(job, createBody, stepOf(), ioOf(() => new Promise<never>(() => {}), { sleep: s.sleep, timeoutMs: 15_000 }))
    await tick()
    expect(s.calls[0]!.ms).toBe(15_000)
    s.fire()
    await answer
    expect(job.outcome?.kind === 'error' && job.outcome.error.text).toContain('no reply within 15000 ms (timed out)')
  })

  test('a late provider success after abandonment changes nothing; a newer job on the loop is untouched', async () => {
    resetShadow()
    const late = deferred<any>()
    const threads = new Map<string, ThreadState>()
    const old = capturedJob()
    const answer = answerShadow(old, createBody, stepOf({}, threads), ioOf(() => late.promise))
    await tick()
    // The step side gave the job up (its dispatch ended) and the loop moved on.
    old.phase = 'abandoned'
    endShadow('main', old.id)
    const newer = beginShadow('main', { messageCount: 3 }) as AnswerJob
    const snapshot = JSON.stringify([...threads])
    late.resolve({ status: 200, ok: true, text: toolReply })
    expect(await answer).toBe(stubSse())
    await tick()
    expect(old.phase).toBe('abandoned')
    expect(old.outcome).toBeUndefined()
    expect(newer.phase).toBe('registered')
    expect(newer.outcome).toBeUndefined()
    expect(JSON.stringify([...threads])).toBe(snapshot)
  })

  test('a late rejection after abandonment (the dispatch signal aborting) changes nothing and rejects nothing unhandled', async () => {
    resetShadow()
    const late = deferred<any>()
    const gone = new AbortController()
    const old = capturedJob()
    const answer = answerShadow(old, createBody, stepOf(), ioOf(() => late.promise, { signal: gone.signal }))
    await tick()
    old.phase = 'abandoned'
    gone.abort()
    expect(await answer).toBe(stubSse())
    endShadow('main', old.id)
    const newer = beginShadow('main', { messageCount: 3 }) as AnswerJob
    late.reject(new Error('late failure'))
    await tick()
    expect(old.phase).toBe('abandoned')
    expect(old.outcome).toBeUndefined()
    expect(newer.phase).toBe('registered')
    expect(newer.outcome).toBeUndefined()
  })

  test('a job that is not captured (registered, handed, abandoned) gets the stub with no provider call', async () => {
    for (const phase of ['registered', 'handed', 'abandoned'] as const) {
      resetShadow()
      const p = provider([{ status: 200, text: textReply('X') }])
      const threads = new Map<string, ThreadState>()
      const job = capturedJob()
      job.phase = phase
      expect(await answerShadow(job, createBody, stepOf({}, threads), ioOf(p.fetch))).toBe(stubSse())
      expect(p.calls.length).toBe(0)
      expect(job.phase).toBe(phase)
      expect(job.outcome).toBeUndefined()
      expect(threads.size).toBe(0)
    }
  })
})
