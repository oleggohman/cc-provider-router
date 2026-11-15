import { describe, expect, test } from 'claude-code/testing'
import { routedStep } from './register.ts'
import { ID_FORMS, classifyModel } from './route.ts'
import { SHADOW_MODEL, ShadowError, beginShadow, endShadow, isEngineRequest, noteStep, resetShadow, sessionFlags, shadowFetch, shadowFetchFailed, shadowStats, shadowStep } from './shadow.ts'
import { cfg, drain, sleeper, tick, ZERO } from '../tests/harness.ts'

// The test kit refuses `$.http.fetch` from a test's own hooks, so the engine
// stand-in sends its requests straight through the mod's `http.fetch` logic
// (`shadowFetch`), with `network` as the `next` beneath it. Every shadow test
// asserts the network was called 0 times for shadow traffic.

const URL = 'https://api.anthropic.com/v1/messages?beta=true'

// The shipped default of the autoModeClassifier option, and the opt-out.
const ON = { autoModeClassifier: true }
const OFF = { autoModeClassifier: false }

// `origin`: who raised the request (`next.origin.plugin`, set by the host);
// "engine" by default for a request with engine markers, this mod otherwise.
type Req = { agent?: string | null; model?: string; messages?: number; tools?: boolean; engine?: boolean; body?: unknown; origin?: string }

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

// The hook's `next` for a request raised by `plugin`: the network beneath,
// with the host-set `next.origin`.
function nextFrom(net: ReturnType<typeof network>, plugin: string) {
  return Object.assign((e: any) => net.next(e), { origin: { plugin, tier: plugin === 'engine' ? 'core' : 'append' } })
}

async function send(net: ReturnType<typeof network>, r: Req): Promise<any> {
  const out: any = await shadowFetch(fetchEvent(r), nextFrom(net, r.origin ?? (r.engine === false ? 'provider-router' : 'engine')), ON)
  return out.value
}

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

const step = (over: any = {}) => ({ turnId: 't1', index: 0, model: 'openai:gpt-5', messageCount: 1, ...over })
const ROUTE = { provider: 'openai', model: 'gpt-5' } as const
const CFG = cfg({ openai: 'sk-test-secret-123456' })

// The provider beneath a captured step: answers 500 (the dispatch itself is
// tested in the adapter tests). Never the network beneath shadowFetch.
const io = (signal = new AbortController().signal) => ({
  fetch: async () => ({ status: 500, ok: false, text: '{"error":{"message":"test provider"}}' }),
  sleep: sleeper().sleep,
  signal,
})

