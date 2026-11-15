// The fetch-side handler: answers a loop's captured shadow request with the
// provider's reply as Anthropic SSE ("answer in place"), so the engine parses
// the reply as its own and judges its tool calls itself.
//
// Per captured request: resolve the thread and build the provider request as
// routedStep does; keep the step's system prompt and effective tools on the
// loop at once, without its conversation or anchors (the step records those
// once the reply is delivered); check the outbound guard; call the provider,
// raced against the timer and the dispatch's signal; stage the outcome on
// the job. The answer is the reply's SSE, or the empty stub for an error, a
// timeout or Esc (the turn.step hook then yields the error chunks, or
// nothing after Esc). Never throws: any failure is a staged error and the
// stub.
//
// Outbound guard: the provider call is a nested fetch, which skips this
// mod's own `http.fetch` hook (and its last guard against shadow requests),
// and parseModel accepts any suffix (`custom:gw:provider-router-shadow`). So
// a routed model id equal to SHADOW_MODEL, or an endpoint URL naming it, is
// refused here before anything is sent; guardFetch checks the actual URL and
// body model again at the transport. A conversation that merely quotes the
// name is sent.
//
// Job identity: the handler acts only on its own job, and only while that job
// is `captured`. A job the step side gave up (`abandoned`) while the call ran
// gets nothing staged: a late reply, failure or timer is dropped, and a newer
// job of the same loop is a different object it never touches.

import { raceCall, type AdapterResult, type Fetch, type Sleep } from './call.ts'
import type { Reply } from './chunks.ts'
import { missingKeyMessage, secretsOf, type Config } from './config.ts'
import { withContextHint } from './context.ts'
import { localError, type ErrorReply } from './errors.ts'
import { maxOutputTokens } from './limits.ts'
import { ANTHROPIC_ROWS, complete as anthropicComplete } from './providers/anthropic.ts'
import { complete as openaiComplete, targetFor } from './providers/openai.ts'
import { buildRequest, type ProviderRequest } from './request.ts'
import { routeLabel, type Route } from './route.ts'
import { SHADOW_MODEL, loopKeyOf, type Job } from './shadow.ts'
import { answerableInPlace, mintId, stubSse, toSse } from './sse.ts'
import { dropBase, normalizeBody, recordStep, resolveThread, type Anchors, type Recovery, type Threads } from './thread.ts'

// What the handler staged for the step: the provider's reply (its real usage
// included; the SSE carries zeros) with the message id minted for it, an
// error reply (the stub was answered), or Esc (the stub was answered).
export type JobOutcome = { kind: 'reply'; reply: Reply; messageId: string } | { kind: 'error'; error: ErrorReply } | { kind: 'cancelled' }

// A shadow job with what the handler sets on it: the resolved body and its
// anchors (set at capture, before the provider call), and the outcome.
export type AnswerJob = Job & { sent?: any; anchors?: Anchors; outcome?: JobOutcome }

// The routed step the job belongs to.
export type AnswerStep = {
  event: { agentId?: string; model: string; effort?: string | number }
  route: Route
  config: Config
  threads: Threads
}

// The fetch hook's side of the call. `signal` is the fetch hook's
// `next.signal` (Esc, the hook settling, its budget); `recovery` gives what a
// continue with no known conversation is rebuilt from (session history, a
// forked loop's state); `transport` names the transport behind `fetch`
// (`fetch`, the default, is `$.http.fetch` with the host's 30 s limit).
export type AnswerIO = {
  fetch: Fetch
  sleep: Sleep
  signal: AbortSignal
  timeoutMs?: number
  recovery?: (body: any) => Promise<Recovery>
  transport?: 'curl' | 'fetch'
}

export class OutboundRefused extends Error {}

// Whether a URL names the shadow model, as written or percent-decoded.
function urlNamesShadow(url: string): boolean {
  let decoded = url
  try {
    decoded = decodeURIComponent(url)
  } catch {
    // Malformed escapes: the raw text is checked.
  }
  return [url, decoded].some(u => u.toLowerCase().includes(SHADOW_MODEL))
}

// Why a call to this route and endpoint must not be sent, if it must not.
function outboundRefusal(route: Route, baseUrl: string): string | undefined {
  if (route.model === SHADOW_MODEL) return `refused: the routed model id names the shadow model (${SHADOW_MODEL}), which is never sent`
  if (urlNamesShadow(baseUrl)) return `refused: the endpoint URL names the shadow model (${SHADOW_MODEL}), which is never sent`
  return undefined
}

// The transport, behind the last outbound check: a URL naming the shadow
// model, or a body that is not JSON or whose model is the shadow model, is
// refused (a rejected promise) and never reaches `fetch`.
export function guardFetch(fetch: Fetch): Fetch {
  return (url, init) => {
    if (urlNamesShadow(url)) return Promise.reject(new OutboundRefused('outbound guard: the URL names the shadow model'))
    let model: unknown
    try {
      model = JSON.parse(init.body)?.model
    } catch {
      return Promise.reject(new OutboundRefused('outbound guard: the request body is not JSON'))
    }
    if (model === SHADOW_MODEL) return Promise.reject(new OutboundRefused('outbound guard: the request names the shadow model'))
    return fetch(url, init)
  }
}

export type ProviderSend = { ok: true; baseUrl: string; send: (request: ProviderRequest) => Promise<AdapterResult> } | { ok: false; message: string }

