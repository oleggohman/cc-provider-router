import { describe, expect, test } from 'claude-code/testing'
import { OPENAI_BASE, XAI_BASE, complete, isReasoningModel, isXaiReasoningModel, targetFor } from './openai.ts'
import { routedStep } from '../register.ts'
import { SHADOW_MODEL, resetShadow, shadowStats } from '../shadow.ts'
import { cfg, drain, engine as sharedEngine, provider, sleeper, step } from '../../tests/harness.ts'

// The test kit refuses `$.http.fetch` from a test's own hooks, so the adapter
// takes a fetch function and the tests pass a counting stand-in for the
// network. No live provider is ever called.

const KEY = 'sk-proj-test-KEY-0123456789abcdef'
const GW_KEY = 'gw-secret-key-0123456789abcdef'
const XAI_KEY = 'xai-test-KEY-0123456789abcdef'

const REQ = {
  model: 'gpt-5',
  max_tokens: 128000,
  system: [{ type: 'text', text: 'SYS' }],
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
}

const OK_TEXT = JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'gpt-5-2025-08-07',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
})

const TOOL_TEXT = JSON.stringify({
  model: 'gpt-5',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Running it.', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 9 },
})

const OPENAI_T = { label: 'openai', baseUrl: OPENAI_BASE, key: KEY, reasoning: true }