const run = (e: any, eng: { next: any }, threads: Map<string, any> = new Map(), signal?: AbortSignal) => drain(routedStep(e, eng.next, ROUTE, CFG, io(signal), threads))

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
    expect(shadowStats()).toEqual({ shadowLeaks: 0, shadowRefused: 0, pending: 0, blind: false })
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

  test('pending cleared after an engine failure before any request (no Esc): error text', async () => {
    resetShadow()
    const net = network()
    const next = async function* (): AsyncGenerator<any, any> {
      throw new Error('engine broke')
    }
    const { result } = await run(step(), { next })
    expect(net.calls.length).toBe(0)
    expect(shadowStats().pending).toBe(0)
    expect(result.answer).toContain('not captured')
  })

  test('Esc during the shadow step ends the step cleanly: no chunks, no text, no thread state', async () => {
    resetShadow()
    const net = network()
    const esc = new AbortController()
    const next = async function* (): AsyncGenerator<any, any> {
      esc.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }
    const threads = new Map<string, any>()
    const { chunks, result } = await run(step(), { next }, threads, esc.signal)
    expect(net.calls.length).toBe(0)
    expect(shadowStats().pending).toBe(0)
    expect(chunks).toEqual([])
    expect(result.answer).toBe('')
    expect(result.stopReason).toBe(null)
    expect(threads.size).toBe(0)
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

  test('an unreadable engine body for another loop is refused while any shadow is pending', async () => {
    resetShadow()
    const net = network()
    let open!: () => void
    const gate = new Promise<void>(r => (open = r))
    const running = shadowStep(step({ agentId: 'a1' }), engine(net, { gate }).next)
    await tick()
    expect((await send(net, { agent: 'other', body: { base64: 'AAAA' } })).status).toBe(400)
    open()
    await running
    expect(net.calls.length).toBe(0)
  })

  test('an unreadable engine body with nothing pending passes (not a shadow)', async () => {
    resetShadow()
    const net = network()
    expect((await send(net, { body: { base64: 'AAAA' } })).text).toBe('{"network":true}')
    expect(net.calls.length).toBe(1)
  })

  test('an engine request whose string body is not JSON but names the shadow model is refused', async () => {
    resetShadow()
    const net = network()
    expect((await send(net, { body: `{"model":"${SHADOW_MODEL}", broken` })).status).toBe(400)
    expect(net.calls.length).toBe(0)
  })

  test('an engine request whose URL names the shadow model is refused (model in the path)', async () => {
    resetShadow()
    const net = network()
    const ev = fetchEvent({ model: 'claude-haiku-4-5' })
    ev.url = `https://bedrock.example/model/${SHADOW_MODEL}/invoke`
    const out: any = await shadowFetch(ev, net.next, ON)
    expect(out.value.status).toBe(400)
    expect(net.calls.length).toBe(0)
  })

  test('engine markers: compress alone, the session header alone, any header case', () => {
    expect(isEngineRequest({ url: URL, init: { compress: 'gzip' } })).toBe(true)
    expect(isEngineRequest({ url: URL, init: { headers: { 'x-claude-code-session-id': 's' } } })).toBe(true)
    expect(isEngineRequest({ url: URL, init: { headers: { 'X-Claude-Code-Session-Id': 's' } } })).toBe(true)
    expect(isEngineRequest({ url: URL, init: { headers: { 'content-type': 'application/json' } } })).toBe(false)
  })

  test('the agent header is read in any case for the loop key', async () => {
    resetShadow()
    const net = network()
    // A mixed-case agent header matches the pending entry of that loop.
    let open!: () => void
    const gate = new Promise<void>(r => (open = r))
    const captured = shadowStep(step({ agentId: 'a1' }), async function* (e: any) {
      const ev = fetchEvent({ messages: e.messageCount })
      ev.init.headers['X-Claude-Code-Agent-Id'] = 'a1'
      const out: any = await shadowFetch(ev, net.next, ON)
      expect(out.value.status).toBe(200)
      await gate
    })
    open()
    expect((await captured).model).toBe(SHADOW_MODEL)
    expect(net.calls.length).toBe(0)
  })

  test('message count edges: no messages is refused; messageCount 0 still allows one', async () => {
    resetShadow()
    const net = network()
    const empty = engine(net, { reqs: () => [{ messages: 0 }] })
    expect((await run(step({ messageCount: 1 }), empty)).result.answer).toContain('not captured')
    expect(empty.answers[0].status).toBe(400)
    const zero = engine(net, { reqs: () => [{ messages: 1 }] })
    await run(step({ messageCount: 0 }), zero)
    expect(zero.answers[0].status).toBe(200)
    expect(net.calls.length).toBe(0)
  })

  test("the mod's own fetch passes even when its conversation quotes the shadow model name", async () => {
    resetShadow()
    const net = network()
    const body = JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: `grep ${SHADOW_MODEL} README.md` }] })
    const out: any = await shadowFetch({ url: 'https://api.z.ai/api/anthropic/v1/messages', init: { method: 'POST', headers: {}, body } }, net.next, ON)
    expect(out.value.text).toBe('{"network":true}')
    expect(net.calls.length).toBe(1)
    expect(shadowStats().shadowLeaks).toBe(0)
  })

  test('a non-engine request: JSON naming the shadow model, unparseable text naming it, or unreadable bytes while pending, is refused', async () => {
    resetShadow()
    const net = network()
    const plain = (body: unknown) => shadowFetch({ url: 'https://x.example/v1', init: { method: 'POST', headers: {}, body } }, net.next, ON) as any
    expect((await plain(JSON.stringify({ model: SHADOW_MODEL, messages: [] }))).value.status).toBe(400)
    expect((await plain(`model=${SHADOW_MODEL}&x`)).value.status).toBe(400)
    expect(shadowStats().shadowLeaks).toBe(2)
    let open!: () => void
    const gate = new Promise<void>(r => (open = r))
    const running = shadowStep(step({ agentId: 'a1' }), engine(net, { gate }).next)
    await tick()
    expect((await plain({ bytes: 'AAAA' })).value.status).toBe(400)
    open()
    await running
    // With nothing pending, unreadable bytes are not a shadow.
    expect((await plain({ bytes: 'AAAA' })).value.text).toBe('{"network":true}')
    expect(net.calls.length).toBe(1)
  })

  test("the mod's own fetches pass through", async () => {
    resetShadow()
    const net = network()
    const out: any = await shadowFetch(
      { url: 'https://api.openai.com/v1/chat/completions', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"gpt-5"}' } },
      net.next,
      ON,
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

describe('http.fetch .catch (shadowFetch failed before deciding)', () => {
  const caught = (net: ReturnType<typeof network>, called: boolean) => Object.assign((e: any) => net.next(e), { called })

  test('already passed on by the hook: replayed, nothing new decided', async () => {
    resetShadow()
    const net = network()
    const out: any = await shadowFetchFailed(fetchEvent({ model: 'claude-haiku-4-5' }), caught(net, true), ON)
    expect(out.value.text).toBe('{"network":true}')
  })

  test('anything that could be a shadow is refused: a pending loop, the shadow model in body or URL', async () => {
    resetShadow()
    const net = network()
    expect(((await shadowFetchFailed(fetchEvent({}), caught(net, false), ON)) as any).value.status).toBe(400)
    const ev = fetchEvent({ model: 'claude-haiku-4-5' })
    ev.url = `https://x.example/${SHADOW_MODEL}`
    expect(((await shadowFetchFailed(ev, caught(net, false), ON)) as any).value.status).toBe(400)
    let open!: () => void
    const gate = new Promise<void>(r => (open = r))
    const running = shadowStep(step({ agentId: 'a1' }), engine(net, { gate }).next)
    await tick()
    expect(((await shadowFetchFailed(fetchEvent({ model: 'claude-haiku-4-5', agent: 'zz' }), caught(net, false), ON)) as any).value.status).toBe(400)
    open()
    await running
    expect(net.calls.length).toBe(0)
  })

  test('an ordinary request with nothing pending goes on', async () => {
    resetShadow()
    const net = network()
    const out: any = await shadowFetchFailed(fetchEvent({ model: 'claude-haiku-4-5' }), caught(net, false), ON)
    expect(out.value.text).toBe('{"network":true}')
    expect(net.calls.length).toBe(1)
  })
})

describe('blind capture: the http.fetch hook never sees the engine request', () => {
  // An engine whose request goes out without passing this mod's hook (an
  // organization guard that hides engine requests from other mods): it sends
  // to the network directly and fails on the unknown model.
  function blindEngine(net: ReturnType<typeof network>) {
    const seen: any[] = []
    const next = async function* (e: any): AsyncGenerator<any, any> {
      seen.push(e)
      net.next(fetchEvent({ agent: e.agentId, messages: e.messageCount }))
      throw new Error('404 model not found')
    }
    return { seen, next }
  }

  const counting = (signal = new AbortController().signal) => {
    const calls: any[] = []
    return { calls, io: { ...io(signal), fetch: async (...a: any[]) => (calls.push(a), { status: 500, ok: false, text: '{}' }) } }
  }

  test('one unseen shadow turns routing off: later routed steps never call next and make no network call', async () => {
    resetShadow()
    const net = network()
    const eng = blindEngine(net)
    const p = counting()
    const first = await drain(routedStep(step(), eng.next, ROUTE, CFG, p.io, new Map()))
    expect(first.result.answer).toContain('not captured')
    expect(first.result.answer).toContain('routing is off')
    expect(shadowStats().blind).toBe(true)
    expect(net.calls.length).toBe(1) // the one the guard let through, before the breaker
    for (const s of [step(), step({ agentId: 'a1' }), step({ model: 'zai:glm-5.3' })]) {
      const r = await drain(routedStep(s, eng.next, ROUTE, CFG, p.io, new Map()))
      expect(r.result.answer).toContain('[provider-router]')
      expect(r.result.answer).toContain('routing is off')
      expect(r.result.stopReason).toBe('refusal')
    }
    expect(eng.seen.length).toBe(1)
    expect(net.calls.length).toBe(1)
    expect(p.calls.length).toBe(0)
    expect(shadowStats().pending).toBe(0)
  })

  test('shadowStep itself refuses while off, without calling next; a reload (resetShadow) clears it', async () => {
    resetShadow()
    const net = network()
    const thrown = async (p: Promise<unknown>) => {
      try {
        await p
      } catch (x) {
        return x
      }
      return undefined
    }
    expect((await thrown(shadowStep(step(), blindEngine(net).next))) instanceof ShadowError).toBe(true)
    let calls = 0
    const counted = async function* () {
      calls++
    }
    expect((await thrown(shadowStep(step(), counted))) instanceof ShadowError).toBe(true)
    expect(calls).toBe(0)
    resetShadow()
    expect(shadowStats().blind).toBe(false)
    expect((await shadowStep(step(), engine(net).next)).model).toBe(SHADOW_MODEL)
    expect(net.calls.length).toBe(1)
  })

  test('Esc during an unseen shadow does not turn routing off', async () => {
    resetShadow()
    const net = network()
    const esc = new AbortController()
    const next = async function* (): AsyncGenerator<any, any> {
      esc.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }
    await run(step(), { next }, new Map(), esc.signal)
    expect(shadowStats().blind).toBe(false)
    const eng = engine(net)
    await run(step(), eng)
    expect(eng.seen.length).toBe(1)
    expect(net.calls.length).toBe(0)
  })

  test('a step that sends no request turns routing off; an engine request the hook sees turns it back on', async () => {
    resetShadow()
    const net = network()
    // A hook beneath this mod answers the step itself: no request at all.
    const silent = async function* (e: any): AsyncGenerator<any, any> {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] }
    }
    const p = counting()
    const first = await drain(routedStep(step(), silent, ROUTE, CFG, p.io, new Map()))
    expect(first.result.answer).toContain('not captured')
    expect(first.result.answer).toContain('saw no engine request')
    expect(shadowStats().blind).toBe(true)
    // Still off: refused before next, nothing sent.
    let calls = 0
    const counted = async function* (): AsyncGenerator<any, any> {
      calls++
    }
    const off = await drain(routedStep(step(), counted, ROUTE, CFG, p.io, new Map()))
    expect(off.result.answer).toContain('routing is off')
    expect(calls).toBe(0)
    // The mod's own requests (no engine markers) prove nothing.
    await send(net, { engine: false, model: 'gpt-5' })
    expect(shadowStats().blind).toBe(true)
    // An unprefixed engine request seen by the hook: not blind after all.
    expect((await send(net, { model: 'claude-sonnet-4-5', messages: 2 })).text).toBe('{"network":true}')
    expect(shadowStats().blind).toBe(false)
    const eng = engine(net)
    const back = await drain(routedStep(step(), eng.next, ROUTE, CFG, p.io, new Map()))
    expect(back.result.answer).not.toContain('routing is off')
    expect(eng.seen.length).toBe(1)
    expect(eng.answers[0].status).toBe(200)
    expect(p.calls.length).toBe(1)
    expect(net.calls.length).toBe(2) // the mod's own request and the unprefixed one; no shadow
    expect(shadowStats().shadowLeaks).toBe(0)
  })

  test('an engine request seen only by the .catch (shadowFetchFailed) also turns routing back on', async () => {
    resetShadow()
    const net = network()
    await drain(routedStep(step(), blindEngine(net).next, ROUTE, CFG, counting().io, new Map()))
    expect(shadowStats().blind).toBe(true)
    shadowFetchFailed(fetchEvent({ model: 'claude-sonnet-4-5' }), Object.assign(nextFrom(net, 'engine'), { called: false }), ON)
    expect(shadowStats().blind).toBe(false)
  })

  test("another plugin's request with engine markers neither turns routing back on nor makes a later step call next", async () => {
    resetShadow()
    const net = network()
    const p = counting()
    await drain(routedStep(step(), blindEngine(net).next, ROUTE, CFG, p.io, new Map()))
    expect(shadowStats().blind).toBe(true)
    // `compress` and the session header are caller-controlled; only the
    // host-set origin proves an engine request.
    const forged = (strip?: (ev: any) => void) => {
      const ev = fetchEvent({ model: 'claude-sonnet-4-5' })
      strip?.(ev)
      return ev
    }
    const events = [forged(), forged(ev => delete ev.init.headers['x-claude-code-session-id']), forged(ev => delete ev.init.compress)]
    for (const ev of events) {
      await shadowFetch(ev, nextFrom(net, 'other-plugin'), ON)
      shadowFetchFailed(ev, Object.assign(nextFrom(net, 'other-plugin'), { called: false }), ON)
      shadowFetchFailed(ev, Object.assign(nextFrom(net, 'other-plugin'), { called: true }), ON)
    }
    expect(shadowStats().blind).toBe(true)
    let calls = 0
    const counted = async function* (): AsyncGenerator<any, any> {
      calls++
    }
    const off = await drain(routedStep(step(), counted, ROUTE, CFG, p.io, new Map()))
    expect(off.result.answer).toContain('routing is off')
    expect(calls).toBe(0)
    expect(p.calls.length).toBe(0)
    // The one the guard let through before the breaker, then the forged ones.
    expect(net.calls.length).toBe(1 + events.length * 3)
    expect(net.calls.slice(1).some((c: any) => String(c.init?.body).includes(SHADOW_MODEL))).toBe(false)
  })

  test("another plugin's engine-marked request during an unseen shadow does not stop routing turning off", async () => {
    resetShadow()
    const net = network()
    // The guard hides the engine's shadow request; another plugin's marked
    // fetch passes through this mod's hook meanwhile.
    const masked = async function* (e: any): AsyncGenerator<any, any> {
      await send(net, { model: 'claude-sonnet-4-5', origin: 'other-plugin' })
      net.next(fetchEvent({ agent: e.agentId, messages: e.messageCount }))
      throw new Error('404 model not found')
    }
    const first = await drain(routedStep(step(), masked, ROUTE, CFG, counting().io, new Map()))
    expect(first.result.answer).toContain('routing is off')
    expect(shadowStats().blind).toBe(true)
  })

  test('a shadow the hook saw but refused (not captured) does not turn routing off', async () => {
    resetShadow()
    const net = network()
    const bad = engine(net, { reqs: () => [{ messages: 7 }] })
    expect((await run(step({ messageCount: 3 }), bad)).result.answer).toContain('not captured')
    expect(shadowStats().blind).toBe(false)
    const eng = engine(net)
    await run(step(), eng)
    expect(eng.seen.length).toBe(1)
    expect(net.calls.length).toBe(0)
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

describe('jobs: beginShadow / endShadow', () => {
  test('one job per loop: a second begin for a pending loop is refused, zero network calls', async () => {
    resetShadow()
    const net = network()
    const first = beginShadow('a1', { messageCount: 1 })
    let err: unknown
    try {
      beginShadow('a1', { messageCount: 1 })
    } catch (x) {
      err = x
    }
    expect(err instanceof ShadowError).toBe(true)
    expect(shadowStats().pending).toBe(1)
    expect(shadowStats().shadowRefused).toBe(1)
    // The pending job still answers its own loop's match.
    const out = await send(net, { agent: 'a1', messages: 1 })
    expect(out.text).toContain('message_start')
    expect(first.phase).toBe('captured')
    expect(net.calls.length).toBe(0)
    endShadow('a1', first.id)
    expect(shadowStats().pending).toBe(0)
  })

  test('a different loop may begin while one is pending; each job gets a distinct id', () => {
    resetShadow()
    const main = beginShadow('main', { messageCount: 1 })
    const sub = beginShadow('a1', { messageCount: 1 })
    expect(main.id).not.toBe(sub.id)
    expect(shadowStats().pending).toBe(2)
    endShadow('main', main.id)
    endShadow('a1', sub.id)
    expect(shadowStats().pending).toBe(0)
  })

  test('endShadow with a stale id does nothing: the newer job on the loop stays', () => {
    resetShadow()
    const old = beginShadow('a1', { messageCount: 1 })
    endShadow('a1', old.id)
    const fresh = beginShadow('a1', { messageCount: 1 })
    endShadow('a1', old.id)
    expect(shadowStats().pending).toBe(1)
    endShadow('a1', fresh.id)
    expect(shadowStats().pending).toBe(0)
  })

  test('a job with no handler answers the stub, as shadowStep always did, zero network calls', async () => {
    resetShadow()
    const net = network()
    const job = beginShadow('main', { messageCount: 1 })
    const out = await send(net, { messages: 1 })
    expect(out.status).toBe(200)
    expect(out.text).toContain('message_start')
    expect(out.text).toContain('"input_tokens":0')
    expect(job.body.model).toBe(SHADOW_MODEL)
    expect(net.calls.length).toBe(0)
    endShadow('main', job.id)
  })
})

describe('jobs: the handler answers the captured shadow request', () => {
  test('a matching request calls the handler once and returns its answer, zero network calls', async () => {
    resetShadow()
    const net = network()
    const seen: any[] = []
    const job = beginShadow('main', { messageCount: 1, handler: async body => (seen.push(body), 'SSE-ANSWER') })
    const out = await send(net, { messages: 1 })
    expect(out.status).toBe(200)
    expect(out.ok).toBe(true)
    expect(out.text).toBe('SSE-ANSWER')
    expect(seen.length).toBe(1)
    expect(seen[0].model).toBe(SHADOW_MODEL)
    expect(job.phase).toBe('captured')
    // A second request of the same loop is refused and the handler is not called again.
    const again = await send(net, { messages: 1 })
    expect(again.status).toBe(400)
    expect(seen.length).toBe(1)
    expect(net.calls.length).toBe(0)
    endShadow('main', job.id)
  })

  test('a handler that rejects gives a local refusal, never next, and is called once', async () => {
    resetShadow()
    const net = network()
    let calls = 0
    const job = beginShadow('main', {
      messageCount: 1,
      handler: async () => {
        calls++
        throw new Error('handler failed')
      },
    })
    const out = await send(net, { messages: 1 })
    expect(out.status).toBe(400)
    expect(out.headers['x-should-retry']).toBe('false')
    expect(calls).toBe(1)
    expect(net.calls.length).toBe(0)
    expect(shadowStats().shadowRefused).toBe(1)
    endShadow('main', job.id)
  })

  test('a handler that throws synchronously gives the same local refusal', async () => {
    resetShadow()
    const net = network()
    const job = beginShadow('main', {
      messageCount: 1,
      handler: (() => {
        throw new Error('sync failure')
      }) as any,
    })
    const out = await send(net, { messages: 1 })
    expect(out.status).toBe(400)
    expect(net.calls.length).toBe(0)
    endShadow('main', job.id)
  })

  test('the handler is not called for an inconsistent request: refused, zero network calls', async () => {
    resetShadow()
    const net = network()
    let calls = 0
    const job = beginShadow('main', {
      messageCount: 1,
      handler: async () => {
        calls++
        return 'SSE'
      },
    })
    const out = await send(net, { messages: 3 })
    expect(out.status).toBe(400)
    expect(calls).toBe(0)
    expect(job.phase).toBe('registered')
    expect(net.calls.length).toBe(0)
    endShadow('main', job.id)
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
    expect(result.answer).toContain('[provider-router] openai error: shadow request failed')
  })
})

// ---------------------------------------------------------------------------
// Unconditional refusals (shadow model, prefixed model ids) and the auto-mode
// classifier exception. Request shapes as recorded in docs/design-notes.md,
// "Answer in place: spike" (Claude Code 2.1.325); header values that may hold
// a credential are not recorded, so none appear here.

const CLASSIFIER_BETA = 'claude-code-20250219,auto-mode-classifier-2026-07-16,claude-code-side-query-2026-09-29'

// An engine request with `body` (an object, sent as JSON) and extra headers.
function engineReq(body: unknown, over: { headers?: Record<string, string>; url?: string; method?: string; agent?: string } = {}): any {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-1', ...over.headers }
  if (over.agent) headers['x-claude-code-agent-id'] = over.agent
  return { url: over.url ?? URL, init: { method: over.method ?? 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) } }
}

const CLASSIFIER_SYSTEM = [{ type: 'text', text: 'You are a security monitor for autonomous AI coding agents.' }]
const TRANSCRIPT = [{ role: 'user', content: '<transcript>user: run the tests\nBash: npm test</transcript>' }]

// Stage 1: a short severity verdict.
const STAGE1 = { max_tokens: 64, messages: TRANSCRIPT, metadata: { user_id: 'u' }, model: 'claude-sonnet-5', stop_sequences: ['</severity>'], system: CLASSIFIER_SYSTEM, thinking: { type: 'disabled' } }
// Stage 2, after stage 1 flagged the call: no stop sequences, a long answer.
const { stop_sequences: _s, ...STAGE2_BASE } = STAGE1
const STAGE2 = { ...STAGE2_BASE, max_tokens: 8192 }
const CLASSIFIER_HEADERS = { 'anthropic-beta': CLASSIFIER_BETA, 'x-stainless-timeout': '60' }

const classifier = (body: unknown = STAGE1, over: { headers?: Record<string, string>; url?: string; method?: string; agent?: string } = {}) =>
  engineReq(body, { ...over, headers: { ...CLASSIFIER_HEADERS, ...over.headers } })

// A conversation request (thread create) as the engine sends it.
const CONVERSATION = {
  context_management: {},
  diagnostics: {},
  max_tokens: 32000,
  messages: [{ role: 'user', content: 'hi' }],
  metadata: { user_id: 'u' },
  model: 'claude-sonnet-5',
  output_config: {},
  stream: true,
  system: [{ type: 'text', text: 'SYS' }],
  thinking: { type: 'adaptive' },
  thread: { type: 'create' },
  tools: [{ name: 'Read', description: 'd', input_schema: { type: 'object' } }],
}
const { thread: _t, ...CONVERSATION_NO_THREAD } = CONVERSATION

// Sends `ev` through shadowFetch with the host-set origin `plugin`.
async function fetchVia(net: ReturnType<typeof network>, ev: any, opts = ON, plugin = 'engine'): Promise<any> {
  const out: any = await shadowFetch(ev, nextFrom(net, plugin), opts)
  return out.value
}

const passed = (r: any) => r.text === '{"network":true}'
const refused = (r: any) => r.status === 400 && r.headers['x-should-retry'] === 'false'

// Runs `body` with a job pending on `loops` (none by default), then ends them.
async function withJobs<T>(loops: string[], body: () => Promise<T>): Promise<T> {
  const jobs = loops.map(k => [k, beginShadow(k, { messageCount: 1 })] as const)
  try {
    return await body()
  } finally {
    for (const [k, j] of jobs) endShadow(k, j.id)
  }
}

describe('unconditional refusal: router-prefixed model ids never reach the first-party host', () => {
  const PREFIXED = ['custom:x:y', 'anthropic:claude-fable-5-2', 'zai:glm-5.3', 'openai:gpt-5']
  const MALFORMED = ['openai:', 'custom:gw', 'custom:gw:', 'zai:', 'anthropic:']

  for (const jobs of [[], ['main'], ['a1']]) {
    const label = jobs.length ? `with a job pending on ${jobs[0]}` : 'with no job pending'

    test(`an engine request naming a prefixed model is refused, ${label}, zero network calls`, async () => {
      resetShadow()
      const net = network()
      await withJobs(jobs, async () => {
        for (const model of PREFIXED) {
          expect(refused(await fetchVia(net, engineReq({ ...CONVERSATION, model })))).toBe(true)
          // Also under the classifier's own shape and marker (its retry).
          expect(refused(await fetchVia(net, classifier({ ...STAGE1, model })))).toBe(true)
        }
      })
      expect(net.calls.length).toBe(0)
    })

    test(`a malformed prefix is refused, ${label}, zero network calls`, async () => {
      resetShadow()
      const net = network()
      await withJobs(jobs, async () => {
        for (const model of MALFORMED) {
          expect(refused(await fetchVia(net, engineReq({ ...CONVERSATION, model })))).toBe(true)
          expect(refused(await fetchVia(net, classifier({ ...STAGE1, model })))).toBe(true)
        }
      })
      expect(net.calls.length).toBe(0)
    })

    test(`a prefixed id in the URL is refused, ${label}, zero network calls`, async () => {
      resetShadow()
      const net = network()
      await withJobs(jobs, async () => {
        for (const url of [
          'https://bedrock.example/model/openai:gpt-5/invoke',
          'https://bedrock.example/model/custom%3Agw%3Am/invoke',
          'https://api.anthropic.com/v1/messages?beta=true&model=zai:glm-5.3',
          'https://gw.example/v1/anthropic:claude-x/messages',
        ]) {
          expect(refused(await fetchVia(net, engineReq({ ...CONVERSATION }, { url })))).toBe(true)
          expect(refused(await fetchVia(net, classifier(STAGE1, { url })))).toBe(true)
        }
      })
      expect(net.calls.length).toBe(0)
    })

    test(`an unparseable string body naming a prefixed model is refused, ${label}, zero network calls`, async () => {
      resetShadow()
      const net = network()
      await withJobs(jobs, async () => {
        expect(refused(await fetchVia(net, engineReq('{"model":"custom:gw:m", broken')))).toBe(true)
        expect(refused(await fetchVia(net, engineReq('{"model" : "openai:", broken')))).toBe(true)
      })
      expect(net.calls.length).toBe(0)
    })
  }

  test('an unreadable or unparseable engine body is refused while any job is pending, whatever its loop', async () => {
    resetShadow()
    const net = network()
    await withJobs(['a1'], async () => {
      expect(refused(await fetchVia(net, { url: URL, init: { method: 'POST', headers: { 'x-claude-code-session-id': 's' }, body: { bytes: 'AAAA' } } }))).toBe(true)
      expect(refused(await fetchVia(net, engineReq('not json at all')))).toBe(true)
      expect(refused(await fetchVia(net, classifier('not json at all')))).toBe(true)
    })
    expect(net.calls.length).toBe(0)
  })

  test('the hosts and host names of URLs are not read as prefixes; unprefixed models with a colon pass', async () => {
    resetShadow()
    const net = network()
    // An ANTHROPIC_BASE_URL host that happens to be named like a provider.
    expect(passed(await fetchVia(net, engineReq({ ...CONVERSATION }, { url: 'http://custom:8080/v1/messages' })))).toBe(true)
    expect(passed(await fetchVia(net, engineReq({ ...CONVERSATION }, { url: 'https://api.openai.example/v1/messages' })))).toBe(true)
    expect(passed(await fetchVia(net, engineReq({ ...CONVERSATION, model: 'claude-sonnet-5' })))).toBe(true)
    expect(net.calls.length).toBe(3)
  })

  test("the mod's own provider request (no engine markers, not raised by the engine) keeps its own model, even one with a colon", async () => {
    resetShadow()
    const net = network()
    // custom:gw:openai:gpt-5 sends model "openai:gpt-5" to the custom endpoint.
    const own = { url: 'https://gw.example/v1/chat/completions', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'openai:gpt-5', messages: [] }) } }
    expect(passed(await fetchVia(net, own, ON, 'provider-router'))).toBe(true)
    expect(net.calls.length).toBe(1)
  })

  test('a request raised by the engine counts as an engine request even with its markers stripped', async () => {
    resetShadow()
    const net = network()
    const stripped = { url: URL, init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...CONVERSATION, model: 'custom:x:y' }) } }
    expect(refused(await fetchVia(net, stripped))).toBe(true)
    expect(net.calls.length).toBe(0)
  })
})

