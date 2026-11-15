import { describe, expect, test } from 'claude-code/testing'
import { listModels, providersCommand, statusText } from './providers-command.ts'
import { cfg, provider } from '../tests/harness.ts'

// The command takes a fetch function; tests pass a stand-in. No live
// provider is ever called, and no listing happens unless asked for.

const OA = 'oa-test-key-AAAA1111'
const AN = 'an-test-key-BBBB2222'
const ZA = 'za-test-key-CCCC3333'
const GW = 'gw-test-key-DDDD4444'
const STATS = { shadowLeaks: 0, shadowRefused: 2, pending: 0 }

const full = () =>
  cfg(
    { openai: OA, anthropic: AN, zai: ZA },
    {
      custom: new Map([
        ['gw', { url: 'http://gateway.example.internal:4000/v1', key: GW }],
        ['local', { url: 'http://localhost:8000/v1', key: undefined }],
      ]),
    },
  )

const anthropicList = (ids: string[]) => JSON.stringify({ data: ids.map(id => ({ type: 'model', id, display_name: id })), has_more: false })
const openaiList = (ids: string[]) => JSON.stringify({ object: 'list', data: ids.map(id => ({ object: 'model', id })) })

describe('statusText', () => {
  test('lists every provider with key yes/no, custom endpoints, and the shadow counters', () => {
    const t = statusText(cfg({ openai: OA }, { custom: new Map([['gw', { url: 'http://gw:4000/v1', key: undefined }]]) }), STATS)
    expect(t).toMatch(/anthropic\s.*key: no/)
    expect(t).toMatch(/openai\s.*key: yes/)
    expect(t).toMatch(/zai\s.*key: no/)
    expect(t).toMatch(/custom:gw\s.*http:\/\/gw:4000\/v1.*key: no/)
    expect(t).toContain('shadowLeaks 0')
    expect(t).toContain('shadowRefused 2')
    expect(t).toContain('/providers models')
    expect(t).not.toContain(OA)
  })

  test('no custom endpoints: says so', () => {
    expect(statusText(cfg({}), STATS)).toContain('custom: none')
  })

  test('config warnings are shown', () => {
    const t = statusText(cfg({}, { warnings: ['customEndpoints entry 1 skipped: expected name=http(s)://url'] }), STATS)
    expect(t).toContain('customEndpoints entry 1 skipped')
  })

  test('a url with user info is shown without it', () => {
    const t = statusText(cfg({}, { custom: new Map([['gw', { url: 'https://user:pa55word@gw.example/v1', key: undefined }]]) }), STATS)
    expect(t).not.toContain('pa55word')
    expect(t).toContain('https://gw.example/v1')
  })
})

