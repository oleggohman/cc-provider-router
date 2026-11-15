// Shadow step: lets the engine build the exact request it would send for a
// routed step (system prompt, tools with schemas, messages with reminders),
// captures it in an `http.fetch` hook and answers it locally.
//
// FAIL CLOSED: a shadow request must never leave the machine.
// - SHADOW_MODEL does not exist, so even a leaked request bills nothing.
// - Strict match: engine request + body.model === SHADOW_MODEL + loop key +
//   message count consistent with the step's (no more API messages than rows).
// - A pending entry lives until the shadow's `next()` stream has ended.
// - While a loop has a pending shadow, every engine request for that loop is
//   answered locally (stub for the one match, a non-retryable 400 otherwise).
// - Any engine request naming SHADOW_MODEL that matches no entry is refused.
// - Any other request whose body's model (or URL) is SHADOW_MODEL, whose
//   unparseable text names it, or whose unreadable body arrives while a
//   shadow is pending, is refused too (counted in shadowLeaks when it names
//   the shadow model).
// - If the `http.fetch` hook itself fails, its `.catch` (shadowFetchFailed)
//   refuses anything that could be a shadow.
// - Circuit breaker: a shadow step that ends uncaptured (no Esc) while the
//   hook saw no engine request at all means engine requests bypass this mod;
//   every later shadow step is then refused before `next`, until reload.
// - The stub reports zero usage; its chunks are drained and never yielded.

import { ZERO_USAGE } from './chunks.ts'

export const SHADOW_MODEL = 'provider-router-shadow'

type Pending = { messageCount: number; body: any | undefined }

// Module-level: a module reload (e.g. a /config change) starts empty, and a
// stray shadow request is then refused by the no-entry rule.
const pending = new Map<string, Pending>()

// shadowRefused: requests answered locally with the 400.
// shadowLeaks: shadow-model requests that got past every engine-request rule
// to the last guard (refused there too). Must stay 0: a non-zero value means
// the engine-request markers changed.
const counters = { shadowLeaks: 0, shadowRefused: 0 }

// Circuit breaker. `engineSeen` counts the engine requests the http.fetch
// hook saw. A shadow step that ends uncaptured, without Esc, while the hook
// saw no engine request at all, means the engine's requests bypass this mod
// (where an organization's guard loads, only its own mods see them): the
// shadow request went out unseen. `blind` then stays set until the module
// reloads, and every later shadow step is refused before `next` is called.
const breaker = { engineSeen: 0, blind: false }

const BLIND = "routing is off: this plugin cannot see the engine's requests (an organization guard may hide them), so none is sent; restart Claude Code to retry"

export function shadowStats(): { shadowLeaks: number; shadowRefused: number; pending: number; blind: boolean } {
  return { ...counters, pending: pending.size, blind: breaker.blind }
}

// Test helper standing in for a module reload.
export function resetShadow(): void {
  pending.clear()
  counters.shadowLeaks = 0
  counters.shadowRefused = 0
  breaker.engineSeen = 0
  breaker.blind = false
}

export class ShadowError extends Error {}

type FetchEvent = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: unknown; compress?: unknown } }
type ShadowResponse = { status: number; ok: boolean; headers: Record<string, string>; text: string }

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name) return headers[k]
  return undefined
}

// The loop key of an agent id: the subagent's id, `main` when absent. The one
// source for shadow, thread and usage state.
export function loopKeyOf(agentId: string | undefined): string {
  return agentId || 'main'
}

// Loop of an engine request, from its agent header.
function loopKey(headers: Record<string, string> | undefined): string {
  return loopKeyOf(header(headers, 'x-claude-code-agent-id'))
}

// Engine requests carry `compress` and the session header; the mod's own
// `$.http.fetch` calls carry neither. Either marker counts (the wider rule is
// the safer one: an engine request is never mistaken for the mod's own).
export function isEngineRequest(e: FetchEvent): boolean {
  return e.init?.compress !== undefined || header(e.init?.headers, 'x-claude-code-session-id') !== undefined
}

function stubSse(): string {
  const events: [string, unknown][] = [
    ['message_start', { type: 'message_start', message: { id: 'msg_shadow', type: 'message', role: 'assistant', model: SHADOW_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: ZERO_USAGE } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  return events.map(([ev, d]) => `event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`).join('')
}

function stub(): ShadowResponse {
  return { status: 200, ok: true, headers: { 'content-type': 'text/event-stream' }, text: stubSse() }
}

// A local, non-retryable 400: the engine neither retries nor falls back.
function refuse(): ShadowResponse {
  counters.shadowRefused++
  return {
    status: 400,
    ok: false,
    headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
    text: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'provider-router: shadow request refused locally' } }),
  }
}