describe('the engine sends prefixed requests of its own that bypass turn.step (Task 2): refused with no job pending', () => {
  test('the classifier retry under the session model id (classifier keys, max_tokens 2112, no thinking)', async () => {
    resetShadow()
    const net = network()
    const { thinking: _th, ...rest } = STAGE1
    expect(refused(await fetchVia(net, classifier({ ...rest, model: 'custom:x:y', max_tokens: 2112 })))).toBe(true)
    expect(net.calls.length).toBe(0)
  })

  test('the prompt suggestion (conversation keys under the session model id)', async () => {
    resetShadow()
    const net = network()
    expect(refused(await fetchVia(net, engineReq({ ...CONVERSATION_NO_THREAD, model: 'custom:x:y' }, { headers: { 'anthropic-beta': 'claude-code-20250219' } })))).toBe(true)
    expect(net.calls.length).toBe(0)
  })

  test("the engine's own compaction request (fallbacks, compaction headers)", async () => {
    resetShadow()
    const net = network()
    const compaction = { ...CONVERSATION_NO_THREAD, fallbacks: [{ model: 'claude-sonnet-5' }], model: 'custom:mock:m' }
    expect(refused(await fetchVia(net, engineReq(compaction, { headers: { 'x-cc-compaction-request': 'true', 'x-claude-code-compaction': 'true' } })))).toBe(true)
    expect(net.calls.length).toBe(0)
  })
})

