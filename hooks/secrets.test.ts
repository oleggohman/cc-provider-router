import { describe, expect, test } from 'claude-code/testing'
import { maybeCompact, recordUsage, withContextHint, type UsageMap } from './context.ts'
import { providerSend } from './answer.ts'
import { loadConfig, missingKeyMessage, secretsOf } from './config.ts'
import { localError, providerError } from './errors.ts'
import { listModels, providersCommand } from './providers-command.ts'
import { routedStep } from './register.ts'
import { resetShadow, shadowStats } from './shadow.ts'
import { curlFetch, type Spawn, type SpawnChunk, type SpawnRequest } from './transport.ts'
import { drain, engine, provider, sleeper, step } from '../tests/harness.ts'

// Suite-wide secret check: drives every path that produces text the person,
// the model, a log or stored state could see (config warnings, error
// replies, routed step chunks and results, /providers, compaction) with test
// key values, and asserts none of them contains a key. The key values are
// deliberately not shaped like `sk-...` so the generic pattern stripping in
// errors.ts cannot hide a missing per-key redaction.
//
// The mod keeps no store, status line or log of its own (no `$.store`,
// `$.ui.status`, `$.ui.log` calls); its only outputs are the ones below.

const KEYS = {
  openai: 'OAKEYvalue0123abcd',
  anthropic: 'ANKEYvalue4567efgh',
  zai: 'ZAKEYvalue89abijkl',
  gw: 'GWKEYvaluecdefmnop',
}
const ALL = Object.values(KEYS)

const OPTIONS = {
  openaiApiKey: KEYS.openai,
  anthropicApiKey: '',
  zaiApiKey: '',
  customEndpoints: ['gw=http://gw.example.internal:4000/v1', `broken=${KEYS.gw}`, 'nourl='],
  contextWindows: [`bad=${KEYS.openai}`],
}

const ENV: Record<string, string> = {
  ROUTER_ANTHROPIC_API_KEY: KEYS.anthropic,
  ZAI_API_KEY: KEYS.zai,
  ROUTER_CUSTOM_API_KEYS: `gw=${KEYS.gw},${KEYS.openai}`,
}

const env = { env: { get: async (n: string) => ENV[n] } }

// Every output: echoes the request's own auth header back in the body, the
// worst case of a provider repeating the key in an error.
function echoingProvider(status: number) {
  return provider((_url, init) => {
    const auth = init.headers?.authorization ?? init.headers?.['x-api-key'] ?? ''
    return { status, text: JSON.stringify({ error: { message: `bad key ${auth} (${String(auth).replace('Bearer ', '')})` } }) }
  })
}

function assertClean(label: string, outputs: unknown[]) {
  const text = JSON.stringify(outputs)
  for (const k of ALL) {
    if (text.includes(k)) throw new Error(`${label}: output contains a test key value`)
  }
  expect(text.length > 2).toBe(true)
}

const ROUTES = [
  { model: 'openai:gpt-5', route: { provider: 'openai', model: 'gpt-5' } },
  { model: 'anthropic:claude-sonnet-4-5', route: { provider: 'anthropic', model: 'claude-sonnet-4-5' } },
  { model: 'zai:glm-5.3', route: { provider: 'zai', model: 'glm-5.3' } },
  { model: 'custom:gw:llama-3', route: { provider: 'custom', name: 'gw', model: 'llama-3' } },
] as const

