// Adapter for OpenAI-compatible Chat Completions APIs: the OpenAI Platform
// (`openai:`) and every configured custom endpoint (`custom:<name>:`).
// The built Anthropic-shaped request is translated (translate.ts), sent
// non-streaming to `<base>/chat/completions` with `Authorization: Bearer`
// (no header for a custom endpoint without a key), and the reply translated
// back.
//
// Never uses `$.session.authorize()` / `init.auth`: these routes bill the
// configured key, never the signed-in subscription.

import type { AdapterResult, Fetch } from '../call.ts'
import { missingKeyMessage, type Config } from '../config.ts'
import { localError, providerError } from '../errors.ts'
import type { ProviderRequest } from '../request.ts'
import { routeLabel, type Route } from '../route.ts'
import { fromChat, toChat } from '../translate.ts'

export const OPENAI_BASE = 'https://api.openai.com/v1'

export type OpenAITarget = { label: string; baseUrl: string; key: string | undefined; reasoning: boolean }

// OpenAI models that take `reasoning_effort` (and reject custom sampling).
// The `-chat` variants of gpt-5 are not reasoning models.
export function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/.test(model) && !/-chat\b/.test(model)
}

// The endpoint for an `openai:` or `custom:<name>:` route, or why there is
// none (missing key, unknown endpoint name). Custom endpoints never get
// `reasoning_effort`: whether a server accepts it is unknown.
export function targetFor(route: Extract<Route, { provider: 'openai' | 'custom' }>, cfg: Config): { ok: true; target: OpenAITarget } | { ok: false; message: string } {
  if (route.provider === 'openai') {
    const key = cfg.keys.openai
    if (!key) return { ok: false, message: missingKeyMessage('openai') }
    return { ok: true, target: { label: routeLabel(route), baseUrl: OPENAI_BASE, key, reasoning: isReasoningModel(route.model) } }
  }
  const ep = cfg.custom.get(route.name)
  if (!ep) return { ok: false, message: `unknown custom endpoint "${route.name}": add ${route.name}=<url> to the /config field customEndpoints` }
  return { ok: true, target: { label: routeLabel(route), baseUrl: ep.url, key: ep.key, reasoning: false } }
}

// The error message of a 200 body that is an error object, if it is one.
function errorBody(text: string): string | undefined {
  try {
    const m = JSON.parse(text)?.error
    const msg = typeof m === 'string' ? m : m?.message
    return typeof msg === 'string' && msg.trim() ? msg.trim() : undefined
  } catch {
    return undefined
  }
}

// `secrets`: every configured key, redacted from error text.
export async function complete(fetch: Fetch, req: ProviderRequest, effort: string | number | undefined, t: OpenAITarget, secrets: readonly string[]): Promise<AdapterResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (t.key) headers.authorization = `Bearer ${t.key}`
  const body = toChat(req, { reasoning: t.reasoning, effort })
  const res = await fetch(`${t.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok) return { ok: false, error: providerError(t.label, res.status, res.text, secrets) }
  const reply = fromChat(res.text, req.model)
  if (!reply) {
    const msg = errorBody(res.text)
    return { ok: false, error: localError(t.label, msg ?? `unreadable reply (status ${res.status}, not a chat completion)`, secrets) }
  }
  return { ok: true, reply }
}
