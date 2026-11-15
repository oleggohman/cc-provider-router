// Configuration: API keys, custom endpoints, context windows and the
// auto-mode classifier option.
// Read once per module load from `register` options (/config) and env.
// A /config change reloads the module, so there are no live config reads.
// Key values never appear in warnings or messages.

import type { SimpleProvider } from './route.ts'

// Every built-in provider needs a key.
export type KeyedProvider = SimpleProvider

export type CustomEndpoint = { url: string; key: string | undefined }

export type Config = {
  keys: Partial<Record<KeyedProvider, string>>
  custom: Map<string, CustomEndpoint>
  contextWindows: Map<string, number>
  // Let the engine's auto-mode classifier requests through (shadow.ts).
  autoModeClassifier: boolean
  warnings: string[]
}

// Minimal view of `$` this module needs; env names must be string literals.
type Env = { env: { get: (name: string) => Promise<string | undefined> } }

type Options = Readonly<Record<string, string | number | boolean | readonly string[]>>

// Where each provider's key comes from. loadConfig reads the same env names
// as literals: `$.env.get` accepts only literal names.
export const KEY_SOURCES: Record<KeyedProvider, { env: string; field: string }> = {
  openai: { env: 'OPENAI_API_KEY', field: 'openaiApiKey' },
  anthropic: { env: 'ROUTER_ANTHROPIC_API_KEY', field: 'anthropicApiKey' },
  zai: { env: 'ZAI_API_KEY', field: 'zaiApiKey' },
  xai: { env: 'XAI_API_KEY', field: 'xaiApiKey' },
}

const NAME_RE = /^[A-Za-z0-9_-]+$/

// Every configured key, for redacting error and status text.
export function secretsOf(cfg: Config): string[] {
  return [...Object.values(cfg.keys), ...[...cfg.custom.values()].map(c => c.key)].filter((k): k is string => !!k)
}

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

// A trimmed `name=value` entry split at its first (or last) `=`; both parts
// are '' when there is no `=` or nothing before it.
function splitPair(raw: string, at: 'first' | 'last'): { name: string; value: string } {
  const entry = raw.trim()
  const eq = at === 'first' ? entry.indexOf('=') : entry.lastIndexOf('=')
  return eq > 0 ? { name: entry.slice(0, eq).trim(), value: entry.slice(eq + 1).trim() } : { name: '', value: '' }
}

// The `autoModeClassifier` option: true when absent (the manifest default),
// `true` / `false` as booleans or strings. Any other value turns it off, the
// stricter choice: classifier requests are then refused once a step was routed.
export function autoModeClassifierOf(options: Options): boolean {
  const v = options.autoModeClassifier
  return v === undefined || v === true || v === 'true'
}

function knownSwitch(v: unknown): boolean {
  return v === undefined || v === true || v === false || v === 'true' || v === 'false'
}

export async function loadConfig($: Env, options: Options): Promise<Config> {
  const warnings: string[] = []

  const envKeys: Record<KeyedProvider, string | undefined> = {
    openai: await $.env.get('OPENAI_API_KEY'),
    anthropic: await $.env.get('ROUTER_ANTHROPIC_API_KEY'),
    zai: await $.env.get('ZAI_API_KEY'),
    xai: await $.env.get('XAI_API_KEY'),
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
      if (!part.trim()) return
      const { name, value: key } = splitPair(part, 'first')
      if (!NAME_RE.test(name) || !key) {
        warnings.push(`ROUTER_CUSTOM_API_KEYS entry ${i + 1} skipped: expected name=key`)
        return
      }
      customKeys.set(name, key)
    })
  }

  const custom = new Map<string, CustomEndpoint>()
  list(options.customEndpoints).forEach((raw, i) => {
    const { name, value } = splitPair(raw, 'first')
    const url = value.replace(/\/+$/, '')
    if (!NAME_RE.test(name) || !/^https?:\/\/[^\s]+$/.test(url)) {
      warnings.push(`customEndpoints entry ${i + 1} skipped: expected name=http(s)://url`)
      return
    }
    // Credentials in the URL would reach error text (and the transcript).
    if (/^https?:\/\/[^\s/]*@/.test(url)) {
      warnings.push(`customEndpoints entry ${i + 1} skipped: credentials in the URL are not allowed; put the key in env ROUTER_CUSTOM_API_KEYS`)
      return
    }
    custom.set(name, { url, key: customKeys.get(name) })
  })

  // Exact-id entries; the built-in windows are in limits.ts.
  const contextWindows = new Map<string, number>()
  list(options.contextWindows).forEach((raw, i) => {
    const { name: model, value } = splitPair(raw, 'last')
    const tokens = model ? Number(value) : NaN
    if (!model || !Number.isInteger(tokens) || tokens <= 0) {
      warnings.push(`contextWindows entry ${i + 1} skipped: expected model=tokens`)
      return
    }
    contextWindows.set(model, tokens)
  })

  if (!knownSwitch(options.autoModeClassifier)) warnings.push('autoModeClassifier: expected true or false; the classifier is off')

  return { keys, custom, contextWindows, autoModeClassifier: autoModeClassifierOf(options), warnings }
}
