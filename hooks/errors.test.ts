import { describe, expect, test } from 'claude-code/testing'
import { routedStep } from './register.ts'
import { errorChunks, localError, providerError, sanitize } from './errors.ts'
import { sleeper } from '../tests/harness.ts'

describe('providerError', () => {
  test('status maps to a message with the provider text', () => {
    const r = providerError('openai', 401, '{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}')
    expect(r.text).toBe('[provider-router] openai error 401: authentication failed (check the API key): Incorrect API key provided')
    expect(r.stopReason).toBe('refusal')
  })

  test('Anthropic and Z.ai error bodies', () => {
    expect(providerError('anthropic', 529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}').text).toContain('error 529: provider overloaded: Overloaded')
    expect(providerError('zai', 429, '{"error":{"code":"1302","message":"rate limit"}}').text).toContain('rate limited or out of quota: rate limit')
    expect(providerError('custom:gw', 502, 'upstream down').text).toBe('[provider-router] custom:gw error 502: bad gateway: upstream down')
    expect(providerError('openai', 418, '').text).toBe('[provider-router] openai error 418: request failed')
  })

  test('context-length errors stop with model_context_window_exceeded', () => {
    expect(providerError('openai', 400, '{"error":{"message":"This model\'s maximum context length is 128000 tokens","code":"context_length_exceeded"}}').stopReason).toBe('model_context_window_exceeded')
    expect(providerError('anthropic', 400, '{"error":{"message":"prompt is too long: 210000 tokens > 200000 maximum"}}').stopReason).toBe('model_context_window_exceeded')
    expect(providerError('openai', 400, '{"error":{"message":"bad tool schema"}}').stopReason).toBe('refusal')
  })

  test('Anthropic input + max_tokens over the window is a context-length error', () => {
    const body = '{"type":"error","error":{"type":"invalid_request_error","message":"input length and `max_tokens` exceed context limit: 187254 + 64000 > 200000, decrease input length or `max_tokens` and try again"}}'
    expect(providerError('anthropic', 400, body).stopReason).toBe('model_context_window_exceeded')
    expect(providerError('openai', 429, '{"error":{"message":"rate limit reached"}}').stopReason).toBe('refusal')
  })

  test('key material is stripped', () => {
    const key = 'sk-proj-ABCDEFGHIJKLMNOP1234'
    const r = providerError('openai', 401, `{"error":{"message":"Incorrect API key provided: ${key}"}}`, [key])
    expect(r.text).not.toContain(key)
    expect(r.text).toContain('[redacted]')
    const z = providerError('zai', 401, 'bad token abc123def456ghi789jkl012mno.pqr345stu678', ['abc123def456ghi789jkl012mno.pqr345stu678'])
    expect(z.text).not.toContain('abc123def456')
    expect(localError('openai', 'Bearer sk-anything-long-enough').text).not.toContain('sk-anything')
    expect(sanitize('a configured-secret-value b', ['configured-secret-value'])).toBe('a [redacted] b')
  })

  test('sanitize caps at 500 characters with ..., after redacting (no key half survives the cut)', () => {
    const key = 'configured-secret-value-1234'
    const text = `${'x'.repeat(490)}${key}${'y'.repeat(100)}`
    const out = sanitize(text, [key])
    expect(out.length).toBe(503)
    expect(out.endsWith('...')).toBe(true)
    expect(out).not.toContain('configured-secret')
    expect(out).toContain('[redac')
    expect(sanitize('short', [])).toBe('short')
  })
})

describe('errorChunks', () => {
  test('one text chunk, a refusal stop with zero usage, and the result', () => {
    const g = errorChunks({ turnId: 't', index: 2, model: 'openai:gpt-5' }, localError('openai', 'no API key'))
    const a = g.next()
    const b = g.next()
    const c = g.next()
    expect(a.value).toEqual({ kind: 'text', index: 0, text: '[provider-router] openai error: no API key' })
    expect(b.value.kind).toBe('stop')
    expect(b.value.stopReason).toBe('refusal')
    expect(b.value.usage.input_tokens).toBe(0)
    // TurnUsage names the model.
    expect(b.value.usage.model).toBe('openai:gpt-5')
    expect(c.done).toBe(true)
    expect(c.value.answer).toBe('[provider-router] openai error: no API key')
    expect(c.value.index).toBe(2)
    expect(c.value.usage.model).toBe('openai:gpt-5')
  })

  test('a parent agent receives the prefixed text from a refusal-stopped subagent step', async () => {
    const e = { turnId: 't', index: 0, model: 'zai:glm-5.3', messageCount: 1, agentId: 'sub-1' }
    const next = async function* (): AsyncGenerator<any, any> {
      throw new Error('engine unavailable')
    }
    // A key, so the step gets past the key check and the engine is asked.
    const cfg = { keys: { zai: 'k-zai-test-1' }, custom: new Map(), contextWindows: new Map(), warnings: [] }
    const io = { fetch: async () => ({ status: 200, ok: true, text: '{}' }), sleep: sleeper().sleep, signal: new AbortController().signal }
    const g = routedStep(e, next, { provider: 'zai', model: 'glm-5.3' }, cfg as any, io, new Map())
    const chunks: any[] = []
    let s = await g.next()
    while (!s.done) {
      chunks.push(s.value)
      s = await g.next()
    }
    expect(s.value.answer.startsWith('[provider-router] zai')).toBe(true)
    expect(s.value.stopReason).toBe('refusal')
    expect(chunks[0].text.startsWith('[provider-router]')).toBe(true)
    expect(s.value.answer).toContain('shadow request failed')
    expect(s.value.answer).toContain('engine unavailable')
  })
})