// The adapter call of a route, or why there is none (missing key, unknown
// endpoint), as routedStep checks before its shadow step.
export function providerSend(route: Route, cfg: Config, effort: string | number | undefined, fetch: Fetch): ProviderSend {
  const secrets = secretsOf(cfg)
  if (route.provider === 'anthropic' || route.provider === 'zai') {
    const row = ANTHROPIC_ROWS[route.provider]
    const apiKey = cfg.keys[route.provider]
    if (!apiKey) return { ok: false, message: missingKeyMessage(route.provider) }
    return { ok: true, baseUrl: row.baseUrl, send: request => anthropicComplete(fetch, request, row, apiKey, secrets) }
  }
  const t = targetFor(route, cfg)
  if (!t.ok) return { ok: false, message: t.message }
  return { ok: true, baseUrl: t.target.baseUrl, send: request => openaiComplete(fetch, request, effort, t.target, secrets) }
}

// Stages the outcome on a captured job and moves it to `answered`. A job in
// any other phase (given up, or already answered) is left alone: false.
export function stage(job: AnswerJob, outcome: JobOutcome): boolean {
  if (job.phase !== 'captured') return false
  job.outcome = outcome
  job.phase = 'answered'
  return true
}

// The answer handed to the engine: returning it from the handler is the
// hand-over (shadowFetch only wraps it in the response), so an answered job
// becomes `handed` here.
function hand(job: AnswerJob, text: string): string {
  if (job.phase !== 'answered') return stubSse()
  job.phase = 'handed'
  return text
}

const HOST_LIMIT = 'no complete answer within 30000ms'

// The text of a provider call that threw. On the `$.http.fetch` transport the
// host ends a call after 30 s; that is said plainly.
function failedText(error: unknown, transport: AnswerIO['transport']): string {
  const text = String(error)
  if (transport !== 'curl' && text.includes(HOST_LIMIT)) {
    return 'request failed: the reply took longer than 30 s, the limit without curl (Claude Code ends a plugin fetch after 30 s; with curl available a reply may take up to 570 s)'
  }
  return `request failed: ${text}`
}

async function recoveryOf(io: AnswerIO, body: any): Promise<Recovery> {
  try {
    return (await io.recovery?.(body)) ?? {}
  } catch {
    return {}
  }
}

// The handler for a captured shadow request of `job`'s loop. Resolves to the
// SSE answer for the engine; never rejects.
export async function answerShadow(job: AnswerJob, body: any, step: AnswerStep, io: AnswerIO): Promise<string> {
  const { event, route, config, threads } = step
  const secrets = secretsOf(config)
  const name = routeLabel(route)
  const key = loopKeyOf(event.agentId)
  const fail = (error: ErrorReply): string => (stage(job, { kind: 'error', error }) ? hand(job, stubSse()) : stubSse())
  if (job.phase !== 'captured') return stubSse()
  try {
    // Esc before anything ran: nothing read, written or sent.
    if (io.signal.aborted) return stage(job, { kind: 'cancelled' }) ? hand(job, stubSse()) : stubSse()
    const target = providerSend(route, config, event.effort, guardFetch(io.fetch))
    if (!target.ok) return fail(localError(name, target.message, secrets))
    const refusal = outboundRefusal(route, target.baseUrl)
    if (refusal) return fail(localError(name, refusal, secrets))
    const recovery = body?.thread?.type === 'continue' && !threads.get(key)?.base ? await recoveryOf(io, body) : {}
    if (job.phase !== 'captured') return stubSse()
    const resolved = resolveThread(body, threads.get(key), recovery)
    if (!resolved.ok) {
      dropBase(threads, key)
      return fail(localError(name, resolved.message, secrets))
    }
    job.sent = resolved.body
    job.anchors = resolved.anchors
    // The step's system prompt and effective tools, at once; the conversation
    // and anchors only once the step records its delivered reply.
    recordStep(threads, key, resolved.body, [], {})
    dropBase(threads, key)
    const request = buildRequest(normalizeBody(resolved.body), route.model, maxOutputTokens(event.model))
    const out = await raceCall(io.sleep, io.signal, () => target.send(request), io.timeoutMs)
    switch (out.kind) {
      case 'cancelled':
        return stage(job, { kind: 'cancelled' }) ? hand(job, stubSse()) : stubSse()
      case 'timeout':
        return fail(localError(name, `no reply within ${out.ms} ms (timed out)`, secrets))
      case 'failed':
        return fail(localError(name, failedText(out.error, io.transport), secrets))
      case 'done': {
        if (!out.value.ok) return fail(withContextHint(out.value.error, event.agentId))
        const reply = out.value.reply
        if (!answerableInPlace(reply.stopReason)) {
          const text = reply.content.map(b => (b.type === 'text' ? b.text : '')).join('')
          return fail(withContextHint(localError(name, `the model stopped with "${reply.stopReason}", which cannot be answered in place${text ? `: ${text}` : ''}`, secrets), event.agentId))
        }
        const messageId = mintId()
        const sse = toSse(reply, messageId)
        return stage(job, { kind: 'reply', reply, messageId }) ? hand(job, sse) : stubSse()
      }
    }
  } catch (err) {
    return fail(localError(name, `internal error: ${String(err)}`, secrets))
  }
}