describe('providersCommand', () => {
  test('without args: status only, no network', async () => {
    const p = provider([{ status: 500, text: '' }])
    const t = await providersCommand('', full(), p.fetch, STATS)
    expect(p.calls.length).toBe(0)
    expect(t).toContain('shadowLeaks 0')
  })

  test('unknown argument: usage line, no network', async () => {
    const p = provider([{ status: 500, text: '' }])
    const t = await providersCommand('bogus', full(), p.fetch, STATS)
    expect(p.calls.length).toBe(0)
    expect(t).toContain('usage: /providers [models]')
  })

  test('models: Anthropic shape for anthropic and zai, OpenAI shape for openai and custom', async () => {
    const p = provider(url => {
      if (url.startsWith('https://api.anthropic.com/')) return { status: 200, text: anthropicList(['claude-opus-4-6', 'claude-haiku-4-5']) }
      if (url.startsWith('https://api.z.ai/')) return { status: 200, text: anthropicList(['glm-5.3']) }
      if (url.startsWith('https://api.openai.com/')) return { status: 200, text: openaiList(['gpt-5', 'o3']) }
      if (url.startsWith('http://gateway.example.internal')) return { status: 200, text: openaiList(['llama-3']) }
      return { status: 200, text: openaiList(['qwen']) }
    })
    const t = await providersCommand('models', full(), p.fetch, STATS)
    const byUrl = new Map(p.calls.map(c => [c.url, c.init]))
    const an = byUrl.get('https://api.anthropic.com/v1/models?limit=1000')!
    expect(an.method).toBe('GET')
    expect(an.headers['x-api-key']).toBe(AN)
    expect(an.headers['anthropic-version']).toBe('2023-06-01')
    const za = byUrl.get('https://api.z.ai/api/anthropic/v1/models?limit=1000')!
    expect(za.headers.authorization).toBe(`Bearer ${ZA}`)
    expect(za.headers['x-api-key']).toBeUndefined()
    const oa = byUrl.get('https://api.openai.com/v1/models')!
    expect(oa.headers.authorization).toBe(`Bearer ${OA}`)
    const gw = byUrl.get('http://gateway.example.internal:4000/v1/models')!
    expect(gw.headers.authorization).toBe(`Bearer ${GW}`)
    const local = byUrl.get('http://localhost:8000/v1/models')!
    expect(local.headers.authorization).toBeUndefined()
    expect(t).toContain('anthropic:claude-opus-4-6')
    expect(t).toContain('zai:glm-5.3')
    expect(t).toContain('openai:gpt-5')
    expect(t).toContain('custom:gw:llama-3')
    expect(t).toContain('custom:local:qwen')
    for (const k of [OA, AN, ZA, GW]) expect(t).not.toContain(k)
  })

  test('models: a provider without a key is skipped, not called', async () => {
    const p = provider([{ status: 200, text: openaiList(['gpt-5']) }])
    const t = await listModels(p.fetch, cfg({ openai: OA }))
    expect(p.calls.map(c => c.url)).toEqual(['https://api.openai.com/v1/models'])
    expect(t).toMatch(/anthropic: skipped \(no key\)/)
    expect(t).toMatch(/zai: skipped \(no key\)/)
  })

  test('models: no provider usable says how to add one', async () => {
    const p = provider([{ status: 200, text: '' }])
    const t = await listModels(p.fetch, cfg({}))
    expect(p.calls.length).toBe(0)
    expect(t).toContain('no provider has a key')
  })

  test('models: provider down (5xx, 401 echoing the key, unreachable) is reported per provider', async () => {
    const p = provider(url => {
      if (url.includes('anthropic.com')) return { status: 503, text: JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded' } }) }
      if (url.includes('openai.com')) return { status: 401, text: JSON.stringify({ error: { message: `Incorrect API key provided: ${OA}` } }) }
      if (url.includes('z.ai')) return new Error(`connect ECONNREFUSED (key ${ZA})`)
      return { status: 200, text: 'not json' }
    })
    const t = await listModels(p.fetch, full())
    expect(t).toContain('[provider-router] anthropic error 503')
    expect(t).toContain('[provider-router] openai error 401')
    expect(t).toContain('[provider-router] zai error')
    expect(t).toContain('unreachable')
    expect(t).toContain('custom:gw')
    expect(t).toContain('unreadable model list')
    for (const k of [OA, AN, ZA, GW]) expect(t).not.toContain(k)
  })
})

describe('through the plugin', () => {
  test('/providers answers with the status and no network', async ($, on) => {
    const net: any[] = []
    on('http.fetch', (_$, e) => {
      net.push(e)
      return { value: { status: 200, ok: true, headers: {}, text: '' } }
    })
    on('env.get', (_$, e: any) => ({ value: e.name === 'OPENAI_API_KEY' ? OA : undefined }) as any)
    const r: any = await ($ as any).command.run({ command: 'providers', args: '' })
    expect(r.text).toMatch(/openai\s.*key: yes/)
    expect(r.text).toMatch(/anthropic\s.*key: no/)
    expect(r.text).toContain('shadowLeaks 0')
    expect(r.text).not.toContain(OA)
    expect(net.length).toBe(0)
  })
})
