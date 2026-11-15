// Provider failures as one clear text reply. The `[provider-router]` prefix is
// the main signal for a parent agent. No error stop reason exists, so a
// failure stops with `refusal`; a context-length error stops with
// `model_context_window_exceeded`. Key material never appears in the text.

export const PREFIX = '[provider-router]'

export type StopReason = 'refusal' | 'model_context_window_exceeded'

export type ErrorReply = { text: string; stopReason: StopReason }

const STATUS_TEXT: Record<number, string> = {
  400: 'bad request',
  401: 'authentication failed (check the API key)',
  403: 'permission denied (check the API key and its access)',
  404: 'not found (check the model id and base URL)',
  408: 'request timed out',
  413: 'request too large',
  429: 'rate limited or out of quota',
  500: 'provider internal error',
  502: 'bad gateway',
  503: 'provider unavailable',
  504: 'gateway timeout',
  529: 'provider overloaded',
}

const CONTEXT_RE = /context[ _-]?(length|window)|maximum context|prompt is too long|too many tokens|context_length_exceeded|reduce the length/i

// Patterns that look like credentials, stripped even when not configured here.
const KEY_PATTERNS = [/\bsk-[A-Za-z0-9_\-]{8,}/g, /\bBearer\s+[A-Za-z0-9._\-]{8,}/gi, /\b[A-Za-z0-9]{24,}\.[A-Za-z0-9]{8,}\b/g]

// Removes every known secret and anything shaped like a key, at any length.
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[redacted]')
  for (const re of KEY_PATTERNS) out = out.replace(re, '[redacted]')
  return out
}

// `redact`, then capped at 500 characters (error replies).
export function sanitize(text: string, secrets: readonly (string | undefined)[] = []): string {
  const out = redact(text, secrets)
  return out.length > 500 ? `${out.slice(0, 500)}...` : out
}

// Reads a message from an Anthropic, OpenAI or Z.ai error body.
function bodyMessage(body: string): string {
  try {
    const j = JSON.parse(body)
    const m = j?.error?.message ?? j?.message ?? (typeof j?.error === 'string' ? j.error : undefined) ?? j?.msg
    if (typeof m === 'string' && m.trim()) return m.trim()
  } catch {
    // not JSON: fall through to the raw text
  }
  return body.trim()
}

function reply(provider: string, head: string, detail: string, secrets: readonly (string | undefined)[]): ErrorReply {
  const text = sanitize(`${PREFIX} ${provider} ${head}${detail ? `: ${detail}` : ''}`, secrets)
  return { text, stopReason: CONTEXT_RE.test(detail) ? 'model_context_window_exceeded' : 'refusal' }
}

// An HTTP failure from a provider.
export function providerError(provider: string, status: number, body: string, secrets: readonly (string | undefined)[] = []): ErrorReply {
  const msg = bodyMessage(body)
  const known = STATUS_TEXT[status] ?? (status >= 500 ? 'provider error' : 'request failed')
  return reply(provider, `error ${status}`, msg ? `${known}: ${msg}` : known, secrets)
}

// A failure with no HTTP status (missing key, timeout, network, shadow).
export function localError(provider: string, message: string, secrets: readonly (string | undefined)[] = []): ErrorReply {
  return reply(provider, 'error', message, secrets)
}

const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// The step's chunks and result for an error reply.
export function* errorChunks(e: { turnId: string; index: number }, r: ErrorReply): Generator<any, any, unknown> {
  yield { kind: 'text', index: 0, text: r.text }
  yield { kind: 'stop', stopReason: r.stopReason, usage: ZERO }
  return { turnId: e.turnId, index: e.index, answer: r.text, toolUses: [], stopReason: r.stopReason, usage: ZERO }
}
