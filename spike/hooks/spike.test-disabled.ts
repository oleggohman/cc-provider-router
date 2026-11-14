import { expect, test } from 'claude-code/testing'

// Checks that an http.fetch hook beneath the mod answers the mod's own
// $.http.fetch, so adapters can be unit-tested without the network.
test('http.fetch beneath the mod intercepts its own request', async ($, on) => {
  const seen: { url: string; method?: string; body?: unknown; headers?: Record<string, string> }[] = []
  on('session.messages', () => ({ value: [] }) as any)
  on('tool.list', () => ({ value: [] }))
  on('fs.write', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }) as any)
  on('http.fetch', (_, e) => {
    seen.push({ url: e.url, method: e.init?.method, body: e.init?.body, headers: e.init?.headers })
    return { value: { status: 401, ok: false, headers: { 'content-type': 'application/json' }, text: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' } }
  })

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'spike-fetch', messageCount: 1 })
  const chunks: any[] = []
  let step = await stream.next()
  while (!step.done) {
    chunks.push(step.value)
    step = await stream.next()
  }
  const result = step.value

  expect(seen.length).toBe(1)
  expect(seen[0].url).toBe('https://api.anthropic.com/v1/messages')
  expect(seen[0].method).toBe('POST')
  expect(JSON.parse(String(seen[0].body)).model).toBe('claude-haiku-4-5')
  expect(seen[0].headers?.['anthropic-version']).toBe('2023-06-01')
  expect(result.answer).toContain('status=401')
  expect(chunks.at(-1)?.kind).toBe('stop')
})
