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
//   hook saw no engine request at all may mean engine requests bypass this
//   mod; every later shadow step is then refused before `next`, until the
//   hook sees an engine request (or the module reloads). For the breaker an
//   engine request is one the host raised as the engine (`next.origin`), not
//   one with engine markers (any plugin can set those).
// - The stub reports zero usage; its chunks are drained and never yielded.
//
// Rule order for every engine request (one the host raised as the engine, or
// one carrying engine markers):
// 1. it names the shadow model (body or URL): the one strict match of a
//    pending job is answered locally, every other one is refused;
// 2. it names a router-prefixed or malformed-prefix model id (body, URL, or
//    unparseable text), or its body is unreadable while any job is pending:
//    refused, pending job or not. The engine sends requests of its own under
//    the session's prefixed id that bypass turn.step (prompt suggestion, its
//    own compaction, the classifier's retry); none may reach the first-party
//    host;
// 3. it matches the auto-mode classifier predicate (isClassifierRequest):
//    passed when the autoModeClassifier option is on; with it off, refused
//    once a step was routed since the module loaded, or while no step was
//    seen at all (a reload clears both flags), else treated as rule 4/5;
// 4. any other engine request of a loop with a pending job: refused;
// 5. anything else: passed.
// The predicate marks the engine's classifier traffic; it is not payload
// isolation and not model validation: a hook above may rewrite an engine
// request without changing its origin. The `.catch` never evaluates it and
// never grants the exception.

import type { FetchSide } from './call.ts'
import { ROUTER_PREFIXES, classifyModel } from './route.ts'
import { stubSse } from './sse.ts'

export const SHADOW_MODEL = 'provider-router-shadow'

// Where a job is in its loop's shadow step. `answered` and `handed` are set by
// the handler (answer.ts), `abandoned` by the step (register.ts routedStep).
export type JobPhase =
  | 'registered' // registered, no engine request matched yet
  | 'captured' // the shadow request matched; its body is on the job
  | 'answered' // provider replied (or failed); outcome staged
  | 'handed' // the SSE answer was returned to the engine
  | 'abandoned' // timeout, Esc, hook budget, or dispatch abandonment

// Answers a captured shadow request with the reply as SSE text. A rejection
// (or a throw) makes the request a local refusal, never a pass to the network.
// `side`: the fetch hook's transport, when the hook passed a factory for it.
export type ShadowHandler = (body: any, side?: FetchSide) => Promise<string>

// One shadow step of one loop. `id` is unique per job: every async
// continuation checks it before it acts on the loop's entry.
export type Job = { id: number; messageCount: number; phase: JobPhase; body?: any; handler?: ShadowHandler }

// Module-level: a module reload (e.g. a /config change) starts empty, and a
// stray shadow request is then refused by the no-entry rule.
const pending = new Map<string, Job>()
// The newest job id begun per loop (latestJob).
const latest = new Map<string, number>()
let jobSeq = 0

// shadowRefused: requests answered locally with the 400.
// shadowLeaks: shadow-model requests that got past every engine-request rule
// to the last guard (refused there too). Must stay 0: a non-zero value means
// the engine-request markers changed.
// classifierPassed / classifierRefused: requests the classifier predicate
// decided (rule 3), for /providers. Counted where the decision is taken only.
const counters = { shadowLeaks: 0, shadowRefused: 0, classifierPassed: 0, classifierRefused: 0 }

// Circuit breaker. `engineSeen` counts the engine requests the http.fetch
// hook saw, by the host-set `next.origin.plugin === 'engine'` alone: another
// plugin's fetch can carry `compress` or the session header, and counting it
// would keep the breaker from tripping or clear it. A shadow step that ends
// uncaptured, without Esc, while the hook saw no engine request at all, may
// mean the engine's requests bypass this mod (where an organization's guard
// loads, only its own mods see them): the shadow request went out unseen. A
// step that sent nothing (a hook beneath answered it, or the engine failed
// before sending) looks the same. `blind` then refuses every later shadow
// step before `next` is called, until the hook sees an engine request (that
// disproves blindness; under such a guard none is ever seen, and another
// plugin's fetch cannot pose as one) or the module reloads.
const breaker = { engineSeen: 0, blind: false }

// Session flags since the module loaded, for the autoModeClassifier opt-out:
// some step was routed (any loop; never cleared by an unprefixed step), and
// some step was seen at all. A reload clears both, so under the opt-out a
// fresh module refuses classifier requests until it has seen a step.
const session = { routedSeen: false, stepSeen: false }

