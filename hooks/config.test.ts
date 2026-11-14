import { describe, expect, test } from 'claude-code/testing'
import { loadConfig, missingKeyMessage } from './config.ts'

// A stand-in for `$` that holds only `env`: touching any other noun throws,
// which proves config comes from options + env alone. (The test kit's `$` is
// the engine's and has no `env` noun, so `mock.env` cannot be used here.)
function fakeEnv(vars: Record<string, string>): any {
  const env = { get: async (name: string) => vars[name] }
  return new Proxy({ env }, {
    get(target, prop) {
      if (prop === 'env') return target.env
      if (prop === 'then') return undefined
      throw new Error(`unexpected read of $.${String(prop)}`)
    },
  })
}

const EMPTY = { openaiApiKey: '', anthropicApiKey: '', zaiApiKey: '', customEndpoints: [], contextWindows: [] }

describe('loadConfig', () => {
  test('env only', async () => {
    const c = await loadConfig(fakeEnv({ OPENAI_API_KEY: 'env-oa', ROUTER_ANTHROPIC_API_KEY: 'env-an', ZAI_API_KEY: 'env-zai' }), EMPTY)
    expect(c.keys).toEqual({ openai: 'env-oa', anthropic: 'env-an', zai: 'env-zai' })
    expect(c.warnings).toEqual([])
  })

  test('/config only', async () => {
    const c = await loadConfig(fakeEnv({}), { ...EMPTY, openaiApiKey: 'cfg-oa', anthropicApiKey: 'cfg-an', zaiApiKey: 'cfg-zai' })
    expect(c.keys).toEqual({ openai: 'cfg-oa', anthropic: 'cfg-an', zai: 'cfg-zai' })
  })

  test('both: /config wins over env', async () => {
    const c = await loadConfig(fakeEnv({ OPENAI_API_KEY: 'env-oa', ZAI_API_KEY: 'env-zai' }), { ...EMPTY, openaiApiKey: 'cfg-oa' })
    expect(c.keys.openai).toBe('cfg-oa')
    expect(c.keys.zai).toBe('env-zai')
    expect(c.keys.anthropic).toBe(undefined)
  })

  test('ANTHROPIC_API_KEY is not used for anthropic:', async () => {
    const c = await loadConfig(fakeEnv({ ANTHROPIC_API_KEY: 'nope' }), EMPTY)
    expect(c.keys.anthropic).toBe(undefined)
  })

  test('custom endpoint name=url', async () => {
    const c = await loadConfig(fakeEnv({}), { ...EMPTY, customEndpoints: ['mygw=http://gateway.example.internal:4000/v1', 'local=http://localhost:11434/v1/'] })
    expect(c.custom.get('mygw')).toEqual({ url: 'http://gateway.example.internal:4000/v1', key: undefined })
    expect(c.custom.get('local')?.url).toBe('http://localhost:11434/v1')
    expect(c.warnings).toEqual([])
  })

  test('custom endpoint key from ROUTER_CUSTOM_API_KEYS', async () => {
    const c = await loadConfig(fakeEnv({ ROUTER_CUSTOM_API_KEYS: 'mygw=sk-gw, other=sk-o' }), { ...EMPTY, customEndpoints: ['mygw=https://gw.example/v1', 'local=http://localhost:1/v1'] })
    expect(c.custom.get('mygw')?.key).toBe('sk-gw')
    expect(c.custom.get('local')?.key).toBe(undefined)
  })

  test('empty customEndpoints list gives no custom endpoints', async () => {
    const c = await loadConfig(fakeEnv({}), EMPTY)
    expect(c.custom.size).toBe(0)
    expect(c.warnings).toEqual([])
  })

  test('malformed entries are skipped with a warning naming the field, never the value', async () => {
    const c = await loadConfig(fakeEnv({}), {
      ...EMPTY,
      customEndpoints: ['nourl', 'bad name=http://x', 'ftp=ftp://x', 'ok=https://ok.example/v1', '=http://x'],
    })
    expect([...c.custom.keys()]).toEqual(['ok'])
    expect(c.warnings.length).toBe(4)
    for (const w of c.warnings) {
      expect(w).toContain('customEndpoints')
      expect(w.includes('ftp://x')).toBe(false)
    }
  })

  test('malformed ROUTER_CUSTOM_API_KEYS entry warns without echoing the key', async () => {
    const c = await loadConfig(fakeEnv({ ROUTER_CUSTOM_API_KEYS: 'sk-secret-without-name' }), EMPTY)
    expect(c.warnings.length).toBe(1)
    expect(c.warnings[0]).toContain('ROUTER_CUSTOM_API_KEYS')
    expect(c.warnings[0]!.includes('sk-secret')).toBe(false)
  })

  test('context windows: built-in table plus model=tokens entries', async () => {
    const c = await loadConfig(fakeEnv({}), { ...EMPTY, contextWindows: ['openai:my-model=64000', 'custom:gw:llama=8192'] })
    expect(c.contextWindows.get('openai:my-model')).toBe(64000)
    expect(c.contextWindows.get('custom:gw:llama')).toBe(8192)
    expect(c.contextWindows.get('openai:gpt-5')).toBe(400000)
    expect(c.contextWindows.get('zai:glm-5.3')).toBe(200000)
  })

  test('invalid contextWindows entry warns naming the field', async () => {
    const c = await loadConfig(fakeEnv({}), { ...EMPTY, contextWindows: ['m=abc', 'nomodel', 'z=-5'] })
    expect(c.warnings.length).toBe(3)
    for (const w of c.warnings) expect(w).toContain('contextWindows')
  })

  test('missing options (plugin loaded without userConfig) do not crash', async () => {
    const c = await loadConfig(fakeEnv({}), {})
    expect(c.keys).toEqual({})
    expect(c.custom.size).toBe(0)
  })

  test('config comes only from options + env: no other $ reads', async () => {
    const c = await loadConfig(fakeEnv({ OPENAI_API_KEY: 'env-oa' }), { ...EMPTY, customEndpoints: ['a=http://a/v1'], contextWindows: ['m=1'] })
    expect(c.keys.openai).toBe('env-oa')
    expect(c.custom.size).toBe(1)
  })
})

describe('missingKeyMessage', () => {
  test('names the env variable and the /config field, never a value', async () => {
    expect(missingKeyMessage('openai')).toContain('OPENAI_API_KEY')
    expect(missingKeyMessage('openai')).toContain('openaiApiKey')
    expect(missingKeyMessage('anthropic')).toContain('ROUTER_ANTHROPIC_API_KEY')
    expect(missingKeyMessage('anthropic')).toContain('anthropicApiKey')
    expect(missingKeyMessage('zai')).toContain('ZAI_API_KEY')
    expect(missingKeyMessage('zai')).toContain('zaiApiKey')
  })
})