describe('classifier exception: the predicate (pinned by Task 2)', () => {
  test('stage 1 and stage 2 classifier requests reach next exactly once each, with no job pending', async () => {
    resetShadow()
    const net = network()
    expect(passed(await fetchVia(net, classifier(STAGE1)))).toBe(true)
    expect(passed(await fetchVia(net, classifier(STAGE2)))).toBe(true)
    expect(net.calls.length).toBe(2)
    expect(JSON.parse(net.calls[0].init.body).max_tokens).toBe(64)
    expect(JSON.parse(net.calls[1].init.body).max_tokens).toBe(8192)
  })

  test('a classifier request passes with a job pending on the main loop (it carries no agent header)', async () => {
    resetShadow()
    const net = network()
    await withJobs(['main'], async () => {
      expect(passed(await fetchVia(net, classifier(STAGE1)))).toBe(true)
    })
    expect(net.calls.length).toBe(1)
  })

  test('a classifier request passes with a job pending on a subagent loop', async () => {
    resetShadow()
    const net = network()
    await withJobs(['a1'], async () => {
      expect(passed(await fetchVia(net, classifier(STAGE2)))).toBe(true)
    })
    expect(net.calls.length).toBe(1)
  })

  test('with autoModeClassifier false and a routed step seen, a classifier request is refused, zero network calls', async () => {
    resetShadow()
    const net = network()
    noteStep(true)
    expect(refused(await fetchVia(net, classifier(STAGE1), OFF))).toBe(true)
    await withJobs(['main'], async () => {
      expect(refused(await fetchVia(net, classifier(STAGE2), OFF))).toBe(true)
    })
    expect(net.calls.length).toBe(0)
  })

  test('header names are matched in any case; the beta token may carry spaces around it', async () => {
    resetShadow()
    const net = network()
    const ev = engineReq(STAGE1, { headers: { 'Anthropic-Beta': 'claude-code-20250219, auto-mode-classifier-2026-07-16 ,x' } })
    expect(passed(await fetchVia(net, ev))).toBe(true)
    expect(net.calls.length).toBe(1)
  })
})

