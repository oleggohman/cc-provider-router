import { describe, expect, test } from 'claude-code/testing'
import { routedStep } from './register.ts'
import { SHADOW_MODEL, ShadowError, resetShadow, shadowFetch, shadowStats, shadowStep } from './shadow.ts'

// The test kit refuses `$.http.fetch` from a test's own hooks, so the engine
// stand-in sends its requests straight through the mod's `http.fetch` logic
// (`shadowFetch`), with `network` as the `next` beneath it. Every shadow test
// asserts the network was called 0 times for shadow traffic.

const URL = 'https://api.anthropic.com/v1/messages?beta=true'

type Req = { agent?: string | null; model?: string; messages?: number; tools?: boolean; engine?: boolean; body?: unknown }

function fetchEvent(r: Req): any {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (r.engine !== false) headers['x-claude-code-session-id'] = 'sess-1'
  if (r.agent) headers['x-claude-code-agent-id'] = r.agent
  const body = {
    model: r.model ?? SHADOW_MODEL,
    messages: Array.from({ length: r.messages ?? 1 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` })),
    system: [{ type: 'text', text: 'SYS' }],
    ...(r.tools === false ? {} : { tools: [{ name: 'Read', description: 'd', input_schema: { type: 'object' } }] }),
    max_tokens: 32000,
    metadata: { user_id: 'u' },
    stream: true,
  }
  const init: any = { method: 'POST', headers, body: 'body' in r ? r.body : JSON.stringify(body) }
  if (r.engine !== false) init.compress = 'gzip'
  return { url: URL, init }
}

// The network beneath the mod. Counts every call.
function network() {
  const calls: any[] = []
  const next = (e: any) => {
    calls.push(e)
    return { value: { status: 200, ok: true, headers: {}, text: '{"network":true}' } }
  }
  return { calls, next }
}

async function send(net: ReturnType<typeof network>, r: Req): Promise<any> {
  const out: any = await shadowFetch(fetchEvent(r), net.next)
  return out.value
}

const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Engine stand-in for a step's `next`: sends `reqs` (default: one match for
// the step's loop), records each answer, then yields a chunk that must never
// reach the mod's caller.
function engine(net: ReturnType<typeof network>, opts: { reqs?: (e: any) => Req[]; throwAfter?: boolean; gate?: Promise<void> } = {}) {
  const answers: any[] = []
  const seen: any[] = []
  const next = async function* (e: any): AsyncGenerator<any, any> {
    seen.push(e)
    const reqs = opts.reqs ? opts.reqs(e) : [{ agent: e.agentId, messages: e.messageCount }]
    for (const r of reqs) answers.push(await send(net, r))
    if (opts.gate) await opts.gate
    if (opts.throwAfter) throw new Error('engine failed')
    yield { kind: 'text', index: 0, text: 'ENGINE-STUB-CHUNK' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: ZERO }
    return { turnId: e.turnId, index: e.index, answer: 'ENGINE-STUB-CHUNK', toolUses: [] }
  }
  return { answers, seen, next }
}

// Lets pending microtasks run (no timers in the kit's types).
async function tick() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

async function drain(stream: AsyncGenerator<any, any>) {
  const chunks: any[] = []
  let step = await stream.next()
  while (!step.done) {
    chunks.push(step.value)
    step = await stream.next()
  }
  return { chunks, result: step.value }
}

const step = (over: any = {}) => ({ turnId: 't1', index: 0, model: 'openai:gpt-5', messageCount: 1, ...over })
const ROUTE = { provider: 'openai', model: 'gpt-5' } as const
const CFG = { keys: { openai: 'sk-test-secret-123456' }, custom: new Map(), contextWindows: new Map(), warnings: [] }

const run = (e: any, eng: { next: any }) => drain(routedStep(e, eng.next, ROUTE, CFG as any))

describe('routed step with the shadow capture', () => {
  test('a match is answered with the zero-usage stub, never the network', async () => {
    resetShadow()
    const net = network()
    const eng = engine(net)
    const { chunks, result } = await run(step(), eng)
    expect(net.calls.length).toBe(0)
    expect(eng.seen[0].model).toBe(SHADOW_MODEL)
    expect(eng.answers[0].status).toBe(200)
    expect(eng.answers[0].text).toContain('message_start')
    expect(eng.answers[0].text).toContain('"input_tokens":0')
    expect(eng.answers[0].text).not.toMatch(/"(input|output)_tokens":[1-9]/)
    // The stub's chunks are drained, never yielded.
    expect(JSON.stringify(chunks)).not.toContain('ENGINE-STUB-CHUNK')
    expect(result.answer).not.toContain('ENGINE-STUB-CHUNK')
    expect(result.answer).not.toContain('sk-test-secret')
    expect(shadowStats()).toEqual({ shadowLeaks: 0, shadowRefused: 0, pending: 0 })
  })

  test('agent header missing: refused locally (400, no retry), step ends with an error', async () => {
    resetShadow()
    const net = network()
    const eng = engine(net, { reqs: e => [{ agent: null, messages: e.messageCount }] })
    const { result } = await run(step({ agentId: 'a1' }), eng)
    expect(net.calls.length).toBe(0)
    expect(eng.answers[0].status).toBe(400)
    expect(eng.answers[0].ok).toBe(false)
    expect(eng.answers[0].headers['x-should-retry']).toBe('false')
    expect(JSON.parse(eng.answers[0].text).error.type).toBe('invalid_request_error')
    expect(result.answer).toContain('[provider-router]')
    expect(result.stopReason).toBe('refusal')
    expect(shadowStats().shadowRefused).toBe(1)
    expect(shadowStats().shadowLeaks).toBe(0)
  })

  test('2nd and 3rd engine requests in the same step are refused', async () => {
    resetShadow()
    const net = network()
    const eng = engine(net, {
      reqs: e => [
        { agent: e.agentId, messages: e.messageCount },
        { agent: e.agentId, messages: e.messageCount },
        { agent: e.agentId, model: 'claude-haiku-4-5', messages: e.messageCount },
      ],
    })
    await run(step(), eng)
    expect(net.calls.length).toBe(0)
    expect(eng.answers.map((a: any) => a.status)).toEqual([200, 400, 400])
    expect(shadowStats().shadowRefused).toBe(2)
  })

  test('a side request (other model, no tools) on a pending loop is refused', async () => {
    resetShadow()
    const net = network()
    const eng = engine(net, {
      reqs: e => [
        { agent: e.agentId, model: 'claude-haiku-4-5', tools: false, messages: 1 },
        { agent: e.agentId, messages: e.messageCount },
      ],
    })
    await run(step({ agentId: 'a1' }), eng)
    expect(net.calls.length).toBe(0)
    expect(eng.answers.map((a: any) => a.status)).toEqual([400, 200])
  })

  test('fewer API messages than stored rows is consistent (rows merge)', async () => {
    resetShadow()
    const net = network()
    const eng = engine(net, { reqs: () => [{ messages: 2 }] })
    const { result } = await run(step({ messageCount: 22 }), eng)
    expect(net.calls.length).toBe(0)
    expect(eng.answers[0].status).toBe(200)
    expect(result.answer).not.toContain('not captured')
  })

  test('a request with an inconsistent message count is refused, not captured', async () => {
    resetShadow()
    const net = network()
    const eng = engine(net, { reqs: () => [{ messages: 7 }] })
    const { result } = await run(step({ messageCount: 3 }), eng)
    expect(net.calls.length).toBe(0)
    expect(eng.answers[0].status).toBe(400)
    expect(result.answer).toContain('[provider-router]')
    expect(result.answer).toContain('not captured')
  })

  test('an unreadable body on a pending loop is refused', async () => {
    resetShadow()
    const net = network()
    const eng = engine(net, { reqs: () => [{ body: { base64: 'AAAA' } }] })
    await run(step(), eng)
    expect(net.calls.length).toBe(0)
    expect(eng.answers[0].status).toBe(400)
  })

  test('a refused shadow step ends (one request, no retry loop) and bumps shadowRefused', async () => {
    resetShadow()
    const net = network()
    const eng = engine(net, { reqs: () => [{ agent: 'other', messages: 1 }] })
    const { chunks, result } = await run(step(), eng)
    expect(net.calls.length).toBe(0)
    expect(eng.seen.length).toBe(1)
    expect(eng.answers.length).toBe(1)
    expect(chunks[chunks.length - 1].kind).toBe('stop')
    expect(result.stopReason).toBe('refusal')
    expect(shadowStats().shadowRefused).toBe(1)
  })

  test('pending is kept until the stream ends and cleared after (success)', async () => {
    resetShadow()
    const net = network()
    let open!: () => void
    const gate = new Promise<void>(r => (open = r))
    const eng = engine(net, { gate })
    const running = run(step(), eng)
    await tick()
    // Captured but the stream has not ended: still pending, so a further
    // request for the loop (even a real-model one) is refused.
    expect(shadowStats().pending).toBe(1)
    expect((await send(net, { model: 'claude-haiku-4-5' })).status).toBe(400)
    open()
    await running
    expect(shadowStats().pending).toBe(0)
    expect(net.calls.length).toBe(0)
    // After the stream ended: a real-model request is not a shadow and goes
    // on; a shadow-model one is still refused.
    expect((await send(net, { model: 'claude-haiku-4-5' })).text).toBe('{"network":true}')
    expect((await send(net, {})).status).toBe(400)
    expect(net.calls.length).toBe(1)
    expect(net.calls[0].init.body).not.toContain(SHADOW_MODEL)
  })

  test('pending cleared after an engine error', async () => {
    resetShadow()
    const net = network()
    const eng = engine(net, { throwAfter: true })
    const { result } = await run(step(), eng)
    expect(net.calls.length).toBe(0)
    expect(shadowStats().pending).toBe(0)
    // The capture happened before the error, so the step went on to dispatch.
    expect(result.answer).toContain('[provider-router]')
    expect(result.answer).not.toContain('not captured')
  })

  test('pending cleared after an abort before any request', async () => {
    resetShadow()
    const net = network()
    const next = async function* (): AsyncGenerator<any, any> {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }
    const { result } = await run(step(), { next })
    expect(net.calls.length).toBe(0)
    expect(shadowStats().pending).toBe(0)
    expect(result.answer).toContain('not captured')
  })

  test('the stub never reaches the caller, usage is zero and shadowLeaks stays 0', async () => {
    resetShadow()
    const net = network()
    const { chunks } = await run(step({ agentId: 'a9' }), engine(net))
    expect(net.calls.length).toBe(0)
    for (const c of chunks) if (c.kind === 'stop') expect(c.usage.input_tokens + c.usage.output_tokens).toBe(0)
    expect(JSON.stringify(chunks)).not.toContain('ENGINE-STUB-CHUNK')
    expect(shadowStats().shadowLeaks).toBe(0)
  })
})

describe('shadow fetch rules', () => {
  test('a shadow-model request matching no entry is refused', async () => {
    resetShadow()
    const net = network()
    const r = await send(net, { agent: 'zz' })
    expect(net.calls.length).toBe(0)
    expect(r.status).toBe(400)
    expect(shadowStats().shadowRefused).toBe(1)
  })

  test('empty map after a reload refuses a stray shadow request', async () => {
    resetShadow() // stands in for a module reload (/config change)
    const net = network()
    expect((await send(net, {})).status).toBe(400)
    expect(net.calls.length).toBe(0)
  })

  test('a shadow-model request without engine markers is refused too', async () => {
    resetShadow()
    const net = network()
    expect((await send(net, { engine: false })).status).toBe(400)
    expect(net.calls.length).toBe(0)
    expect(shadowStats().shadowLeaks).toBe(1)
  })

  test("the mod's own fetches pass through", async () => {
    resetShadow()
    const net = network()
    const out: any = await shadowFetch(
      { url: 'https://api.openai.com/v1/chat/completions', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"gpt-5"}' } },
      net.next,
    )
    expect(out.value.text).toBe('{"network":true}')
    expect(net.calls.length).toBe(1)
  })

  test("other loops' real-model requests pass while a shadow is pending", async () => {
    resetShadow()
    const net = network()
    let open!: () => void
    const gate = new Promise<void>(r => (open = r))
    const running = shadowStep(step({ agentId: 'a1' }), engine(net, { gate }).next)
    await tick()
    expect((await send(net, { model: 'claude-haiku-4-5' })).text).toBe('{"network":true}')
    open()
    await running
    expect(net.calls.length).toBe(1)
    expect(net.calls[0].init.body).not.toContain(SHADOW_MODEL)
  })
})

describe('shadowStep', () => {
  test('a second shadow on an already-pending key is refused', async () => {
    resetShadow()
    const net = network()
    let open!: () => void
    const gate = new Promise<void>(r => (open = r))
    const first = shadowStep(step({ agentId: 'a1' }), engine(net, { gate }).next)
    let calls = 0
    let err: unknown
    try {
      await shadowStep(step({ agentId: 'a1' }), async function* () {
        calls++
      })
    } catch (x) {
      err = x
    }
    expect(err instanceof ShadowError).toBe(true)
    expect(calls).toBe(0)
    open()
    const body = await first
    expect(body.model).toBe(SHADOW_MODEL)
    expect(net.calls.length).toBe(0)
    expect(shadowStats().shadowRefused).toBe(1)
  })

  test('main and a subagent pending at once each get their own capture', async () => {
    resetShadow()
    const net = network()
    let open!: () => void
    const gate = new Promise<void>(r => (open = r))
    const main = shadowStep(step({ messageCount: 1 }), engine(net, { gate }).next)
    const sub = shadowStep(step({ agentId: 'a1', messageCount: 3 }), engine(net, { gate }).next)
    await tick()
    expect(shadowStats().pending).toBe(2)
    open()
    const [m, s] = await Promise.all([main, sub])
    expect(m.messages.length).toBe(1)
    expect(s.messages.length).toBe(3)
    expect(net.calls.length).toBe(0)
  })

  test('two instances of the same agent type in parallel', async () => {
    resetShadow()
    const net = network()
    let open!: () => void
    const gate = new Promise<void>(r => (open = r))
    const a = shadowStep(step({ agentId: 'inst-1', messageCount: 1 }), engine(net, { gate }).next)
    const b = shadowStep(step({ agentId: 'inst-2', messageCount: 2 }), engine(net, { gate }).next)
    open()
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.messages.length).toBe(1)
    expect(rb.messages.length).toBe(2)
    expect(net.calls.length).toBe(0)
    expect(shadowStats().pending).toBe(0)
  })
})

describe('through the plugin', () => {
  test('a routed step calls the engine with the shadow model and yields none of its chunks', async ($, on) => {
    on('clock.sleep', () => ({ value: undefined }) as any)
    // A key, so the step gets past the missing-key check to the shadow.
    on('env.get', (_$, e: any) => ({ value: e.name === 'OPENAI_API_KEY' ? 'sk-test-plugin-key-123456' : undefined }) as any)
    const net: any[] = []
    on('http.fetch', (_$, e) => {
      net.push(e)
      return { value: { status: 200, ok: true, headers: {}, text: '' } }
    })
    const seen: any[] = []
    on('turn.step', async function* (_$, e) {
      seen.push(e)
      yield { kind: 'text', index: 0, text: 'ENGINE-STUB-CHUNK' } as any
      yield { kind: 'stop', stopReason: 'end_turn', usage: ZERO } as any
      return { turnId: e.turnId, index: e.index, answer: 'ENGINE-STUB-CHUNK', toolUses: [] } as any
    })
    const { chunks, result } = await drain($.turn.step(step()) as any)
    expect(seen.length).toBe(1)
    expect(seen[0].model).toBe(SHADOW_MODEL)
    expect(net.length).toBe(0)
    expect(JSON.stringify(chunks)).not.toContain('ENGINE-STUB-CHUNK')
    expect(result.answer).toContain('[provider-router] openai')
  })
})