describe('no key value in any output', () => {
  test('config warnings and missing-key messages', async () => {
    const c = await loadConfig(env, OPTIONS)
    expect(c.warnings.length >= 3).toBe(true)
    assertClean('warnings', [c.warnings, missingKeyMessage('openai'), missingKeyMessage('anthropic'), missingKeyMessage('zai')])
  })

  test('routed steps: provider errors echoing the key, thrown errors, success', async () => {
    const c = await loadConfig(env, OPTIONS)
    const outputs: unknown[] = []
    for (const status of [400, 401, 403, 429, 500, 503]) {
      for (const r of ROUTES) {
        resetShadow()
        const p = echoingProvider(status)
        const io = { fetch: p.fetch, sleep: sleeper().sleep, signal: new AbortController().signal }
        outputs.push(await drain(routedStep(step(r.model), engine().next, r.route as any, c, io, new Map())))
        expect(p.calls.length).toBe(1)
      }
    }
    for (const r of ROUTES) {
      resetShadow()
      const p = provider([new Error(`socket hang up, auth ${ALL.join(' ')}`)])
      const io = { fetch: p.fetch, sleep: sleeper().sleep, signal: new AbortController().signal }
      outputs.push(await drain(routedStep(step(r.model, { agentId: 'ag-1' }), engine().next, r.route as any, c, io, new Map())))
    }
    // Success: a provider whose reply text quotes nothing secret.
    resetShadow()
    const ok = provider([{ status: 200, text: JSON.stringify({ choices: [{ message: { content: 'fine' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) }])
    outputs.push(await drain(routedStep(step('openai:gpt-5'), engine().next, ROUTES[0].route as any, c, { fetch: ok.fetch, sleep: sleeper().sleep, signal: new AbortController().signal }, new Map())))
    assertClean('routed steps', outputs)
    expect(shadowStats().shadowLeaks).toBe(0)
  })

  test('routed step with a missing key and an unknown custom endpoint', async () => {
    const c = await loadConfig({ env: { get: async () => undefined } }, { ...OPTIONS, openaiApiKey: '' })
    const io = { fetch: echoingProvider(200).fetch, sleep: sleeper().sleep, signal: new AbortController().signal }
    const outputs = [
      await drain(routedStep(step('openai:gpt-5'), engine().next, { provider: 'openai', model: 'gpt-5' }, c, io, new Map())),
      await drain(routedStep(step('custom:nope:x'), engine().next, { provider: 'custom', name: 'nope', model: 'x' }, c, io, new Map())),
    ]
    assertClean('missing key', outputs)
  })

  test('/providers status and model listing, including errors echoing the key', async () => {
    const c = await loadConfig(env, OPTIONS)
    const outputs: unknown[] = []
    outputs.push(await providersCommand('', c, echoingProvider(200).fetch, shadowStats(), sleeper().sleep))
    for (const status of [200, 401, 500]) outputs.push(await listModels(echoingProvider(status).fetch, c, sleeper().sleep))
    outputs.push(await listModels(provider([new Error(`refused ${ALL.join(',')}`)]).fetch, c, sleeper().sleep))
    assertClean('/providers', outputs)
  })

  test('curl transport: no key in argv or the child env, nor in error text, for every provider row', async () => {
    const c = await loadConfig(env, OPTIONS)
    const outputs: unknown[] = []
    const requests: SpawnRequest[] = []
    // Worst case: curl failing and repeating its whole config (the key in it) on stderr.
    const spawn: Spawn = req => {
      requests.push(req)
      const chunks: SpawnChunk[] = [{ stream: 'stderr', text: `curl: (7) failed; config was: ${req.input}` }]
      let i = 0
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => (i < chunks.length ? { done: false, value: chunks[i++]! } : { done: true, value: { code: 7, signal: null } }),
        }),
      } as any
    }
    const keyed = { ...c, keys: { ...c.keys, anthropic: KEYS.anthropic, zai: KEYS.zai } }
    for (const r of ROUTES) {
      const fetch = curlFetch(spawn, { signal: new AbortController().signal, timeoutMs: 570_000, secrets: secretsOf(keyed) })
      const target = providerSend(r.route as any, keyed, 'high', fetch)
      expect(target.ok).toBe(true)
      if (!target.ok) continue
      try {
        outputs.push(await target.send({ model: r.route.model, max_tokens: 10, system: 's', messages: [{ role: 'user', content: 'hi' }] }))
      } catch (err) {
        outputs.push(String(err), localError(r.model, `request failed: ${String(err)}`, secretsOf(keyed)))
      }
    }
    expect(requests.length).toBe(ROUTES.length)
    for (const req of requests) {
      assertClean('argv and env', [req.argv, req.env ?? {}])
      // The key did go to curl, on stdin.
      expect(ALL.some(k => req.input?.includes(k))).toBe(true)
    }
    assertClean('curl errors', outputs)
  })

  test('/providers with either transport line', async () => {
    const c = await loadConfig(env, OPTIONS)
    const outputs: unknown[] = []
    for (const kind of ['curl', 'fetch'] as const) {
      outputs.push(await providersCommand('', c, echoingProvider(200).fetch, shadowStats(), sleeper().sleep, kind))
      outputs.push(await providersCommand('models', c, echoingProvider(401).fetch, shadowStats(), sleeper().sleep, kind))
    }
    assertClean('/providers transport', outputs)
  })

  test('context hints and compaction', async () => {
    const outputs: unknown[] = []
    for (const k of ALL) {
      const err = providerError('openai', 400, JSON.stringify({ error: { message: `context_length_exceeded for ${k}` } }), ALL)
      outputs.push(withContextHint(err, undefined), withContextHint(err, 'ag-1'))
      outputs.push(localError('zai', `boom ${k}`, ALL))
    }
    const t: UsageMap = new Map()
    const c = await loadConfig(env, OPTIONS)
    const e = step('openai:gpt-5')
    const r = await drain(routedStep(e, engine().next, ROUTES[0].route as any, c, { fetch: echoingProvider(401).fetch, sleep: sleeper().sleep, signal: new AbortController().signal }, new Map()))
    recordUsage(t, 'main', e.model, r.result.usage)
    outputs.push(r, t.get('main'))
    maybeCompact(t, c.contextWindows, { after: (_ms, fn) => (fn(), { cancel() {} }), compact: async () => ({ skip: 'no' }) })
    assertClean('context', outputs)
  })

  test('through the plugin: routed step and /providers with keys from env', async ($, on) => {
    on('clock.sleep', () => ({ value: undefined }) as any)
    on('env.get', (_$, e: any) => ({ value: e.name === 'OPENAI_API_KEY' ? KEYS.openai : ENV[e.name] }) as any)
    // The network echoes the auth the mod sent (the keys it holds).
    on('http.fetch', (_$, e: any) => {
      const h = e.init?.headers ?? {}
      const auth = String(h.authorization ?? h['x-api-key'] ?? '')
      return { value: { status: 401, ok: false, headers: {}, text: JSON.stringify({ error: { message: `bad ${auth} ${auth.replace('Bearer ', '')}` } }) } }
    })
    on('turn.step', async function* (_$, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as any
    })
    const outputs: unknown[] = []
    outputs.push(await drain($.turn.step(step('openai:gpt-5')) as any))
    outputs.push(await drain($.turn.step(step('zai:glm-5.3', { agentId: 'ag-2' })) as any))
    outputs.push(await ($ as any).command.run({ command: 'providers', args: '' }))
    outputs.push(await ($ as any).command.run({ command: 'providers', args: 'models' }))
    assertClean('plugin', outputs)
  })
})