describe('classifier exception: negatives, each refused with zero network calls while a job is pending on the main loop', () => {
  const cases: [string, () => any, string?][] = [
    ['the marker with a shadow URL', () => classifier(STAGE1, { url: `${URL}&m=${SHADOW_MODEL}` })],
    ['the marker with another host', () => classifier(STAGE1, { url: 'https://api.anthropic.com.example.org/v1/messages?beta=true' })],
    ['the marker with the count_tokens path', () => classifier(STAGE1, { url: 'https://api.anthropic.com/v1/messages/count_tokens?beta=true' })],
    ['the marker without ?beta=true', () => classifier(STAGE1, { url: 'https://api.anthropic.com/v1/messages' })],
    ['the marker with GET', () => classifier(STAGE1, { method: 'GET' })],
    ['the marker with a lower-case method', () => classifier(STAGE1, { method: 'post' })],
    ['the marker with no method (GET by default)', () => {
      const ev = classifier(STAGE1)
      delete ev.init.method
      return ev
    }],
    ['the marker with tools', () => classifier({ ...STAGE1, tools: CONVERSATION.tools })],
    ['the marker with thread create', () => classifier({ ...STAGE1, thread: { type: 'create' } })],
    ['the marker with thread continue', () => classifier({ ...STAGE1, thread: { type: 'continue', previous_message_id: 'msg_1' } })],
    ['the marker with stream', () => classifier({ ...STAGE1, stream: true })],
    ['the marker with safeguards', () => classifier({ ...STAGE1, safeguards: [{ type: 'dangerous_tool_use' }] })],
    ['the marker with output_config', () => classifier({ ...STAGE1, output_config: {} })],
    ['the marker with another key outside the allowlist', () => classifier({ ...STAGE1, fallbacks: [] })],
    ['the marker with an agent header', () => classifier(STAGE1, { agent: 'main' })],
    ['the marker with an empty agent header', () => classifier(STAGE1, { headers: { 'X-Claude-Code-Agent-Id': '' } })],
    ['the marker from a non-engine origin', () => classifier(STAGE1), 'other-plugin'],
    ['the beta only as a substring of another token', () => classifier(STAGE1, { headers: { 'anthropic-beta': 'x-auto-mode-classifier-2026-07-16-y' } })],
    ['the beta with a malformed date', () => classifier(STAGE1, { headers: { 'anthropic-beta': 'auto-mode-classifier-2026-7-16' } })],
    ['the beta under two header keys', () => classifier(STAGE1, { headers: { 'Anthropic-Beta': 'claude-code-20250219' } })],
    ['no classifier beta', () => classifier(STAGE1, { headers: { 'anthropic-beta': 'claude-code-20250219,claude-code-side-query-2026-09-29' } })],
    ['the marker with an empty model', () => classifier({ ...STAGE1, model: '' })],
    ['the marker with a non-string model', () => classifier({ ...STAGE1, model: ['claude-sonnet-5'] })],
    ['the marker with a bare provider name as model', () => classifier({ ...STAGE1, model: 'openai' })],
    ['the marker with a JSON array body', () => classifier([STAGE1])],
    ['the marker with a non-string body', () => {
      const ev = classifier(STAGE1)
      ev.init.body = { ...STAGE1 }
      return ev
    }],
    ['an ordinary conversation request rewritten to a real model id, marker added', () => classifier({ ...CONVERSATION, model: 'claude-sonnet-5' })],
    ['a retry of the conversation with a real model id and no marker', () => engineReq({ ...CONVERSATION_NO_THREAD, model: 'claude-sonnet-5' })],
    ['the recorded session-title request', () => engineReq({ max_tokens: 512, messages: TRANSCRIPT, metadata: { user_id: 'u' }, model: 'claude-haiku-5-5', output_config: {}, stream: true, system: [{ type: 'text', text: 'title' }], tools: [] }, { headers: { 'anthropic-beta': 'claude-code-20250219,claude-code-side-query-2026-09-29' } })],
  ]
  for (const [name, make, origin] of cases) {
    test(name, async () => {
      resetShadow()
      const net = network()
      await withJobs(['main'], async () => {
        expect(refused(await fetchVia(net, make(), ON, origin ?? 'engine'))).toBe(true)
      })
      expect(net.calls.length).toBe(0)
    })
  }
})