function parse(body: unknown): any | null {
  if (typeof body !== 'string') return null
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

// For a body that is not JSON: text naming the shadow model, or bytes we
// cannot read while any shadow is pending (possibly a compressed shadow).
function mentionsShadow(body: unknown): boolean {
  if (typeof body === 'string') return body.includes(SHADOW_MODEL)
  return body !== undefined && body !== null && pending.size > 0
}

// A request that is a shadow by its parsed model, its URL (a provider that
// puts the model in the path), or by the fallbacks above when unparseable.
function namesShadow(e: FetchEvent, body: any | null): boolean {
  if (e.url.includes(SHADOW_MODEL)) return true
  return body ? body.model === SHADOW_MODEL : mentionsShadow(e.init?.body)
}

// `e.messageCount` counts the loop's stored rows (reminders, attachments,
// tool results as their own rows); the engine merges them into fewer API
// messages (live: 22 rows -> 2 messages). So a request is consistent when it
// has at least one message and no more than the step's row count.
function countMatches(messages: unknown, expected: number): boolean {
  return Array.isArray(messages) && messages.length >= 1 && messages.length <= Math.max(1, expected)
}

// `http.fetch` hook. Returns the local answer, or calls `next` only for
// requests that are clearly not shadows.
export async function shadowFetch<E extends FetchEvent, R>(e: E, next: (e: E) => R): Promise<R | { value: ShadowResponse }> {
  const body = parse(e.init?.body)
  if (!isEngineRequest(e)) {
    // Defence in depth: never pass anything that could be a shadow. A routed
    // provider request whose conversation merely quotes the shadow model's
    // name parses, with its own model, and goes on.
    if (namesShadow(e, body)) {
      if (e.url.includes(SHADOW_MODEL) || typeof e.init?.body === 'string') counters.shadowLeaks++
      return { value: refuse() }
    }
    return next(e)
  }
  breaker.engineSeen++
  const key = loopKey(e.init?.headers)
  const p = pending.get(key)
  if (p) {
    if (body && body.model === SHADOW_MODEL && p.body === undefined && countMatches(body.messages, p.messageCount)) {
      p.body = body
      return { value: stub() }
    }
    // Any other engine request of a loop with a pending shadow (a 2nd or 3rd
    // request, a side request, a retry): refused, never passed.
    return { value: refuse() }
  }
  if (namesShadow(e, body)) return { value: refuse() }
  return next(e)
}

// The `http.fetch` hook's `.catch`: shadowFetch threw or overran before it
// answered (a failed guard is otherwise skipped and the request goes on).
// Already passed on by the hook: replayed. Otherwise anything that could be
// a shadow is refused: any request while a shadow is pending, or one naming
// the shadow model anywhere in its URL or text body.
export function shadowFetchFailed<E extends FetchEvent, R>(e: E, next: ((e: E) => R) & { readonly called: boolean }): R | { value: ShadowResponse } {
  if (isEngineRequest(e)) breaker.engineSeen++
  if (next.called) return next(e)
  const body = e.init?.body
  if (pending.size > 0 || e.url.includes(SHADOW_MODEL) || (typeof body === 'string' && body.includes(SHADOW_MODEL))) return { value: refuse() }
  return next(e)
}

export type ShadowStepEvent = { agentId?: string; messageCount: number; model: string }

// Runs the shadow step for `e` and returns the engine's captured request.
// Throws ShadowError when no request was captured, the loop already has a
// pending shadow, or the breaker is set (then `next` is never called). An
// uncaptured step that ends without Esc (`signal`) while the hook saw no
// engine request sets the breaker. The stub's chunks are drained here and
// never yielded.
export async function shadowStep<E extends ShadowStepEvent>(e: E, next: (e: E) => AsyncIterable<unknown>, signal?: AbortSignal): Promise<any> {
  if (breaker.blind) throw new ShadowError(BLIND)
  const key = loopKeyOf(e.agentId)
  if (pending.has(key)) {
    counters.shadowRefused++
    throw new ShadowError(`a shadow step is already pending for loop ${key}`)
  }
  const p: Pending = { messageCount: e.messageCount, body: undefined }
  pending.set(key, p)
  const seenBefore = breaker.engineSeen
  let failure: unknown
  try {
    for await (const _ of next({ ...e, model: SHADOW_MODEL })) void _
  } catch (err) {
    failure = err
  } finally {
    // Only once the shadow's stream has ended (success, error or abort).
    pending.delete(key)
  }
  if (p.body === undefined) {
    const blind = breaker.engineSeen === seenBefore && !signal?.aborted
    if (blind) breaker.blind = true
    throw new ShadowError(`the engine request was not captured${failure ? `: ${String(failure)}` : ''}${blind ? `; ${BLIND}` : ''}`)
  }
  return p.body
}
