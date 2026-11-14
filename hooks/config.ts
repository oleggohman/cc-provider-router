// Configuration: API keys, custom endpoints and context windows.
// Read once per module load from `register` options (/config) and env.
// A /config change reloads the module, so there are no live config reads.
// Key values never appear in warnings or messages.

export type KeyedProvider = 'anthropic' | 'openai' | 'zai'

export type CustomEndpoint = { url: string; key: string | undefined }

export type Config = {
  keys: Partial<Record<KeyedProvider, string>>
  custom: Map<string, CustomEndpoint>
  contextWindows: Map<string, number>
  warnings: string[]
}

// Minimal view of `$` this module needs; env names must be string literals.
type Env = { env: { get: (name: string) => Promise<string | undefined> } }

type Options = Readonly<Record<string, string | number | boolean | readonly string[]>>

const KEY_SOURCES: Record<KeyedProvider, { env: string; field: string }> = {
  openai: { env: 'OPENAI_API_KEY', field: 'openaiApiKey' },
  anthropic: { env: 'ROUTER_ANTHROPIC_API_KEY', field: 'anthropicApiKey' },
  zai: { env: 'ZAI_API_KEY', field: 'zaiApiKey' },
}

// Built-in context windows for common models (tokens).
const BUILTIN_WINDOWS: Record<string, number> = {
  'openai:gpt-5': 400000,
  'openai:gpt-5-mini': 400000,
  'openai:gpt-5-nano': 400000,
  'openai:gpt-4.1': 1047576,
  'openai:gpt-4.1-mini': 1047576,
  'openai:gpt-4o': 128000,
  'openai:gpt-4o-mini': 128000,
  'openai:o3': 200000,
  'openai:o4-mini': 200000,
  'anthropic:claude-opus-4-6': 200000,
  'anthropic:claude-sonnet-4-5': 200000,
  'anthropic:claude-haiku-4-5': 200000,
  'zai:glm-4.6': 200000,
  'zai:glm-5': 200000,
  'zai:glm-5.3': 200000,
}

const NAME_RE = /^[A-Za-z0-9_-]+$/

export function missingKeyMessage(provider: KeyedProvider): string {
  const s = KEY_SOURCES[provider]
  return `no API key for ${provider}: set env ${s.env} or the /config field ${s.field}`
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export async function loadConfig($: Env, options: Options): Promise<Config> {
  const warnings: string[] = []

  const envKeys: Record<KeyedProvider, string | undefined> = {
    openai: await $.env.get('OPENAI_API_KEY'),
    anthropic: await $.env.get('ROUTER_ANTHROPIC_API_KEY'),
    zai: await $.env.get('ZAI_API_KEY'),
  }
  const keys: Config['keys'] = {}
  for (const p of Object.keys(KEY_SOURCES) as KeyedProvider[]) {
    const v = str(options[KEY_SOURCES[p].field]) || str(envKeys[p])
    if (v) keys[p] = v
  }

  // Custom endpoint keys: one env variable `name=key,name2=key2`
  // (env names must be literals, so a per-endpoint variable is not possible).
  const customKeys = new Map<string, string>()
  const rawKeys = str(await $.env.get('ROUTER_CUSTOM_API_KEYS'))
  if (rawKeys) {
    rawKeys.split(',').forEach((part, i) => {
      const entry = part.trim()
      if (!entry) return
      const eq = entry.indexOf('=')
      const name = eq > 0 ? entry.slice(0, eq).trim() : ''
      const key = eq > 0 ? entry.slice(eq + 1).trim() : ''
      if (!NAME_RE.test(name) || !key) {
        warnings.push(`ROUTER_CUSTOM_API_KEYS entry ${i + 1} skipped: expected name=key`)
        return
      }
      customKeys.set(name, key)
    })
  }

  const custom = new Map<string, CustomEndpoint>()
  list(options.customEndpoints).forEach((raw, i) => {
    const entry = raw.trim()
    const eq = entry.indexOf('=')
    const name = eq > 0 ? entry.slice(0, eq).trim() : ''
    const url = eq > 0 ? entry.slice(eq + 1).trim().replace(/\/+$/, '') : ''
    if (!NAME_RE.test(name) || !/^https?:\/\/[^\s]+$/.test(url)) {
      warnings.push(`customEndpoints entry ${i + 1} skipped: expected name=http(s)://url`)
      return
    }
    custom.set(name, { url, key: customKeys.get(name) })
  })

  const contextWindows = new Map<string, number>(Object.entries(BUILTIN_WINDOWS))
  list(options.contextWindows).forEach((raw, i) => {
    const entry = raw.trim()
    const eq = entry.lastIndexOf('=')
    const model = eq > 0 ? entry.slice(0, eq).trim() : ''
    const tokens = eq > 0 ? Number(entry.slice(eq + 1).trim()) : NaN
    if (!model || !Number.isInteger(tokens) || tokens <= 0) {
      warnings.push(`contextWindows entry ${i + 1} skipped: expected model=tokens`)
      return
    }
    contextWindows.set(model, tokens)
  })

  return { keys, custom, contextWindows, warnings }
}