describe('classifier exception: the shadow model under the classifier shape stays with rule 1', () => {
  test('answered locally (the one match, or refused), never passed, zero network calls', async () => {
    resetShadow()
    const net = network()
    await withJobs(['main'], async () => {
      // Consistent with the main job: the strict match answers it locally.
      expect(passed(await fetchVia(net, classifier({ ...STAGE1, model: SHADOW_MODEL })))).toBe(false)
      // Any further one, and one for a loop with no job: refused.
      expect(refused(await fetchVia(net, classifier({ ...STAGE1, model: SHADOW_MODEL })))).toBe(true)
    })
    expect(refused(await fetchVia(net, classifier({ ...STAGE1, model: SHADOW_MODEL })))).toBe(true)
    expect(net.calls.length).toBe(0)
  })
})

describe('session flags: routedSeen and stepSeen', () => {
  test('both false after resetShadow (a module reload)', () => {
    resetShadow()
    noteStep(true)
    expect(sessionFlags()).toEqual({ routedSeen: true, stepSeen: true })
    resetShadow()
    expect(sessionFlags()).toEqual({ routedSeen: false, stepSeen: false })
  })

  test('an unprefixed step sets stepSeen only; a routed step sets both; an unprefixed step never clears routedSeen', () => {
    resetShadow()
    noteStep(false)
    expect(sessionFlags()).toEqual({ routedSeen: false, stepSeen: true })
    noteStep(true)
    expect(sessionFlags()).toEqual({ routedSeen: true, stepSeen: true })
    noteStep(false)
    expect(sessionFlags()).toEqual({ routedSeen: true, stepSeen: true })
  })
})

