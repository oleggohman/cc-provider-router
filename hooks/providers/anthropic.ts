// Adapter for Anthropic-compatible Messages APIs: the Claude Platform
// (`anthropic:`, `x-api-key`) and Z.ai (`zai:`, `Authorization: Bearer`).
// No format translation: the built request is sent as is (non-streaming),
// only the base URL and the auth header differ per provider row. A further
// Anthropic-compatible service is one more row.
//
// Never uses `$.session.authorize()` / `init.auth`: these routes bill the
// configured key, never the signed-in subscription.

import { type Reply, type ReplyBlock, type Usage, normalizeStop } from '../chunks.ts'
import { type ErrorReply, localError, providerError } from '../errors.ts'
import type { ProviderRequest } from '../request.ts'

export const ANTHROPIC_VERSION = '2023-06-01'

export type AnthropicRow = { label: string; baseUrl: string; auth: 'x-api-key' | 'bearer' }

export const ANTHROPIC_ROWS = {
  anthropic: { label: 'anthropic', baseUrl: 'https://api.anthropic.com', auth: 'x-api-key' },
  zai: { label: 'zai', baseUrl: 'https://api.z.ai/api/anthropic', auth: 'bearer' },
} as const satisfies Record<string, AnthropicRow>

export type FetchInit = { method: string; headers: Record<string, string>; body: string }
export type FetchResponse = { status: number; ok: boolean; text: string }
export type Fetch = (url: string, init: FetchInit) => Promise<FetchResponse>

export type AdapterResult = { ok: true; reply: Reply } | { ok: false; error: ErrorReply }

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function usageOf(u: any): Usage {
  return {
    input_tokens: num(u?.input_tokens),
    output_tokens: num(u?.output_tokens),
    cache_read_input_tokens: num(u?.cache_read_input_tokens),
    cache_creation_input_tokens: num(u?.cache_creation_input_tokens),
  }
}

// A Messages API reply as a Reply, or null when the body is not one.
// Only text and tool_use blocks are kept: thinking (not requested, and the
// engine records only signed thinking it received itself) and server tool
// blocks are dropped.
export function parseMessage(text: string, fallbackModel: string): Reply | null {
  let j: any
  try {
    j = JSON.parse(text)
  } catch {
    return null
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.content)) return null
  const content: ReplyBlock[] = []
  for (const b of j.content) {
    // Empty text blocks are dropped: stored in the thread, Anthropic rejects them.
    if (b?.type === 'text' && typeof b.text === 'string' && b.text) content.push({ type: 'text', text: b.text })
    else if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} })
  }
  const callsTools = content.some(b => b.type === 'tool_use')
  return {
    model: typeof j.model === 'string' && j.model ? j.model : fallbackModel,
    content,
    stopReason: normalizeStop(j.stop_reason, callsTools),
    usage: usageOf(j.usage),
  }
}

// The auth header of a row (also used by /providers models).
export function authHeader(auth: AnthropicRow['auth'], key: string): Record<string, string> {
  return auth === 'bearer' ? { authorization: `Bearer ${key}` } : { 'x-api-key': key }
}

export async function complete(fetch: Fetch, req: ProviderRequest, row: AnthropicRow, key: string): Promise<AdapterResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION, ...authHeader(row.auth, key) }
  const res = await fetch(`${row.baseUrl}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(req) })
  if (!res.ok) return { ok: false, error: providerError(row.label, res.status, res.text, [key]) }
  const reply = parseMessage(res.text, req.model)
  if (!reply) return { ok: false, error: localError(row.label, `unreadable reply (status ${res.status}, not a Messages API message)`, [key]) }
  return { ok: true, reply }
}