// The fetch hook's view of the plugin options.
export type ShadowOptions = { readonly autoModeClassifier: boolean }

const BLIND = "routing is off: this plugin saw no engine request for a routed step (an organization guard may hide Claude Code's requests), so none is sent; it resumes once the plugin sees a Claude Code request, or restart Claude Code"

export function shadowStats(): { shadowLeaks: number; shadowRefused: number; classifierPassed: number; classifierRefused: number; pending: number; blind: boolean } {
  return { ...counters, pending: pending.size, blind: breaker.blind }
}

// Test helper standing in for a module reload.
export function resetShadow(): void {
  pending.clear()
  latest.clear()
  counters.shadowLeaks = 0
  counters.shadowRefused = 0
  counters.classifierPassed = 0
  counters.classifierRefused = 0
  breaker.engineSeen = 0
  breaker.blind = false
  session.routedSeen = false
  session.stepSeen = false
}

// The turn.step hook's note of a step: `routed` for any id with a router
// prefix (a malformed one included).
export function noteStep(routed: boolean): void {
  session.stepSeen = true
  if (routed) session.routedSeen = true
}

export function sessionFlags(): { routedSeen: boolean; stepSeen: boolean } {
  return { ...session }
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

// Whether a header of that name is present, with any value, in any case.
function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  return !!headers && Object.keys(headers).some(k => k.toLowerCase() === name)
}

// Loop of an engine request, from its agent header.
function loopKey(headers: Record<string, string> | undefined): string {
  return loopKeyOf(header(headers, 'x-claude-code-agent-id'))
}

// Engine requests carry the session header (and, in some engine versions,
// `compress`; 2.1.325 sends no `compress`); the mod's own
// `$.http.fetch` calls carry neither. Either marker counts (the wider rule is
// the safer one: an engine request is never mistaken for the mod's own). Any
// plugin can set them, so they only ever make handling stricter; they never
// count as proof for the circuit breaker (see noteOrigin).
export function isEngineRequest(e: FetchEvent): boolean {
  return e.init?.compress !== undefined || header(e.init?.headers, 'x-claude-code-session-id') !== undefined
}

// The hook's `next`, with the host-set origin of the request.
type Origin = { readonly origin?: { readonly plugin?: string } }

// An engine request for the refusal rules: raised by the engine (host-set
// origin) or carrying engine markers. The wider rule is the stricter one.
function engineRequest(e: FetchEvent, next: Origin): boolean {
  return next.origin?.plugin === 'engine' || isEngineRequest(e)
}

// Proof the engine raised the request: `next.origin`, set by the host alone
// ("engine" for the engine's own sends); nothing a plugin writes reaches it.
// Counts it for the circuit breaker and clears the breaker.
function noteOrigin(next: Origin): void {
  if (next.origin?.plugin !== 'engine') return
  breaker.engineSeen++
  breaker.blind = false
}

function stub(text: string = stubSse()): ShadowResponse {
  return { status: 200, ok: true, headers: { 'content-type': 'text/event-stream' }, text }
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

// Router prefixes, taken from route.ts so a new provider is refused here too
// (a test also checks them against ID_FORMS).
const PREFIXES = `(?:${ROUTER_PREFIXES.join('|')})`
// A model id with a router prefix, or a bare provider name (the classifier's
// model check, as scripts/probes/check-predicate.py has it).
const ROUTER_ID = new RegExp(`^${PREFIXES}(?::|$)`)
// A prefixed id in a URL's path or query (not its scheme or host).
const ID_IN_URL = new RegExp(`(?:^|[^A-Za-z0-9_.-])${PREFIXES}:`)
// A prefixed model in a body that does not parse.
const ID_IN_TEXT = new RegExp(`"model"\\s*:\\s*"${PREFIXES}:`)

function urlNamesPrefixed(url: string): boolean {
  const rest = url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/, '')
  let decoded = rest
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    // Malformed escapes: the raw text is checked.
  }
  return ID_IN_URL.test(rest) || ID_IN_URL.test(decoded)
}

// Rule 2: a router-prefixed or malformed-prefix model id in the parsed body's
// model, in the URL, or in a text body that does not parse.
function namesPrefixed(e: FetchEvent, body: any | null): boolean {
  if (urlNamesPrefixed(e.url)) return true
  if (body && typeof body === 'object') return typeof body.model === 'string' && classifyModel(body.model).kind !== 'unprefixed'
  const raw = e.init?.body
  return typeof raw === 'string' && ID_IN_TEXT.test(raw)
}

