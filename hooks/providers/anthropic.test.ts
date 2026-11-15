import { describe, expect, test } from 'claude-code/testing'
import { ANTHROPIC_ROWS, ANTHROPIC_VERSION, complete, parseMessage } from './anthropic.ts'
import { routedStep } from '../register.ts'
import { SHADOW_MODEL, resetShadow, shadowFetch, shadowStats } from '../shadow.ts'

// The test kit refuses `$.http.fetch` from a test's own hooks, so the adapter
// takes a fetch function and the tests pass a counting stand-in for the
// network. No live provider is ever called.

const KEY = 'sk-ant-test-KEY-0123456789abcdef'
const ZKEY = 'zai-test-key-abcdef0123456789.XYZsecret99'

type Answer = { status: number; text: string }

function provider(answers: Answer[] | ((url: string, init: any) => Answer)) {
  const calls: { url: string; init: any }[] = []
  const fetch = async (url: string, init: any) => {
    calls.push({ url, init })
    const a = typeof answers === 'function' ? answers(url, init) : (answers[calls.length - 1] ?? answers[answers.length - 1]!)
    return { status: a.status, ok: a.status >= 200 && a.status < 300, headers: { 'content-type': 'application/json' }, text: a.text }
  }
  return { calls, fetch }
}

const REQ = {
  model: 'claude-sonnet-4-5',
  max_tokens: 64000,
  system: [{ type: 'text', text: 'SYS' }],
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
}

const OK_TEXT = JSON.stringify({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-5-20250929',
  content: [
    { type: 'thinking', thinking: 'hidden', signature: 'sig' },
    { type: 'text', text: 'Hello there' },
  ],
  stop_reason: 'end_turn',
  usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 },
})

const TOOL_TEXT = JSON.stringify({
  type: 'message',
  model: 'claude-sonnet-4-5',
  content: [
    { type: 'text', text: 'Running it.' },
    { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 20, output_tokens: 9 },
})

describe('anthropic adapter', () => {
  test('success: POST <base>/v1/messages with version and x-api-key; reply parsed, thinking dropped', async () => {
    const p = provider([{ status: 200, text: OK_TEXT }])
    const r = await complete(p.fetch, REQ, ANTHROPIC_ROWS.anthropic, KEY)
    expect(p.calls.length).toBe(1)
    const { url, init } = p.calls[0]!
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.method).toBe('POST')
    expect(init.headers['anthropic-version']).toBe(ANTHROPIC_VERSION)
    expect(init.headers['x-api-key']).toBe(KEY)
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.headers.authorization).toBeUndefined()
    // Never the session's own credential, never compressed like an engine request.
    expect(init.auth).toBeUndefined()
    expect(init.compress).toBeUndefined()
    const sent = JSON.parse(init.body)
    expect(sent).toEqual(REQ)
    expect(sent.stream).toBeUndefined()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.reply.content).toEqual([{ type: 'text', text: 'Hello there' }])
    expect(r.reply.stopReason).toBe('end_turn')
    expect(r.reply.model).toBe('claude-sonnet-4-5-20250929')
    expect(r.reply.usage).toEqual({ input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 })
  })

  test('tool_use reply: blocks kept in order, missing cache usage reads 0', async () => {
    const p = provider([{ status: 200, text: TOOL_TEXT }])
    const r = await complete(p.fetch, REQ, ANTHROPIC_ROWS.anthropic, KEY)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.reply.content).toEqual([
      { type: 'text', text: 'Running it.' },
      { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' } },
    ])
    expect(r.reply.stopReason).toBe('tool_use')
    expect(r.reply.usage).toEqual({ input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  })

  test('401: clear error, refusal stop, the key never echoed', async () => {
    const p = provider([{ status: 401, text: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } }) }])
    const r = await complete(p.fetch, REQ, ANTHROPIC_ROWS.anthropic, KEY)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.text).toContain('[provider-router] anthropic error 401: authentication failed')
    expect(r.error.text).not.toContain(KEY)
    expect(r.error.stopReason).toBe('refusal')
  })

  test('429 rate limit', async () => {
    const p = provider([{ status: 429, text: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' } }) }])
    const r = await complete(p.fetch, REQ, ANTHROPIC_ROWS.anthropic, KEY)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.text).toContain('error 429: rate limited or out of quota: Number of requests')
  })

  test('5xx: 500 and 529', async () => {
    const p = provider([
      { status: 500, text: JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Internal server error' } }) },
      { status: 529, text: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }) },
    ])
    const a = await complete(p.fetch, REQ, ANTHROPIC_ROWS.anthropic, KEY)
    const b = await complete(p.fetch, REQ, ANTHROPIC_ROWS.anthropic, KEY)
    expect(!a.ok && a.error.text.includes('error 500: provider internal error')).toBe(true)
    expect(!b.ok && b.error.text.includes('error 529: provider overloaded: Overloaded')).toBe(true)
  })

  test('context-length 400 stops with model_context_window_exceeded', async () => {
    const p = provider([{ status: 400, text: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } }) }])
    const r = await complete(p.fetch, REQ, ANTHROPIC_ROWS.anthropic, KEY)
    expect(!r.ok && r.error.stopReason).toBe('model_context_window_exceeded')
  })

  test('a 200 that is not a message is an error, not a crash', async () => {
    const p = provider([{ status: 200, text: '<html>gateway</html>' }])
    const r = await complete(p.fetch, REQ, ANTHROPIC_ROWS.anthropic, KEY)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.text).toContain('[provider-router] anthropic error')
    expect(r.error.text).toContain('unreadable reply')
  })
})

