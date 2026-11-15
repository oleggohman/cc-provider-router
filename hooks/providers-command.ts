// The `/providers` command: which providers are configured, whether each has
// a key (never the key itself), the shadow-safety counters, and on demand
// (`/providers models`) each provider's model list from `GET /v1/models`.
// No discovery at session start, no cache, no status line.

import type { Config } from './config.ts'
import { localError, providerError, redact } from './errors.ts'
import { ANTHROPIC_ROWS, ANTHROPIC_VERSION, type FetchResponse } from './providers/anthropic.ts'
import { OPENAI_BASE } from './providers/openai.ts'

export type ListFetch = (url: string, init: { method: 'GET'; headers: Record<string, string> }) => Promise<FetchResponse>

export type ShadowCounters = { shadowLeaks: number; shadowRefused: number }

type Row = {
  label: string
  shape: 'anthropic' | 'openai'
  baseUrl: string
  key: string | undefined
  // Built-in providers need a key; a custom endpoint may run without one.
  needsKey: boolean
  keyHint?: string
}

function rows(cfg: Config): Row[] {
  const out: Row[] = [
    { label: 'anthropic', shape: 'anthropic', baseUrl: ANTHROPIC_ROWS.anthropic.baseUrl, key: cfg.keys.anthropic, needsKey: true, keyHint: 'ROUTER_ANTHROPIC_API_KEY or /config anthropicApiKey' },
    { label: 'openai', shape: 'openai', baseUrl: OPENAI_BASE, key: cfg.keys.openai, needsKey: true, keyHint: 'OPENAI_API_KEY or /config openaiApiKey' },
    { label: 'zai', shape: 'anthropic', baseUrl: ANTHROPIC_ROWS.zai.baseUrl, key: cfg.keys.zai, needsKey: true, keyHint: 'ZAI_API_KEY or /config zaiApiKey' },
  ]
  for (const [name, ep] of cfg.custom) {
    out.push({ label: `custom:${name}`, shape: 'openai', baseUrl: ep.url, key: ep.key, needsKey: false, keyHint: 'ROUTER_CUSTOM_API_KEYS' })
  }
  return out
}

function secretsOf(cfg: Config): string[] {
  return [...Object.values(cfg.keys), ...[...cfg.custom.values()].map(c => c.key)].filter((k): k is string => !!k)
}

// A URL as shown: without user info (`user:pass@`).
function shownUrl(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@\s]*@/, '$1')
}

export function statusText(cfg: Config, stats: ShadowCounters): string {
  const list = rows(cfg)
  const width = Math.max(...list.map(r => r.label.length))
  const lines = ['provider-router']
  for (const r of list) {
    const key = r.key ? 'yes' : r.needsKey ? `no (set ${r.keyHint})` : 'no'
    lines.push(`  ${r.label.padEnd(width)}  ${shownUrl(r.baseUrl)}  key: ${key}`)
  }
  if (cfg.custom.size === 0) lines.push('  custom: none (add name=url to the /config field customEndpoints)')
  lines.push(`shadow: shadowLeaks ${stats.shadowLeaks}, shadowRefused ${stats.shadowRefused}`)
  for (const w of cfg.warnings) lines.push(`warning: ${w}`)
  lines.push('Run /providers models to list each provider\'s models.')
  return redact(lines.join('\n'), secretsOf(cfg))
}

// Model ids from an Anthropic (`data[].id`, with `type: "model"`) or OpenAI
// (`data[].id`, `object: "list"`) list; null when the body is neither.
function parseIds(text: string): string[] | null {
  try {
    const j = JSON.parse(text)
    if (!Array.isArray(j?.data)) return null
    return j.data.map((m: any) => m?.id).filter((id: unknown): id is string => typeof id === 'string' && !!id)
  } catch {
    return null
  }
}

function prefixFor(label: string): string {
  return `${label}:`
}

async function listOne(fetch: ListFetch, r: Row, secrets: string[]): Promise<string> {
  if (r.needsKey && !r.key) return `${r.label}: skipped (no key)`
  const headers: Record<string, string> = {}
  let url: string
  if (r.shape === 'anthropic') {
    url = `${r.baseUrl}/v1/models?limit=1000`
    headers['anthropic-version'] = ANTHROPIC_VERSION
    if (r.label === 'zai') headers.authorization = `Bearer ${r.key}`
    else headers['x-api-key'] = r.key!
  } else {
    url = `${r.baseUrl}/models`
    if (r.key) headers.authorization = `Bearer ${r.key}`
  }
  let res: FetchResponse
  try {
    res = await fetch(url, { method: 'GET', headers })
  } catch (err) {
    return localError(r.label, `unreachable: ${String(err)}`, secrets).text
  }
  if (!res.ok) return providerError(r.label, res.status, res.text, secrets).text
  const ids = parseIds(res.text)
  if (!ids) return localError(r.label, `unreadable model list (status ${res.status})`, secrets).text
  if (ids.length === 0) return `${r.label}: no models listed`
  const p = prefixFor(r.label)
  return [`${r.label}: ${ids.length} model${ids.length === 1 ? '' : 's'}`, ...ids.map(id => `  ${p}${redact(id, secrets)}`)].join('\n')
}

// Every provider's models, fetched now (no cache). Providers without a key
// are skipped, not called.
export async function listModels(fetch: ListFetch, cfg: Config): Promise<string> {
  const list = rows(cfg)
  if (!list.some(r => r.key || !r.needsKey)) {
    return 'no provider has a key: set OPENAI_API_KEY, ROUTER_ANTHROPIC_API_KEY or ZAI_API_KEY (or the /config fields), or add a custom endpoint'
  }
  const secrets = secretsOf(cfg)
  const parts = await Promise.all(list.map(r => listOne(fetch, r, secrets)))
  return parts.join('\n')
}

export async function providersCommand(args: string, cfg: Config, fetch: ListFetch, stats: ShadowCounters): Promise<string> {
  const a = args.trim().toLowerCase()
  if (a === '') return statusText(cfg, stats)
  if (a === 'models') return `${statusText(cfg, stats)}\n\n${await listModels(fetch, cfg)}`
  return 'usage: /providers [models]'
}