// A body that is present but cannot be read as JSON.
function unreadable(e: FetchEvent, body: any | null): boolean {
  const raw = e.init?.body
  return raw !== undefined && raw !== null && !(body && typeof body === 'object')
}

const CLASSIFIER_URL = 'https://api.anthropic.com/v1/messages?beta=true'
const CLASSIFIER_BETA = /^auto-mode-classifier-\d{4}-\d{2}-\d{2}$/
const CLASSIFIER_KEYS = new Set(['max_tokens', 'messages', 'metadata', 'model', 'stop_sequences', 'system', 'thinking'])

// The auto-mode classifier predicate (docs/design-notes.md, "Answer in
// place: spike"; scripts/probes/check-predicate.py). Evaluated only after the
// unconditional refusals, never from the `.catch`. Header names in any case;
// two `anthropic-beta` keys, an unreadable or unparseable body never match.
export function isClassifierRequest(e: FetchEvent, next: Origin): boolean {
  if (next.origin?.plugin !== 'engine') return false
  if ((e.init?.method ?? 'GET') !== 'POST') return false
  if (e.url !== CLASSIFIER_URL) return false
  const headers = e.init?.headers
  if (!headers) return false
  const betaKeys = Object.keys(headers).filter(k => k.toLowerCase() === 'anthropic-beta')
  if (betaKeys.length !== 1) return false
  const beta = headers[betaKeys[0]!]
  if (typeof beta !== 'string' || !beta.split(',').some(t => CLASSIFIER_BETA.test(t.trim()))) return false
  if (hasHeader(headers, 'x-claude-code-agent-id')) return false
  const raw = e.init?.body
  if (typeof raw !== 'string') return false
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return false
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false
  const model = (body as { model?: unknown }).model
  if (typeof model !== 'string' || model === '' || model === SHADOW_MODEL) return false
  if (classifyModel(model).kind !== 'unprefixed' || ROUTER_ID.test(model)) return false
  return Object.keys(body).every(k => CLASSIFIER_KEYS.has(k))
}

// `e.messageCount` counts the loop's stored rows (reminders, attachments,
// tool results as their own rows); the engine merges them into fewer API
// messages (live: 22 rows -> 2 messages). So a request is consistent when it
// has at least one message and no more than the step's row count.
function countMatches(messages: unknown, expected: number): boolean {
  return Array.isArray(messages) && messages.length >= 1 && messages.length <= Math.max(1, expected)
}

// The local answer to a captured shadow request: the handler's SSE, or the
// empty stub when the job has no handler. A failing handler is refused.
async function answer(job: Job, body: any, side?: () => Promise<FetchSide>): Promise<ShadowResponse> {
  if (!job.handler) return stub()
  try {
    return stub(await job.handler(body, side ? await side() : undefined))
  } catch {
    return refuse()
  }
}

// `http.fetch` hook. Returns the local answer, or calls `next` only for
// requests that are clearly not shadows (rule order in the header).
// `side`: builds the fetch hook's transport for a captured request's handler
// (called only then; a failure refuses the request).
export async function shadowFetch<E extends FetchEvent, R>(e: E, next: ((e: E) => R) & Origin, opts: ShadowOptions, side?: () => Promise<FetchSide>): Promise<R | { value: ShadowResponse }> {
  noteOrigin(next)
  const body = parse(e.init?.body)
  if (!engineRequest(e, next)) {
    // Defence in depth: never pass anything that could be a shadow. A routed
    // provider request whose conversation merely quotes the shadow model's
    // name parses, with its own model, and goes on.
    if (namesShadow(e, body)) {
      if (e.url.includes(SHADOW_MODEL) || typeof e.init?.body === 'string') counters.shadowLeaks++
      return { value: refuse() }
    }
    return next(e)
  }
  const key = loopKey(e.init?.headers)
  const p = pending.get(key)
  // 1. The shadow model: the one strict match is answered, the rest refused.
  if (p && body && body.model === SHADOW_MODEL && p.phase === 'registered' && countMatches(body.messages, p.messageCount)) {
    p.body = body
    p.phase = 'captured'
    return { value: await answer(p, body, side) }
  }
  if (namesShadow(e, body)) return { value: refuse() }
  // 2. A router-prefixed id, or a body we cannot read while a job is pending.
  if (namesPrefixed(e, body)) return { value: refuse() }
  if (pending.size > 0 && unreadable(e, body)) return { value: refuse() }
  // 3. The auto-mode classifier.
  if (isClassifierRequest(e, next)) {
    if (opts?.autoModeClassifier === true) {
      counters.classifierPassed++
      return next(e)
    }
    if (session.routedSeen || !session.stepSeen) {
      counters.classifierRefused++
      return { value: refuse() }
    }
  }
  // 4. Any other engine request of a loop with a pending shadow (a 2nd or 3rd
  // request, a side request, a retry): refused, never passed.
  if (p) return { value: refuse() }
  return next(e)
}