describe('parseMessage', () => {
  test('empty text blocks are dropped (never stored in the thread, which Anthropic would reject)', () => {
    const r = parseMessage(JSON.stringify({ content: [{ type: 'text', text: '' }, { type: 'tool_use', id: 'c1', name: 'Bash', input: {} }], stop_reason: 'tool_use' }), 'm')!
    expect(r.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'Bash', input: {} }])
  })

  test('stop_reason tool_use without a tool block ends the turn', () => {
    expect(parseMessage(JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'tool_use' }), 'm')!.stopReason).toBe('end_turn')
  })
})

describe('zai row', () => {
  test('Bearer header, Z.ai base URL, no x-api-key', async () => {
    const p = provider([{ status: 200, text: OK_TEXT }])
    const r = await complete(p.fetch, { ...REQ, model: 'glm-5.3' }, ANTHROPIC_ROWS.zai, ZKEY)
    expect(r.ok).toBe(true)
    const { url, init } = p.calls[0]!
    expect(url).toBe('https://api.z.ai/api/anthropic/v1/messages')
    expect(init.headers.authorization).toBe(`Bearer ${ZKEY}`)
    expect(init.headers['x-api-key']).toBeUndefined()
    expect(init.headers['anthropic-version']).toBe(ANTHROPIC_VERSION)
    expect(JSON.parse(init.body).model).toBe('glm-5.3')
  })

  test('Z.ai error bodies (error.code/message and code/msg) read cleanly; the key never echoed', async () => {
    const p = provider([
      { status: 429, text: JSON.stringify({ error: { code: '1113', message: 'Insufficient balance or no resource package' } }) },
      { status: 401, text: JSON.stringify({ code: 1000, msg: `Authentication failed for ${ZKEY}`, success: false }) },
    ])
    const a = await complete(p.fetch, REQ, ANTHROPIC_ROWS.zai, ZKEY)
    const b = await complete(p.fetch, REQ, ANTHROPIC_ROWS.zai, ZKEY)
    expect(!a.ok && a.error.text).toBe('[provider-router] zai error 429: rate limited or out of quota: Insufficient balance or no resource package')
    expect(!b.ok && b.error.text.startsWith('[provider-router] zai error 401: authentication failed')).toBe(true)
    expect(!b.ok && b.error.text.includes(ZKEY)).toBe(false)
    expect(!b.ok && b.error.text.includes('XYZsecret99')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Routed step: shadow capture, then the adapter, through routedStep.

const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Engine stand-in: sends the shadow request through the mod's shadowFetch
// (the network beneath counts calls and must stay at 0), then yields a chunk
// that must never reach the caller.
function engine() {
  const network: any[] = []
  const seen: any[] = []
  const next = async function* (e: any): AsyncGenerator<any, any> {
    seen.push(e)
    const headers: Record<string, string> = { 'x-claude-code-session-id': 's1' }
    if (e.agentId) headers['x-claude-code-agent-id'] = e.agentId
    const body = {
      model: e.model,
      system: [{ type: 'text', text: 'CAPTURED-SYS' }],
      tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'list files' }],
      max_tokens: 32000,
      metadata: { user_id: 'u' },
      thinking: { type: 'adaptive' },
      stream: true,
    }
    await shadowFetch({ url: 'https://api.anthropic.com/v1/messages', init: { method: 'POST', headers, compress: 'gzip', body: JSON.stringify(body) } }, (x: any) => {
      network.push(x)
      return { value: { status: 200, ok: true, headers: {}, text: '' } }
    })
    yield { kind: 'text', index: 0, text: 'ENGINE-STUB-CHUNK' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: ZERO }
    return { turnId: e.turnId, index: e.index, answer: 'ENGINE-STUB-CHUNK', toolUses: [] }
  }
  return { network, seen, next }
}

function sleeper() {
  const calls: { ms: number; signal?: AbortSignal }[] = []
  let fire: (() => void) | undefined
  const sleep = (ms: number, o?: { signal?: AbortSignal }) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ ms, signal: o?.signal })
      fire = resolve
      o?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
  return { calls, sleep, fire: () => fire?.() }
}

async function drain(g: AsyncGenerator<any, any>) {
  const chunks: any[] = []
  let s = await g.next()
  while (!s.done) {
    chunks.push(s.value)
    s = await g.next()
  }
  return { chunks, result: s.value }
}

async function tick() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const CFG = (keys: Record<string, string>) => ({ keys, custom: new Map(), contextWindows: new Map(), warnings: [] }) as any
const step = (model: string, over: any = {}) => ({ turnId: 't1', index: 0, model, messageCount: 3, effort: 'high', ...over })

describe('routed step: anthropic and zai', () => {
  test('anthropic: captured request goes to the Platform; reply streamed as chunks; no shadow on the network', async () => {
    resetShadow()
    const eng = engine()
    const p = provider([{ status: 200, text: TOOL_TEXT }])
    const s = sleeper()
    const io = { fetch: p.fetch, sleep: s.sleep, signal: new AbortController().signal }
    const { chunks, result } = await drain(routedStep(step('anthropic:claude-sonnet-4-5'), eng.next, { provider: 'anthropic', model: 'claude-sonnet-4-5' }, CFG({ anthropic: KEY }), io, new Map()))
    expect(eng.seen[0].model).toBe(SHADOW_MODEL)
    expect(eng.network.length).toBe(0)
    expect(p.calls.length).toBe(1)
    const sent = JSON.parse(p.calls[0]!.init.body)
    expect(sent.model).toBe('claude-sonnet-4-5')
    expect(sent.system).toEqual([{ type: 'text', text: 'CAPTURED-SYS' }])
    expect(sent.tools[0].name).toBe('Bash')
    expect(sent.max_tokens).toBe(64000)
    expect(sent.metadata).toBeUndefined()
    expect(sent.thinking).toBeUndefined()
    expect(sent.stream).toBeUndefined()
    expect(JSON.stringify(chunks)).not.toContain('ENGINE-STUB-CHUNK')
    expect(chunks.map(c => c.kind)).toEqual(['text', 'tool', 'input', 'stop'])
    expect(result.toolUses).toEqual([{ name: 'Bash', input: { command: 'ls' } }])
    expect(result.stopReason).toBe('tool_use')
    expect(result.usage.input_tokens).toBe(20)
    // The timer was started and stopped once the reply won.
    expect(s.calls.length).toBe(1)
    await tick()
    expect(s.calls[0]!.signal?.aborted).toBe(true)
    expect(shadowStats()).toEqual({ shadowLeaks: 0, shadowRefused: 0, pending: 0 })
  })

  test('zai: Bearer key, Z.ai URL, subagent loop', async () => {
    resetShadow()
    const eng = engine()
    const p = provider([{ status: 200, text: OK_TEXT }])
    const io = { fetch: p.fetch, sleep: sleeper().sleep, signal: new AbortController().signal }
    const { chunks, result } = await drain(routedStep(step('zai:glm-5.3', { agentId: 'sub-7' }), eng.next, { provider: 'zai', model: 'glm-5.3' }, CFG({ zai: ZKEY }), io, new Map()))
    expect(eng.network.length).toBe(0)
    expect(p.calls[0]!.url).toBe('https://api.z.ai/api/anthropic/v1/messages')
    expect(p.calls[0]!.init.headers.authorization).toBe(`Bearer ${ZKEY}`)
    expect(JSON.parse(p.calls[0]!.init.body).model).toBe('glm-5.3')
    expect(chunks[0]).toEqual({ kind: 'text', index: 0, text: 'Hello there' })
    expect(result.answer).toBe('Hello there')
  })

  test('missing key: error names the env variable and /config field; no shadow, no provider call', async () => {
    resetShadow()
    const eng = engine()
    const p = provider([{ status: 200, text: OK_TEXT }])
    const io = { fetch: p.fetch, sleep: sleeper().sleep, signal: new AbortController().signal }
    const { chunks, result } = await drain(routedStep(step('anthropic:claude-opus-4-6'), eng.next, { provider: 'anthropic', model: 'claude-opus-4-6' }, CFG({}), io, new Map()))
    expect(eng.seen.length).toBe(0)
    expect(p.calls.length).toBe(0)
    expect(chunks[0].text).toContain('ROUTER_ANTHROPIC_API_KEY')
    expect(chunks[0].text).toContain('anthropicApiKey')
    expect(result.stopReason).toBe('refusal')
  })

  test('provider 401: prefixed error text, key stripped', async () => {
    resetShadow()
    const p = provider([{ status: 401, text: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `bad key ${KEY}` } }) }])
    const io = { fetch: p.fetch, sleep: sleeper().sleep, signal: new AbortController().signal }
    const { chunks, result } = await drain(routedStep(step('anthropic:claude-haiku-4-5'), engine().next, { provider: 'anthropic', model: 'claude-haiku-4-5' }, CFG({ anthropic: KEY }), io, new Map()))
    expect(result.answer.startsWith('[provider-router] anthropic error 401')).toBe(true)
    expect(JSON.stringify(chunks)).not.toContain(KEY)
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  test('network failure: error reply with the cause, key stripped', async () => {
    resetShadow()
    const fetch = async () => {
      throw new Error(`connect ECONNREFUSED (auth ${KEY})`)
    }
    const io = { fetch, sleep: sleeper().sleep, signal: new AbortController().signal }
    const { result } = await drain(routedStep(step('anthropic:claude-haiku-4-5'), engine().next, { provider: 'anthropic', model: 'claude-haiku-4-5' }, CFG({ anthropic: KEY }), io, new Map()))
    expect(result.answer).toContain('[provider-router] anthropic error')
    expect(result.answer).toContain('ECONNREFUSED')
    expect(result.answer).not.toContain(KEY)
    expect(result.stopReason).toBe('refusal')
  })

  test('timeout: the error reply says it timed out', async () => {
    resetShadow()
    const s = sleeper()
    const fetch = () => new Promise<any>(() => {})
    const io = { fetch, sleep: s.sleep, signal: new AbortController().signal, timeoutMs: 1234 }
    const g = routedStep(step('zai:glm-5.3'), engine().next, { provider: 'zai', model: 'glm-5.3' }, CFG({ zai: ZKEY }), io, new Map())
    const pending = drain(g)
    for (let i = 0; i < 10 && !s.calls.length; i++) await tick()
    expect(s.calls[0]!.ms).toBe(1234)
    s.fire()
    const { chunks, result } = await pending
    expect(chunks[0].text).toBe('[provider-router] zai error: no reply within 1234 ms (timed out)')
    expect(result.stopReason).toBe('refusal')
  })

  test('Esc before the reply: the step ends cleanly with no chunks and no error text', async () => {
    resetShadow()
    const s = sleeper()
    const ctl = new AbortController()
    const fetch = () => new Promise<any>(() => {})
    const io = { fetch, sleep: s.sleep, signal: ctl.signal }
    const pending = drain(routedStep(step('anthropic:claude-haiku-4-5'), engine().next, { provider: 'anthropic', model: 'claude-haiku-4-5' }, CFG({ anthropic: KEY }), io, new Map()))
    for (let i = 0; i < 10 && !s.calls.length; i++) await tick()
    ctl.abort()
    const { chunks, result } = await pending
    expect(chunks).toEqual([])
    expect(result.answer).toBe('')
    expect(result.toolUses).toEqual([])
    expect(result.stopReason).toBe(null)
    expect(result.usage).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Through the plugin: `$.turn.step` with the mod loaded. The test kit runs
// the mod in its own module instance and refuses `$.http.fetch` from the
// test's hooks, so a test engine cannot hand the mod a shadow request; the
// success path is covered through routedStep above. Here: the key comes from
// env through `register`, the provider row is picked, and nothing reaches
// the network.

// No resetShadow() here: the kit runs the mod in its own module instance, so
// this file's shadow state is not the mod's.
function pluginEnv($: any, on: any, envName: string | undefined, key: string) {
  on('clock.sleep', () => ({ value: undefined }) as any)
  on('env.get', (_$: any, e: any) => ({ value: e.name === envName ? key : undefined }) as any)
  const net: any[] = []
  on('http.fetch', (_$: any, e: any) => {
    net.push(e)
    return { value: { status: 200, ok: true, headers: {}, text: OK_TEXT } }
  })
  const seen: any[] = []
  on('turn.step', async function* (_$: any, e: any) {
    seen.push(e)
    yield { kind: 'text', index: 0, text: 'ENGINE-STUB-CHUNK' } as any
    yield { kind: 'stop', stopReason: 'end_turn', usage: ZERO } as any
    return { turnId: e.turnId, index: e.index, answer: 'ENGINE-STUB-CHUNK', toolUses: [] } as any
  } as any)
  return { net, seen }
}

describe('through the plugin', () => {
  for (const [model, envName, key] of [
    ['anthropic:claude-sonnet-4-5', 'ROUTER_ANTHROPIC_API_KEY', KEY],
    ['zai:glm-5.3', 'ZAI_API_KEY', ZKEY],
  ] as const) {
    const provider = model.slice(0, model.indexOf(':'))
    test(`${provider}: key from env reaches the routed step; shadow model sent to the engine; nothing on the network`, async ($, on) => {
      const t = pluginEnv($, on, envName, key)
      const { chunks, result } = await drain($.turn.step(step(model)) as any)
      expect(t.seen.length).toBe(1)
      expect(t.seen[0].model).toBe(SHADOW_MODEL)
      expect(t.net.length).toBe(0)
      expect(JSON.stringify(chunks)).not.toContain('ENGINE-STUB-CHUNK')
      // Past the key check: the kit's engine cannot send the shadow request.
      expect(result.answer).toContain(`[provider-router] ${provider} error: shadow request failed`)
      expect(JSON.stringify(result)).not.toContain(key)
    })

    test(`${provider}: no key anywhere: error names ${envName}; the engine is never asked`, async ($, on) => {
      const t = pluginEnv($, on, undefined, key)
      const { result } = await drain($.turn.step(step(model)) as any)
      expect(t.seen.length).toBe(0)
      expect(t.net.length).toBe(0)
      expect(result.answer).toContain(envName)
      expect(result.stopReason).toBe('refusal')
    })
  }
})