describe('reload rule: with the opt-out a fresh module refuses until it has seen a step', () => {
  test('autoModeClassifier false: refused while stepSeen is false, zero network calls', async () => {
    resetShadow()
    const net = network()
    expect(refused(await fetchVia(net, classifier(STAGE1), OFF))).toBe(true)
    expect(net.calls.length).toBe(0)
  })

  test('autoModeClassifier false: passes as ordinary traffic once only unprefixed steps were seen', async () => {
    resetShadow()
    const net = network()
    noteStep(false)
    expect(passed(await fetchVia(net, classifier(STAGE1), OFF))).toBe(true)
    expect(net.calls.length).toBe(1)
    // As ordinary traffic, a job pending on its loop (main) still refuses it.
    await withJobs(['main'], async () => {
      expect(refused(await fetchVia(net, classifier(STAGE1), OFF))).toBe(true)
    })
    expect(net.calls.length).toBe(1)
  })

  test('a missing options object counts as the opt-out (refused), in the hook and in its .catch, zero network calls', async () => {
    resetShadow()
    const net = network()
    expect(refused(await fetchVia(net, classifier(STAGE1), null as any))).toBe(true)
    const out: any = await shadowFetchFailed(classifier(STAGE1), Object.assign(nextFrom(net, 'engine'), { called: false }), null as any)
    expect(refused(out.value)).toBe(true)
    expect(net.calls.length).toBe(0)
  })

  test('autoModeClassifier true: passes with no step seen', async () => {
    resetShadow()
    const net = network()
    expect(passed(await fetchVia(net, classifier(STAGE1), ON))).toBe(true)
    expect(net.calls.length).toBe(1)
  })
})