// The `http.fetch` hook's `.catch`: shadowFetch threw or overran before it
// answered (a failed guard is otherwise skipped and the request goes on).
// Already passed on by the hook: replayed. Otherwise refused: any request
// while a shadow is pending; one naming the shadow model anywhere in its URL
// or text body, or a router-prefixed id; and with autoModeClassifier off, any
// engine request once a step was routed or while no step was seen. The
// classifier predicate is never evaluated here and the exception never
// granted. A request this cannot read is refused.
export function shadowFetchFailed<E extends FetchEvent, R>(e: E, next: ((e: E) => R) & Origin & { readonly called: boolean }, opts: ShadowOptions): R | { value: ShadowResponse } {
  noteOrigin(next)
  if (next.called) return next(e)
  try {
    const raw = e.init?.body
    if (pending.size > 0 || e.url.includes(SHADOW_MODEL) || (typeof raw === 'string' && raw.includes(SHADOW_MODEL))) return { value: refuse() }
    if (namesPrefixed(e, parse(raw))) return { value: refuse() }
    if (opts?.autoModeClassifier !== true && engineRequest(e, next) && (session.routedSeen || !session.stepSeen)) return { value: refuse() }
  } catch {
    return { value: refuse() }
  }
  return next(e)
}

export type ShadowStepEvent = { agentId?: string; messageCount: number; model: string }

// Registers the job of a loop's shadow step. One job per loop: a second begin
// while one is pending is refused (ShadowError, counted) and the pending job
// stays. The id is minted here, so it is unique across loops and reloads.
export function beginShadow(key: string, spec: { messageCount: number; handler?: ShadowHandler }): Job {
  if (pending.has(key)) {
    counters.shadowRefused++
    throw new ShadowError(`a shadow step is already pending for loop ${key}`)
  }
  const job: Job = { id: ++jobSeq, messageCount: spec.messageCount, phase: 'registered', handler: spec.handler }
  pending.set(key, job)
  latest.set(key, job.id)
  return job
}

// Removes the loop's job when it is the job with this id. A stale id, or an
// id of a job that already ended, does nothing.
export function endShadow(key: string, id: number): void {
  if (pending.get(key)?.id === id) pending.delete(key)
}

// The id of the newest job begun on a loop since the module loaded, pending or
// not: a step's late continuation acts on the loop's thread state only while
// its job is still the newest.
export function latestJob(key: string): number | undefined {
  return latest.get(key)
}

// A job opened by the turn.step side, with the breaker's count of engine
// requests at that moment.
export type OpenedShadow = { job: Job; seen: number }

// Opens a loop's shadow step: refused (ShadowError, so `next` is never
// called) while the breaker is set, or while the loop has a pending job.
export function openShadow(key: string, spec: { messageCount: number; handler?: ShadowHandler }): OpenedShadow {
  if (breaker.blind) throw new ShadowError(BLIND)
  const seen = breaker.engineSeen
  return { job: beginShadow(key, spec), seen }
}

// Ends an opened job, once the engine's stream has ended (success, error,
// abort, or the stream closed). A job that was never captured gives the
// ShadowError to report; when that happened without Esc while the hook saw no
// engine request since openShadow, it also sets the breaker (an engine
// request seen later clears it).
export function closeShadow(key: string, opened: OpenedShadow, end: { aborted: boolean; failure?: unknown }): ShadowError | undefined {
  endShadow(key, opened.job.id)
  if (opened.job.body !== undefined) return undefined
  const blind = breaker.engineSeen === opened.seen && !end.aborted
  if (blind) breaker.blind = true
  return new ShadowError(`the engine request was not captured${end.failure ? `: ${String(end.failure)}` : ''}${blind ? `; ${BLIND}` : ''}`)
}
