// The `/providers` command: which providers are configured, whether each has
// a key (never the key itself), the shadow-safety counters, and on demand
// (`/providers models`) each provider's model list from `GET /v1/models`.
// No discovery at session start, no cache, no status line.

import { raceCall, type FetchResponse, type Sleep } from './call.ts'
import { KEY_SOURCES, secretsOf, type Config, type KeyedProvider } from './config.ts'
import { localError, providerError, redact } from './errors.ts'
import { ANTHROPIC_ROWS, ANTHROPIC_VERSION, authHeader, type AnthropicRow } from './providers/anthropic.ts'
import { OPENAI_BASE } from './providers/openai.ts'
import { customLabel } from './route.ts'
import { transportLine, type TransportKind } from './transport.ts'

export type ListFetch = (url: string, init: { method: 'GET'; headers: Record<string, string> }) => Promise<FetchResponse>

// `blind`: the shadow circuit breaker is set (shadow.ts), routing is off.
export type ShadowCounters = { shadowLeaks: number; shadowRefused: number; blind?: boolean }

// A built-in provider (`keyed`) needs a key; a custom endpoint may run
// without one. `anthropic` rows carry their auth header kind.
type Row = {
  label: string
  baseUrl: string
  key: string | undefined
  keyed?: KeyedProvider
  anthropic?: AnthropicRow
}

// How long `/providers models` waits for one provider's list.
export const LIST_TIMEOUT_MS = 20_000

function rows(cfg: Config): Row[] {
  const out: Row[] = [
    { label: 'anthropic', baseUrl: ANTHROPIC_ROWS.anthropic.baseUrl, key: cfg.keys.anthropic, keyed: 'anthropic', anthropic: ANTHROPIC_ROWS.anthropic },
    { label: 'openai', baseUrl: OPENAI_BASE, key: cfg.keys.openai, keyed: 'openai' },
    { label: 'zai', baseUrl: ANTHROPIC_ROWS.zai.baseUrl, key: cfg.keys.zai, keyed: 'zai', anthropic: ANTHROPIC_ROWS.zai },
  ]
  for (const [name, ep] of cfg.custom) out.push({ label: customLabel(name), baseUrl: ep.url, key: ep.key })
  return out
}

function keyHint(p: KeyedProvider): string {
  return `${KEY_SOURCES[p].env} or /config ${KEY_SOURCES[p].field}`
}

// A URL as shown: without user info (`user:pass@`).
function shownUrl(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@\s]*@/, '$1')
}

// `transport`: the provider transport this module load uses (transport.ts),
// when known.
export function statusText(cfg: Config, stats: ShadowCounters, transport?: TransportKind): string {
  const list = rows(cfg)
  const width = Math.max(...list.map(r => r.label.length))
  const lines = ['provider-router']
  for (const r of list) {
    const key = r.key ? 'yes' : r.keyed ? `no (set ${keyHint(r.keyed)})` : 'no'
    lines.push(`  ${r.label.padEnd(width)}  ${shownUrl(r.baseUrl)}  key: ${key}`)
  }
  if (cfg.custom.size === 0) lines.push('  custom: none (add name=url to the /config field customEndpoints)')
  if (transport) lines.push(transportLine(transport))
  lines.push(`shadow: shadowLeaks ${stats.shadowLeaks}, shadowRefused ${stats.shadowRefused}`)
  if (stats.blind) lines.push("routing is off: this plugin saw no engine request for a routed step (an organization guard may hide Claude Code's requests); it resumes once the plugin sees a Claude Code request, or restart Claude Code")
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

async function listOne(fetch: ListFetch, r: Row, secrets: string[]): Promise<string> {
  if (r.keyed && !r.key) return `${r.label}: skipped (no key)`
  let headers: Record<string, string> = {}
  let url: string
  if (r.anthropic) {
    url = `${r.baseUrl}/v1/models?limit=1000`
    headers = { 'anthropic-version': ANTHROPIC_VERSION, ...authHeader(r.anthropic.auth, r.key!) }
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
  return [`${r.label}: ${ids.length} model${ids.length === 1 ? '' : 's'}`, ...ids.map(id => `  ${r.label}:${redact(id, secrets)}`)].join('\n')
}

// One provider's list, or a line saying it did not answer in time (one
// hanging endpoint must not stall the command).
async function listWithin(fetch: ListFetch, r: Row, secrets: string[], sleep: Sleep): Promise<string> {
  // Nothing aborts this signal, so the outcome is never 'cancelled'.
  const out = await raceCall(sleep, new AbortController().signal, () => listOne(fetch, r, secrets), LIST_TIMEOUT_MS)
  if (out.kind === 'done') return out.value
  if (out.kind === 'failed') return localError(r.label, `unreachable: ${String(out.error)}`, secrets).text
  return `${r.label}: no answer within ${Math.round(LIST_TIMEOUT_MS / 1000)} s`
}

// The env names of the built-in keys, as a list in prose.
function keyEnvNames(): string {
  const names = Object.values(KEY_SOURCES).map(s => s.env)
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
}

// Every provider's models, fetched now (no cache). Providers without a key
// are skipped, not called.
export async function listModels(fetch: ListFetch, cfg: Config, sleep: Sleep): Promise<string> {
  const list = rows(cfg)
  if (!list.some(r => r.key || !r.keyed)) {
    return `no provider has a key: set ${keyEnvNames()} (or the /config fields), or add a custom endpoint`
  }
  const secrets = secretsOf(cfg)
  const parts = await Promise.all(list.map(r => listWithin(fetch, r, secrets, sleep)))
  return parts.join('\n')
}

export async function providersCommand(args: string, cfg: Config, fetch: ListFetch, stats: ShadowCounters, sleep: Sleep, transport?: TransportKind): Promise<string> {
  const a = args.trim().toLowerCase()
  if (a === '') return statusText(cfg, stats, transport)
  if (a === 'models') return `${statusText(cfg, stats, transport)}\n\n${await listModels(fetch, cfg, sleep)}`
  return 'usage: /providers [models]'
}