describe('http.fetch .catch with the classifier exception', () => {
  // `next` of a .catch: the network beneath, the host-set origin, whether the
  // hook had already passed the request on, and why it failed.
  const caughtFrom = (net: ReturnType<typeof network>, called: boolean, kind: 'throw' | 'timeout' = 'throw', plugin = 'engine') =>
    Object.assign(nextFrom(net, plugin), { called, error: { kind, budget: 100 } })

  // A classifier request whose `anthropic-beta` header throws when read: the
  // predicate is the only reader of that header, so a throw (or the counter)
  // shows the predicate was evaluated.
  function trapped() {
    const ev = classifier(STAGE1)
    const reads = { n: 0 }
    const headers: Record<string, string> = { ...ev.init.headers }
    delete headers['anthropic-beta']
    Object.defineProperty(headers, 'anthropic-beta', {
      enumerable: true,
      get() {
        reads.n++
        throw new Error('predicate failed')
      },
    })
    ev.init.headers = headers
    return { ev, reads }
  }

  test('with next.called false and a job pending, a request that would match the predicate is refused, zero forwards', async () => {
    resetShadow()
    const net = network()
    await withJobs(['main'], async () => {
      const out: any = await shadowFetchFailed(classifier(STAGE1), caughtFrom(net, false), ON)
      expect(refused(out.value)).toBe(true)
    })
    await withJobs(['a1'], async () => {
      const out: any = await shadowFetchFailed(classifier(STAGE2), caughtFrom(net, false), ON)
      expect(refused(out.value)).toBe(true)
    })
    expect(net.calls.length).toBe(0)
  })

  test('with next.called true it is replayed', async () => {
    resetShadow()
    const net = network()
    await withJobs(['main'], async () => {
      const out: any = await shadowFetchFailed(classifier(STAGE1), caughtFrom(net, true), ON)
      expect(passed(out.value)).toBe(true)
    })
    expect(net.calls.length).toBe(1)
  })

  test('a predicate that throws fails the hook; the .catch then refuses with a job pending, zero forwards', async () => {
    resetShadow()
    const net = network()
    await withJobs(['main'], async () => {
      const { ev } = trapped()
      let err: unknown
      try {
        await shadowFetch(ev, nextFrom(net, 'engine'), ON)
      } catch (x) {
        err = x
      }
      expect(String(err)).toContain('predicate failed')
      const out: any = await shadowFetchFailed(ev, caughtFrom(net, false), ON)
      expect(refused(out.value)).toBe(true)
    })
    expect(net.calls.length).toBe(0)
  })

  test('prefixed ids and the shadow model are refused by the .catch with no job pending', async () => {
    resetShadow()
    const net = network()
    for (const ev of [
      classifier({ ...STAGE1, model: 'custom:x:y' }),
      engineReq({ ...CONVERSATION, model: 'openai:' }),
      engineReq({ ...CONVERSATION }, { url: 'https://bedrock.example/model/zai:glm/invoke' }),
      engineReq('{"model":"anthropic:claude-x", broken'),
      engineReq({ ...CONVERSATION, model: SHADOW_MODEL }),
    ]) {
      const out: any = await shadowFetchFailed(ev, caughtFrom(net, false), ON)
      expect(refused(out.value)).toBe(true)
    }
    expect(net.calls.length).toBe(0)
  })

  test('autoModeClassifier false, no job: an unforwarded engine request is refused when routedSeen, zero forwards', async () => {
    resetShadow()
    const net = network()
    noteStep(true)
    for (const kind of ['throw', 'timeout'] as const) {
      for (const ev of [classifier(STAGE1), engineReq({ ...CONVERSATION_NO_THREAD, model: 'claude-sonnet-5' })]) {
        const out: any = await shadowFetchFailed(ev, caughtFrom(net, false, kind), OFF)
        expect(refused(out.value)).toBe(true)
      }
      const t = trapped()
      const out: any = await shadowFetchFailed(t.ev, caughtFrom(net, false, kind), OFF)
      expect(refused(out.value)).toBe(true)
      expect(t.reads.n).toBe(0)
    }
    expect(net.calls.length).toBe(0)
  })

  test('autoModeClassifier false, no job: an unforwarded engine request is refused while stepSeen is false, zero forwards', async () => {
    resetShadow()
    const net = network()
    for (const kind of ['throw', 'timeout'] as const) {
      const out: any = await shadowFetchFailed(classifier(STAGE1), caughtFrom(net, false, kind), OFF)
      expect(refused(out.value)).toBe(true)
      const t = trapped()
      const trappedOut: any = await shadowFetchFailed(t.ev, caughtFrom(net, false, kind), OFF)
      expect(refused(trappedOut.value)).toBe(true)
      expect(t.reads.n).toBe(0)
    }
    // Raised by the engine with the markers stripped: still an engine request.
    const stripped = classifier(STAGE1)
    delete stripped.init.headers['x-claude-code-session-id']
    expect(refused(((await shadowFetchFailed(stripped, caughtFrom(net, false), OFF)) as any).value)).toBe(true)
    expect(net.calls.length).toBe(0)
  })

  test('autoModeClassifier false, only unprefixed steps seen, no job: forwarded (ordinary traffic); the predicate is not evaluated', async () => {
    resetShadow()
    const net = network()
    noteStep(false)
    const t = trapped()
    const out: any = await shadowFetchFailed(t.ev, caughtFrom(net, false), OFF)
    expect(passed(out.value)).toBe(true)
    expect(t.reads.n).toBe(0)
    expect(net.calls.length).toBe(1)
  })

  test('autoModeClassifier true, no job: the .catch never evaluates the predicate (it neither grants nor checks the exception)', async () => {
    resetShadow()
    const net = network()
    const t = trapped()
    const out: any = await shadowFetchFailed(t.ev, caughtFrom(net, false, 'timeout'), ON)
    expect(passed(out.value)).toBe(true)
    expect(t.reads.n).toBe(0)
    expect(net.calls.length).toBe(1)
  })

  test("the mod's own request (not an engine request) is not refused by the opt-out rule", async () => {
    resetShadow()
    const net = network()
    noteStep(true)
    const own = { url: 'https://api.openai.com/v1/chat/completions', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"gpt-5"}' } }
    const out: any = await shadowFetchFailed(own, caughtFrom(net, false, 'throw', 'provider-router'), OFF)
    expect(passed(out.value)).toBe(true)
    expect(net.calls.length).toBe(1)
  })

  test('a .catch that cannot read the request refuses it', async () => {
    resetShadow()
    const net = network()
    const bad: any = { get url(): string {
      throw new Error('unreadable')
    }, init: { method: 'POST', headers: {}, body: '{}' } }
    const out: any = await shadowFetchFailed(bad, caughtFrom(net, false), ON)
    expect(refused(out.value)).toBe(true)
    expect(net.calls.length).toBe(0)
  })
})

describe('the router-prefix check agrees with route.ts', () => {
  test('every prefix ID_FORMS names is refused, bare or with an id', async () => {
    resetShadow()
    const net = network()
    const prefixes = [...ID_FORMS.matchAll(/\b([a-z]+):</g)].map(m => m[1]!)
    expect(prefixes.sort()).toEqual(['anthropic', 'custom', 'openai', 'zai'])
    for (const p of prefixes) {
      expect(classifyModel(`${p}:a:b`).kind).not.toBe('unprefixed')
      expect(refused(await fetchVia(net, engineReq({ ...CONVERSATION, model: `${p}:a:b` })))).toBe(true)
      // A bare provider name is no classifier model either.
      expect(refused(await withJobs(['main'], () => fetchVia(net, classifier({ ...STAGE1, model: p }))))).toBe(true)
    }
    expect(net.calls.length).toBe(0)
  })
})