describe('openai adapter', () => {
  test('success: POST <base>/chat/completions with Bearer key; Chat body; reply parsed', async () => {
    const p = provider([{ status: 200, text: OK_TEXT }])
    const r = await complete(p.fetch, REQ, 'medium', OPENAI_T, [KEY])
    expect(p.calls.length).toBe(1)
    const { url, init } = p.calls[0]!
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.headers['x-api-key']).toBeUndefined()
    // Never the session's own credential, never compressed like an engine request.
    expect(init.auth).toBeUndefined()
    expect(init.compress).toBeUndefined()
    const sent = JSON.parse(init.body)
    expect(sent.model).toBe('gpt-5')
    expect(sent.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
    ])
    expect(sent.max_completion_tokens).toBe(128000)
    expect(sent.reasoning_effort).toBe('medium')
    expect(sent.tools[0]).toEqual({ type: 'function', function: { name: 'Bash', description: 'run', parameters: REQ.tools[0]!.input_schema } })
    expect(sent.stream).toBeUndefined()
    expect(sent.system).toBeUndefined()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.reply.content).toEqual([{ type: 'text', text: 'Hello there' }])
    expect(r.reply.stopReason).toBe('end_turn')
    expect(r.reply.model).toBe('gpt-5-2025-08-07')
    expect(r.reply.usage).toEqual({ input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  })

  test('tool call reply', async () => {
    const p = provider([{ status: 200, text: TOOL_TEXT }])
    const r = await complete(p.fetch, REQ, undefined, OPENAI_T, [KEY])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.reply.content).toEqual([
      { type: 'text', text: 'Running it.' },
      { type: 'tool_use', id: 'call_9', name: 'Bash', input: { command: 'ls' } },
    ])
    expect(r.reply.stopReason).toBe('tool_use')
  })

  test('401: clear error, refusal stop, the key never echoed', async () => {
    const p = provider([{ status: 401, text: JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}`, type: 'invalid_request_error', code: 'invalid_api_key' } }) }])
    const r = await complete(p.fetch, REQ, undefined, OPENAI_T, [KEY])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.text.startsWith('[provider-router] openai error 401: authentication failed')).toBe(true)
    expect(r.error.text).not.toContain(KEY)
    expect(r.error.stopReason).toBe('refusal')
  })

  test('error text redacts every configured key passed in, not only its own', async () => {
    const OTHER = 'other-provider-secret-value'
    const p = provider([{ status: 400, text: JSON.stringify({ error: { message: `bad header ${OTHER}` } }) }])
    const r = await complete(p.fetch, REQ, undefined, OPENAI_T, [KEY, OTHER])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.text).toContain('[redacted]')
    expect(r.error.text).not.toContain(OTHER)
  })

  test('400 context length -> model_context_window_exceeded', async () => {
    const p = provider([{ status: 400, text: JSON.stringify({ error: { message: "This model's maximum context length is 400000 tokens.", code: 'context_length_exceeded' } }) }])
    const r = await complete(p.fetch, REQ, undefined, OPENAI_T, [KEY])
    expect(!r.ok && r.error.stopReason).toBe('model_context_window_exceeded')
  })

  test('429 and 5xx', async () => {
    const p = provider([
      { status: 429, text: JSON.stringify({ error: { message: 'You exceeded your current quota' } }) },
      { status: 503, text: 'upstream unavailable' },
    ])
    const a = await complete(p.fetch, REQ, undefined, OPENAI_T, [KEY])
    const b = await complete(p.fetch, REQ, undefined, OPENAI_T, [KEY])
    expect(!a.ok && a.error.text).toBe('[provider-router] openai error 429: rate limited or out of quota: You exceeded your current quota')
    expect(!b.ok && b.error.text).toBe('[provider-router] openai error 503: provider unavailable: upstream unavailable')
  })

  test('200 with an error body or no choices: provider error / unreadable reply', async () => {
    const p = provider([
      { status: 200, text: JSON.stringify({ error: { message: 'model not loaded' } }) },
      { status: 200, text: '<html>gateway</html>' },
    ])
    const a = await complete(p.fetch, REQ, undefined, OPENAI_T, [KEY])
    const b = await complete(p.fetch, REQ, undefined, OPENAI_T, [KEY])
    expect(!a.ok && a.error.text).toBe('[provider-router] openai error: model not loaded')
    expect(!b.ok && b.error.text).toContain('[provider-router] openai error: unreadable reply')
  })

  test('openai reasoning: stop kept, xhigh mapped to high, body byte-for-byte as before', async () => {
    const p = provider([{ status: 200, text: OK_TEXT }])
    const req = { ...REQ, temperature: 1, top_p: 1, stop_sequences: ['END'] }
    await complete(p.fetch, req, 'xhigh', OPENAI_T, [KEY])
    expect(p.calls[0]!.init.body).toBe(
      '{"model":"gpt-5","messages":[{"role":"system","content":"SYS"},{"role":"user","content":"hi"}],"max_completion_tokens":128000,"tools":[{"type":"function","function":{"name":"Bash","description":"run","parameters":{"type":"object","properties":{"command":{"type":"string"}}}}}],"stop":["END"],"reasoning_effort":"high"}',
    )
  })

  test('openai non-reasoning: stop, temperature and top_p kept; no reasoning_effort; body byte-for-byte as before', async () => {
    const p = provider([{ status: 200, text: OK_TEXT }])
    const t = { label: 'openai', baseUrl: OPENAI_BASE, key: KEY, reasoning: false }
    const req = { ...REQ, model: 'gpt-4o', temperature: 0.2, top_p: 0.9, stop_sequences: ['END'] }
    await complete(p.fetch, req, 'high', t, [KEY])
    expect(p.calls[0]!.init.body).toBe(
      '{"model":"gpt-4o","messages":[{"role":"system","content":"SYS"},{"role":"user","content":"hi"}],"max_completion_tokens":128000,"tools":[{"type":"function","function":{"name":"Bash","description":"run","parameters":{"type":"object","properties":{"command":{"type":"string"}}}}}],"stop":["END"],"temperature":0.2,"top_p":0.9}',
    )
  })

  test('custom endpoint serving a Grok model id: stop and sampling kept, no xhigh, no reasoning_effort', async () => {
    const p = provider([{ status: 200, text: OK_TEXT }])
    const t = { label: 'custom:xai', baseUrl: 'https://api.x.ai/v1', key: XAI_KEY, reasoning: false }
    const req = { ...REQ, model: 'grok-4.7', temperature: 0.5, top_p: 0.8, stop_sequences: ['END'] }
    await complete(p.fetch, req, 'xhigh', t, [XAI_KEY])
    expect(p.calls[0]!.init.body).toBe(
      '{"model":"grok-4.7","messages":[{"role":"system","content":"SYS"},{"role":"user","content":"hi"}],"max_completion_tokens":128000,"tools":[{"type":"function","function":{"name":"Bash","description":"run","parameters":{"type":"object","properties":{"command":{"type":"string"}}}}}],"stop":["END"],"temperature":0.5,"top_p":0.8}',
    )
  })

  test('custom endpoint with key: its own URL and Bearer key; no reasoning_effort', async () => {
    const p = provider([{ status: 200, text: OK_TEXT }])
    const r = await complete(p.fetch, { ...REQ, model: 'org/llama:v1' }, 'high', { label: 'custom:gw', baseUrl: 'http://gateway.example.internal:4000/v1', key: GW_KEY, reasoning: false }, [GW_KEY])
    expect(r.ok).toBe(true)
    expect(p.calls[0]!.url).toBe('http://gateway.example.internal:4000/v1/chat/completions')
    expect(p.calls[0]!.init.headers.authorization).toBe(`Bearer ${GW_KEY}`)
    const sent = JSON.parse(p.calls[0]!.init.body)
    expect(sent.model).toBe('org/llama:v1')
    expect(sent.reasoning_effort).toBeUndefined()
  })

  test('custom endpoint without key: no Authorization header; errors name the endpoint', async () => {
    const p = provider([
      { status: 200, text: OK_TEXT },
      { status: 404, text: JSON.stringify({ error: { message: 'model llama not found' } }) },
    ])
    const t = { label: 'custom:local', baseUrl: 'http://localhost:11434/v1', key: undefined, reasoning: false }
    const r = await complete(p.fetch, REQ, undefined, t, [])
    expect(r.ok).toBe(true)
    expect('authorization' in p.calls[0]!.init.headers).toBe(false)
    const e = await complete(p.fetch, REQ, undefined, t, [])
    expect(!e.ok && e.error.text).toBe('[provider-router] custom:local error 404: not found (check the model id and base URL): model llama not found')
  })
})

const CFG = (keys: Record<string, string>, custom: [string, { url: string; key: string | undefined }][] = []) => cfg(keys, { custom: new Map(custom) })

describe('targetFor', () => {
  test('openai: OpenAI Platform base and key; reasoning by model', async () => {
    expect(targetFor({ provider: 'openai', model: 'gpt-5' }, CFG({ openai: KEY }))).toEqual({ ok: true, target: { label: 'openai', baseUrl: OPENAI_BASE, key: KEY, reasoning: true } })
    const t = targetFor({ provider: 'openai', model: 'gpt-4o' }, CFG({ openai: KEY }))
    expect(t.ok && t.target.reasoning).toBe(false)
  })

  test('openai without key: message names OPENAI_API_KEY and openaiApiKey', async () => {
    const t = targetFor({ provider: 'openai', model: 'gpt-5' }, CFG({}))
    expect(t.ok).toBe(false)
    expect(!t.ok && t.message).toContain('OPENAI_API_KEY')
    expect(!t.ok && t.message).toContain('openaiApiKey')
  })

  test('custom: url and optional key from config; unknown name names customEndpoints', async () => {
    const cfg = CFG({}, [
      ['gw', { url: 'https://gw.example/v1', key: GW_KEY }],
      ['local', { url: 'http://localhost:1/v1', key: undefined }],
    ])
    expect(targetFor({ provider: 'custom', name: 'gw', model: 'm' }, cfg)).toEqual({ ok: true, target: { label: 'custom:gw', baseUrl: 'https://gw.example/v1', key: GW_KEY, reasoning: false } })
    const l = targetFor({ provider: 'custom', name: 'local', model: 'm' }, cfg)
    expect(l.ok && l.target.key).toBe(undefined)
    const u = targetFor({ provider: 'custom', name: 'nope', model: 'm' }, cfg)
    expect(!u.ok && u.message).toContain('nope')
    expect(!u.ok && u.message).toContain('customEndpoints')
  })

  test('xai: xAI base URL and key; reasoning, rejectsStop and effortScale set', async () => {
    expect(targetFor({ provider: 'xai', model: 'grok-4.7' }, CFG({ xai: XAI_KEY }))).toEqual({
      ok: true,
      target: { label: 'xai', baseUrl: XAI_BASE, key: XAI_KEY, reasoning: true, rejectsStop: true, effortScale: 'xai' },
    })
    expect(XAI_BASE).toBe('https://api.x.ai/v1')
  })

  test('xai reasoning follows the model id; a non-reasoning model drops rejectsStop', async () => {
    const t = (model: string) => targetFor({ provider: 'xai', model }, CFG({ xai: XAI_KEY }))
    expect(t('grok-4.7-latest')).toMatchObject({ ok: true, target: { reasoning: true, rejectsStop: true } })
    expect(t('grok-4.20-0309-non-reasoning')).toMatchObject({ ok: true, target: { reasoning: false, rejectsStop: false, effortScale: 'xai' } })
    expect(t('grok-4.20-non-reasoning')).toMatchObject({ ok: true, target: { reasoning: false, rejectsStop: false } })
    expect(t('grok-4.20-non-reasoning-latest')).toMatchObject({ ok: true, target: { reasoning: false, rejectsStop: false } })
  })

  test('xai without key: message names XAI_API_KEY and xaiApiKey', async () => {
    const t = targetFor({ provider: 'xai', model: 'grok-4.7' }, CFG({}))
    expect(t.ok).toBe(false)
    expect(!t.ok && t.message).toContain('XAI_API_KEY')
    expect(!t.ok && t.message).toContain('xaiApiKey')
  })

  test('isXaiReasoningModel: every Grok id reasons except the non-reasoning variants', async () => {
    for (const m of ['grok-4.7', 'grok-4.7-latest', 'grok-4.20-0309-reasoning', 'grok-build-0.1', 'grok-4.20-multi-agent-0309']) expect(isXaiReasoningModel(m)).toBe(true)
    for (const m of ['grok-4.20-0309-non-reasoning', 'grok-4.20-non-reasoning', 'grok-4.20-non-reasoning-latest']) expect(isXaiReasoningModel(m)).toBe(false)
  })

  test('reasoning models', async () => {
    for (const m of ['gpt-5', 'gpt-5-mini', 'gpt-5.1', 'o3', 'o4-mini', 'o1']) expect(isReasoningModel(m)).toBe(true)
    for (const m of ['gpt-4o', 'gpt-4.1-mini', 'llama3', 'omni', 'gpt-5-chat-latest', 'gpt-5-chat']) expect(isReasoningModel(m)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Routed step: shadow capture, then the adapter, through routedStep.

// Engine stand-in (tests/harness.ts) whose request also carries fields the
// router strips: metadata and thinking.
const engine = () => sharedEngine({ metadata: { user_id: 'u' }, thinking: { type: 'adaptive' } })

const io = (fetch: any) => ({ fetch, sleep: sleeper().sleep, signal: new AbortController().signal })

describe('routed step: openai and custom', () => {
  test('openai: captured request translated and sent; tool call streamed as chunks; no shadow on the network', async () => {
    resetShadow()
    const eng = engine()
    const p = provider([{ status: 200, text: TOOL_TEXT }])
    const { chunks, result } = await drain(routedStep(step('openai:gpt-5'), eng.next, { provider: 'openai', model: 'gpt-5' }, CFG({ openai: KEY }), io(p.fetch), new Map()))
    expect(eng.seen[0].model).toBe(SHADOW_MODEL)
    expect(eng.network.length).toBe(0)
    expect(p.calls.length).toBe(1)
    expect(p.calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions')
    const sent = JSON.parse(p.calls[0]!.init.body)
    expect(sent.model).toBe('gpt-5')
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'CAPTURED-SYS' })
    expect(sent.tools[0].function.name).toBe('Bash')
    expect(sent.max_completion_tokens).toBe(128000)
    expect(sent.reasoning_effort).toBe('high')
    expect(sent.metadata).toBeUndefined()
    expect(sent.thinking).toBeUndefined()
    expect(sent.stream).toBeUndefined()
    expect(JSON.stringify(chunks)).not.toContain('ENGINE-STUB-CHUNK')
    expect(chunks.map(c => c.kind)).toEqual(['text', 'tool', 'input', 'stop'])
    expect(chunks[2]).toEqual({ kind: 'input', index: 1, json: '{"command":"ls"}' })
    expect(result.toolUses).toEqual([{ name: 'Bash', input: { command: 'ls' } }])
    expect(result.stopReason).toBe('tool_use')
    expect(shadowStats()).toEqual({ shadowLeaks: 0, shadowRefused: 0, pending: 0, blind: false })
  })

  test('custom with key, subagent loop: endpoint URL and key used', async () => {
    resetShadow()
    const eng = engine()
    const p = provider([{ status: 200, text: OK_TEXT }])
    const cfg = CFG({}, [['gw', { url: 'https://gw.example/v1', key: GW_KEY }]])
    const { result } = await drain(routedStep(step('custom:gw:org/m:v1', { agentId: 'sub-3' }), eng.next, { provider: 'custom', name: 'gw', model: 'org/m:v1' }, cfg, io(p.fetch), new Map()))
    expect(eng.network.length).toBe(0)
    expect(p.calls[0]!.url).toBe('https://gw.example/v1/chat/completions')
    expect(p.calls[0]!.init.headers.authorization).toBe(`Bearer ${GW_KEY}`)
    expect(JSON.parse(p.calls[0]!.init.body).model).toBe('org/m:v1')
    expect(result.answer).toBe('Hello there')
  })

  test('custom error: key stripped from the reply', async () => {
    resetShadow()
    const p = provider([{ status: 401, text: `bad key ${GW_KEY}` }])
    const cfg = CFG({}, [['gw', { url: 'https://gw.example/v1', key: GW_KEY }]])
    const { chunks, result } = await drain(routedStep(step('custom:gw:m'), engine().next, { provider: 'custom', name: 'gw', model: 'm' }, cfg, io(p.fetch), new Map()))
    expect(chunks[0].text.startsWith('[provider-router] custom:gw error 401')).toBe(true)
    expect(JSON.stringify({ chunks, result })).not.toContain(GW_KEY)
  })

  test('unknown custom endpoint: clear error; no shadow, no provider call', async () => {
    resetShadow()
    const eng = engine()
    const p = provider([{ status: 200, text: OK_TEXT }])
    const { result } = await drain(routedStep(step('custom:nope:m'), eng.next, { provider: 'custom', name: 'nope', model: 'm' }, CFG({}), io(p.fetch), new Map()))
    expect(eng.seen.length).toBe(0)
    expect(p.calls.length).toBe(0)
    expect(result.answer).toContain('[provider-router] custom:nope error')
    expect(result.answer).toContain('customEndpoints')
    expect(result.stopReason).toBe('refusal')
  })

  test('openai missing key: no shadow, no provider call', async () => {
    resetShadow()
    const eng = engine()
    const p = provider([{ status: 200, text: OK_TEXT }])
    const { result } = await drain(routedStep(step('openai:gpt-5'), eng.next, { provider: 'openai', model: 'gpt-5' }, CFG({}), io(p.fetch), new Map()))
    expect(eng.seen.length).toBe(0)
    expect(p.calls.length).toBe(0)
    expect(result.answer).toContain('OPENAI_API_KEY')
  })
})

describe('routed step: xai', () => {
  test('xai: POST to the xAI chat completions URL with the Bearer key; reply streamed as chunks; no shadow on the network', async () => {
    resetShadow()
    const eng = engine()
    const p = provider([{ status: 200, text: TOOL_TEXT }])
    const { chunks, result } = await drain(routedStep(step('xai:grok-4.7'), eng.next, { provider: 'xai', model: 'grok-4.7' }, CFG({ xai: XAI_KEY }), io(p.fetch), new Map()))
    expect(eng.seen[0].model).toBe(SHADOW_MODEL)
    expect(eng.network.length).toBe(0)
    expect(p.calls.length).toBe(1)
    expect(p.calls[0]!.url).toBe('https://api.x.ai/v1/chat/completions')
    expect(p.calls[0]!.init.headers.authorization).toBe(`Bearer ${XAI_KEY}`)
    const sent = JSON.parse(p.calls[0]!.init.body)
    expect(sent.model).toBe('grok-4.7')
    expect(sent.reasoning_effort).toBe('high')
    expect(sent.stop).toBeUndefined()
    expect(sent.temperature).toBeUndefined()
    expect(chunks.map(c => c.kind)).toEqual(['text', 'tool', 'input', 'stop'])
    expect(result.toolUses).toEqual([{ name: 'Bash', input: { command: 'ls' } }])
    expect(JSON.stringify({ chunks, result })).not.toContain(XAI_KEY)
    expect(shadowStats()).toEqual({ shadowLeaks: 0, shadowRefused: 0, pending: 0, blind: false })
  })

  test('xai missing key: no shadow, no provider call, a local error', async () => {
    resetShadow()
    const eng = engine()
    const p = provider([{ status: 200, text: OK_TEXT }])
    const { result } = await drain(routedStep(step('xai:grok-4.7'), eng.next, { provider: 'xai', model: 'grok-4.7' }, CFG({}), io(p.fetch), new Map()))
    expect(eng.seen.length).toBe(0)
    expect(p.calls.length).toBe(0)
    expect(result.answer).toContain('XAI_API_KEY')
    expect(result.stopReason).toBe('refusal')
  })
})
