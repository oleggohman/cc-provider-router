// PROBE CODE, NOT PLUGIN CODE. `make-probe.sh` copies this file into a
// throwaway copy of the plugin as `hooks/probe.ts` and rewires
// `hooks/register.ts` to it. It is a rough "answer in place": the engine's
// shadow request is answered inside the `http.fetch` hook with the provider's
// reply as Anthropic SSE, and the `turn.step` hook passes the engine's own
// chunks up. Everything it sees is appended to the file named by env
// PROBE_LOG. Behaviour is switched with the PROBE_* variables listed in
// `knobs` and described in scripts/probes/README.md.
//
// It keeps the shadow model local (a shadow request is answered or refused,
// never passed) but is otherwise deliberately loose and must never ship.

import { raceCall, type Fetch } from './call.ts'
import { ZERO_USAGE, toChunks, type Reply } from './chunks.ts'
import { missingKeyMessage, secretsOf, type Config } from './config.ts'
import { errorChunks, localError, type ErrorReply } from './errors.ts'
import { maxOutputTokens } from './limits.ts'
import { ANTHROPIC_ROWS, complete as anthropicComplete } from './providers/anthropic.ts'
import { complete as openaiComplete, targetFor } from './providers/openai.ts'
import { buildRequest } from './request.ts'
import { classifyModel, routeLabel, type Route } from './route.ts'
import { recoveryFor } from './register.ts'
import { SHADOW_MODEL, loopKeyOf } from './shadow.ts'
import { dropBase, normalizeBody, recordStep, resolveThread, type Threads } from './thread.ts'

const LOAD_ID = Math.random().toString(36).slice(2, 8)

type Knobs = {
  log?: string
  pass: string // none | loose | predicate
  timeoutMs?: number
  timeoutMode: string // a (race in the fetch hook) | b (the step hook owns the timer)
  sse: string // normal | truncated | malformed | empty | badstop | http400 | nostop
  errStop: string // end_turn | refusal | model_context_window_exceeded | http400 | hookmade (empty stub, the step hook yields today's error chunks)
  usage: string // real | zero
  model: string // provider | shadow
  sleepMs?: number // a plain $.clock.sleep in the fetch hook before answering
  holdUrl?: string // a nested $.http.fetch POST before the provider call
  holdInit: any[]
  holdRunUrl?: string // the same wait through $.process.run(curl)
  holdSpawnUrl?: string // the same wait through $.process.spawn(curl --disable --config -)
  spawnReturnMs?: number // call return() on the spawn stream after N ms, while a pull is pending
  flow: string // inplace | around
  esc: string // what the fetch hook answers once its signal aborted: error | refuse | stub | wait (the provider's reply, when it comes)
  abandonAfter?: number // the step hook stops reading the stream after N chunks
}

let K: Knobs | undefined
let pluginOptions: any

async function knobs($: any): Promise<Knobs> {
  if (K) return K
  const n = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined)
  K = {
    log: await $.env.get('PROBE_LOG'),
    pass: (await $.env.get('PROBE_PASS')) || 'predicate',
    timeoutMs: n(await $.env.get('PROBE_TIMEOUT_MS')),
    timeoutMode: (await $.env.get('PROBE_TIMEOUT_MODE')) || 'a',
    sse: (await $.env.get('PROBE_SSE')) || 'normal',
    errStop: (await $.env.get('PROBE_ERR_STOP')) || 'refusal',
    usage: (await $.env.get('PROBE_USAGE')) || 'real',
    model: (await $.env.get('PROBE_MODEL')) || 'provider',
    sleepMs: n(await $.env.get('PROBE_SLEEP_MS')),
    holdUrl: (await $.env.get('PROBE_HOLD_URL')) || undefined,
    holdRunUrl: (await $.env.get('PROBE_HOLD_RUN_URL')) || undefined,
    holdSpawnUrl: (await $.env.get('PROBE_HOLD_SPAWN_URL')) || undefined,
    spawnReturnMs: n(await $.env.get('PROBE_SPAWN_RETURN_MS')),
    holdInit: JSON.parse((await $.env.get('PROBE_HOLD_INIT')) || '[{}]'),
    flow: (await $.env.get('PROBE_FLOW')) || 'inplace',
    esc: (await $.env.get('PROBE_ESC')) || 'error',
    abandonAfter: n(await $.env.get('PROBE_ABANDON_AFTER')),
  }
  return K
}

// ---- log: one JSON line per event, the whole file rewritten on each event
// (`$.fs` has no append). A reload keeps what the file already held.

const out = { lines: [] as string[], prefix: '', loaded: false, chain: Promise.resolve() as Promise<unknown>, write: undefined as undefined | ((text: string) => Promise<void>) }

export function plog(rec: Record<string, unknown>): void {
  out.lines.push(JSON.stringify({ t: Date.now(), load: LOAD_ID, ...rec }))
  const write = out.write
  if (!write) return
  out.chain = out.chain.then(() => write(out.prefix + out.lines.join('\n') + '\n')).catch(() => undefined)
}

async function attach($: any): Promise<Knobs> {
  const k = await knobs($)
  const path = k.log
  if (!path) return k
  if (!out.loaded) {
    out.loaded = true
    try {
      out.prefix = await $.fs.read(path)
    } catch {
      out.prefix = ''
    }
    plog({ ev: 'module-first-hook', options: pluginOptions, knobs: { ...k, log: undefined } })
  }
  out.write = text => $.fs.write(path, text)
  return k
}

export function probeInit(options: unknown): void {
  pluginOptions = options
  out.lines.push(JSON.stringify({ t: Date.now(), load: LOAD_ID, ev: 'module-register' }))
}

function classifierOn(): boolean {
  return pluginOptions?.autoModeClassifier !== false
}

// ---- jobs and loop status

type Job = {
  id: number
  key: string
  messageCount: number
  phase: 'registered' | 'captured' | 'answered' | 'handed' | 'abandoned'
  // Resolves the thread first (so `sent` is known whatever the call does), then starts the provider call.
  handler: (body: any, fetch: Fetch) => Promise<Prepared>
  abandoned: Promise<'timeout' | 'cancelled'>
  abandon: (why: 'timeout' | 'cancelled') => void
  body?: any
  hookError?: ErrorReply
  outcome?: { kind: 'reply' | 'error'; assistant: any[]; sent?: any; anchors?: any; messageId: string; stopReason: string; text: string; toolUses: any[] }
}
type CallResult = { ok: true; reply: Reply } | { ok: false; error: ErrorReply }
type Prepared = { ok: false; error: ErrorReply } | { ok: true; sent: any; anchors: any; call: Promise<CallResult> }

const jobs = new Map<string, Job>()
const status = new Map<string, 'routed' | 'unrouted'>()
const seq = { fetch: 0, job: 0, msg: 0 }

// ---- describing a request without its secrets

const SECRET_NAME = /authorization|api-key|apikey|cookie|token|secret|credential|session-id|signature/i

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name) return headers[k]
  return undefined
}

function parse(body: unknown): any | null {
  if (typeof body !== 'string') return null
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

function textStart(v: unknown, n: number): string {
  if (typeof v === 'string') return v.slice(0, n)
  if (Array.isArray(v)) return v.map(b => (typeof b?.text === 'string' ? b.text : `<${b?.type}>`)).join(' ').slice(0, n)
  return ''
}

function describe(e: any, body: any | null, next: any): Record<string, unknown> {
  const headers: Record<string, string> = e.init?.headers ?? {}
  const shown: Record<string, string> = {}
  for (const k of Object.keys(headers).sort()) {
    const v = String(headers[k])
    // `[redacted]` is the host's own masking of a header that may hold a credential.
    shown[k.toLowerCase()] = v === '[redacted]' ? '<host-redacted>' : SECRET_NAME.test(k) ? '<redacted>' : v.slice(0, 700)
  }
  const d: Record<string, unknown> = {
    url: e.url,
    method: e.init?.method ?? 'GET',
    origin: next.origin,
    compress: e.init?.compress,
    bodyType: typeof e.init?.body,
    headers: shown,
  }
  if (!body || typeof body !== 'object') return d
  let userId: unknown
  try {
    userId = Object.keys(JSON.parse(body.metadata?.user_id))
  } catch {
    userId = typeof body.metadata?.user_id
  }
  return {
    ...d,
    keys: Object.keys(body).sort(),
    model: body.model,
    max_tokens: body.max_tokens,
    stream: body.stream,
    metadataKeys: body.metadata && typeof body.metadata === 'object' ? Object.keys(body.metadata) : undefined,
    metadataUserIdKeys: userId,
    thread: body.thread,
    nMessages: Array.isArray(body.messages) ? body.messages.length : undefined,
    roles: Array.isArray(body.messages) ? body.messages.map((m: any) => m?.role).join(',') : undefined,
    nTools: Array.isArray(body.tools) ? body.tools.length : undefined,
    safeguards: body.safeguards ? JSON.stringify(body.safeguards).slice(0, 300) : undefined,
    system: Array.isArray(body.system) ? body.system.map((b: any) => textStart(b?.text, 70)) : textStart(body.system, 70),
    stop_sequences: body.stop_sequences,
    thinking: body.thinking,
    output_config: body.output_config,
    context_management: body.context_management ? JSON.stringify(body.context_management).slice(0, 200) : undefined,
    diagnostics: body.diagnostics ? JSON.stringify(body.diagnostics).slice(0, 200) : undefined,
    temperature: body.temperature,
    lastMessage: Array.isArray(body.messages) && body.messages.length ? textStart(body.messages[body.messages.length - 1]?.content, 160) : undefined,
  }
}

// ---- the classifier predicate (docs/design-notes.md, "Answer in place:
// spike"). Returns the conditions that failed; none means a match. The
// classifier request carries no agent header, whichever loop's call it
// judges, so it cannot be attributed to a loop: the predicate has no loop
// condition, and the opt-out works on the session (`seen`).

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages?beta=true'
const CLASSIFIER_KEYS = new Set(['max_tokens', 'messages', 'metadata', 'model', 'stop_sequences', 'system', 'thinking'])
const CLASSIFIER_BETA = /^auto-mode-classifier-\d{4}-\d{2}-\d{2}$/

export function predicateFails(e: any, body: any | null, next: any): string[] {
  const fails: string[] = []
  const headers = e.init?.headers
  if (next.origin?.plugin !== 'engine') fails.push('origin')
  if ((e.init?.method ?? 'GET') !== 'POST') fails.push('method')
  if (e.url !== MESSAGES_URL) fails.push('url')
  const betas = String(header(headers, 'anthropic-beta') ?? '').split(',').map(b => b.trim())
  if (!betas.some(b => CLASSIFIER_BETA.test(b))) fails.push('marker')
  if (header(headers, 'x-claude-code-agent-id') !== undefined) fails.push('agent-header')
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [...fails, 'body']
  if (typeof body.model !== 'string' || !body.model || body.model === SHADOW_MODEL || classifyModel(body.model).kind !== 'unprefixed') fails.push('model')
  for (const k of Object.keys(body)) if (!CLASSIFIER_KEYS.has(k)) fails.push(`key:${k}`)
  return fails
}

// What this module instance has seen since it loaded: with the opt-out set,
// a classifier request is refused once any step was routed, and also while
// no step has been seen at all (right after a reload nothing is known).
const seen = { routed: false, anyStep: false }

// ---- Reply -> Anthropic SSE

function events(list: [string, unknown][]): string {
  return list.map(([ev, d]) => `event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`).join('')
}

function toSse(content: any[], stopReason: string, id: string, model: string, usage: any): string {
  const list: [string, unknown][] = [
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } }],
  ]
  let index = 0
  for (const b of content) {
    if (b.type === 'text') {
      if (!b.text) continue
      list.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }])
      list.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }])
    } else {
      list.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }])
      list.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } }])
    }
    list.push(['content_block_stop', { type: 'content_block_stop', index }])
    index++
  }
  list.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }])
  list.push(['message_stop', { type: 'message_stop' }])
  return events(list)
}

function ok(text: string) {
  return { status: 200, ok: true, headers: { 'content-type': 'text/event-stream' }, text }
}

function refuse() {
  return {
    status: 400,
    ok: false,
    headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
    text: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'provider-router probe: request refused locally' } }),
  }
}

function render(k: Knobs, job: Job, content: any[], stopReason: string, usage: any, model: string, kind: 'reply' | 'error') {
  const messageId = `msg_pr_${LOAD_ID}_${++seq.msg}`
  job.outcome = {
    kind,
    assistant: content,
    messageId,
    stopReason,
    text: content.map(b => (b.type === 'text' ? b.text : '')).join(''),
    toolUses: content.flatMap(b => (b.type === 'tool_use' ? [{ name: b.name, input: b.input ?? {} }] : [])),
  }
  const u = k.usage === 'zero' ? ZERO_USAGE : usage
  const m = k.model === 'shadow' ? SHADOW_MODEL : model
  let text = toSse(content, stopReason, messageId, m, u)
  if (kind === 'reply') {
    if (k.sse === 'truncated') text = text.slice(0, text.indexOf('event: content_block_stop'))
    if (k.sse === 'nostop') text = text.slice(0, text.indexOf('event: message_delta'))
    if (k.sse === 'malformed') text = text.replace('event: content_block_stop', 'event: content_block_delta\ndata: {not json\n\nevent: content_block_stop')
    if (k.sse === 'empty') text = ''
    if (k.sse === 'badstop') text = text.replace(`"stop_reason":"${stopReason}"`, '"stop_reason":"bogus_reason"')
    if (k.sse === 'http400') return { ...refuse(), text: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'probe: rejected answer' } }) }
  }
  plog({ ev: 'sse', job: job.id, messageId, kind, stopReason, model: m, usage: u, sseMode: k.sse, bytes: text.length, content: JSON.stringify(content).slice(0, 400) })
  return ok(text)
}

function renderError(k: Knobs, job: Job, err: ErrorReply) {
  if (k.errStop === 'http400') {
    job.outcome = { kind: 'error', assistant: [{ type: 'text', text: err.text }], messageId: '', stopReason: 'http400', text: err.text, toolUses: [] }
    plog({ ev: 'sse', job: job.id, kind: 'error', as: 'http400', text: err.text })
    return { status: 400, ok: false, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' }, text: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: err.text } }) }
  }
  if (k.errStop === 'hookmade') {
    job.outcome = { kind: 'error', assistant: [{ type: 'text', text: err.text }], messageId: 'msg_shadow', stopReason: err.stopReason, text: err.text, toolUses: [] }
    job.hookError = err
    plog({ ev: 'sse', job: job.id, kind: 'error', as: 'empty stub; hook-made chunks follow', text: err.text })
    return ok(toSse([{ type: 'text', text: '' }], 'end_turn', 'msg_shadow', SHADOW_MODEL, ZERO_USAGE))
  }
  const stop = k.errStop === 'auto' ? err.stopReason : k.errStop
  return render(k, job, [{ type: 'text', text: err.text }], stop, ZERO_USAGE, SHADOW_MODEL, 'error')
}

// ---- http.fetch hook

async function answer($: any, k: Knobs, job: Job, body: any, next: any, n: number): Promise<any> {
  const t0 = Date.now()
  const fetch: Fetch = (url, init) => $.http.fetch(url, init)
  const onAbort = () => plog({ ev: 'fetch-signal-abort', seq: n, job: job.id, phase: job.phase, ms: Date.now() - t0 })
  next.signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (k.flow === 'around') {
      job.body = body
      job.phase = 'handed'
      return ok(toSse([{ type: 'text', text: '' }], 'end_turn', 'msg_shadow', SHADOW_MODEL, ZERO_USAGE))
    }
    if (k.sleepMs) await $.clock.sleep(k.sleepMs)
    if (k.holdUrl) {
      // One fetch per entry of PROBE_HOLD_INIT (a JSON array of extra init members; default one plain fetch).
      for (const extra of k.holdInit) {
        const h0 = Date.now()
        try {
          const r = await $.http.fetch(k.holdUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', ...extra })
          plog({ ev: 'hold-done', seq: n, extra, status: r.status, ms: Date.now() - h0 })
        } catch (err) {
          plog({ ev: 'hold-failed', seq: n, extra, err: String(err), ms: Date.now() - h0 })
        }
      }
    }
    if (k.holdRunUrl) {
      // The same wait through `$.process.run(["curl", ...])` instead of `$.http.fetch`.
      const h0 = Date.now()
      try {
        const r = await $.process.run(['curl', '-s', '-X', 'POST', '-H', 'content-type: application/json', '-d', '{}', k.holdRunUrl], { timeoutMs: 600_000 })
        plog({ ev: 'hold-run-done', seq: n, exitCode: r.exitCode, stdout: String(r.stdout).slice(0, 80), ms: Date.now() - h0 })
      } catch (err) {
        plog({ ev: 'hold-run-failed', seq: n, err: String(err), ms: Date.now() - h0 })
      }
    }
    if (k.holdSpawnUrl) await holdSpawn($, k, next, n)
    const prep = await job.handler(body, fetch)
    if (!prep.ok) {
      plog({ ev: 'answer-outcome', seq: n, job: job.id, kind: 'unresolved', ms: Date.now() - t0 })
      job.phase = 'answered'
      const value = renderError(k, job, prep.error)
      job.phase = 'handed'
      return value
    }
    const call = prep.call
    let res: { kind: string; value?: CallResult; error?: unknown; ms?: number }
    if (k.timeoutMode === 'a') {
      res = await raceCall((ms, o) => $.clock.sleep(ms, o), next.signal, () => call, k.timeoutMs ?? 600_000)
    } else {
      res = await Promise.race([
        call.then(
          value => ({ kind: 'done', value }),
          error => ({ kind: 'failed', error }),
        ),
        job.abandoned.then(kind => ({ kind, ms: k.timeoutMs })),
      ])
      // The late provider answer after an abandonment: logged, discarded.
      if (res.kind !== 'done' && res.kind !== 'failed') call.then(() => plog({ ev: 'late-provider-answer', job: job.id, current: jobs.get(job.key)?.id ?? null }), () => undefined)
    }
    plog({ ev: 'answer-outcome', seq: n, job: job.id, kind: res.kind, ms: Date.now() - t0, aborted: next.signal.aborted, current: jobs.get(job.key)?.id ?? null, budget: next.budget })
    job.phase = 'answered'
    const name = 'probe'
    let value
    if (res.kind === 'done' && res.value) {
      const r = res.value
      if (r.ok) value = render(k, job, r.reply.content, r.reply.stopReason, r.reply.usage, r.reply.model, 'reply')
      else value = renderError(k, job, r.error)
    } else if (res.kind === 'timeout') value = renderError(k, job, localError(name, `no reply within ${res.ms} ms (timed out)`))
    else if (res.kind === 'cancelled' && k.esc === 'refuse') value = refuse()
    else if (res.kind === 'cancelled' && k.esc === 'stub') value = ok(toSse([{ type: 'text', text: '' }], 'end_turn', 'msg_shadow', SHADOW_MODEL, ZERO_USAGE))
    else if (res.kind === 'cancelled' && k.esc === 'wait') {
      const late = await call
      plog({ ev: 'late-answer-after-esc', seq: n, job: job.id, ok: late.ok, ms: Date.now() - t0 })
      value = late.ok ? render(k, job, late.reply.content, late.reply.stopReason, late.reply.usage, late.reply.model, 'reply') : renderError(k, job, late.error)
    } else if (res.kind === 'cancelled') value = renderError(k, job, localError(name, 'cancelled'))
    else value = renderError(k, job, localError(name, `request failed: ${String(res.error)}`))
    if (job.outcome) Object.assign(job.outcome, { sent: prep.sent, anchors: prep.anchors })
    job.phase = 'handed'
    return value
  } catch (err) {
    plog({ ev: 'answer-threw', seq: n, job: job.id, err: String(err), ms: Date.now() - t0 })
    return renderError(k, job, localError('probe', `internal error: ${String(err)}`))
  } finally {
    next.signal.removeEventListener('abort', onAbort)
  }
}

// The wait of PROBE_HOLD_RUN_URL through `$.process.spawn`, the way the curl
// transport starts curl: argv `curl --disable --config -`, the config on
// stdin. Logs every piece, the result, and what happens to a pending pull when
// return() is called (PROBE_SPAWN_RETURN_MS) or the hook's signal aborts.
async function holdSpawn($: any, k: Knobs, next: any, n: number): Promise<void> {
  const h0 = Date.now()
  const ms = () => Date.now() - h0
  const config = [
    `url = "${k.holdSpawnUrl}"`,
    'header = "content-type: application/json"',
    'header = "x-probe: curl-transport"',
    'data-binary = "{}"',
    'silent',
    'show-error',
    'globoff',
    'proto = "=https,http"',
    'max-redirs = 0',
    'max-time = 590',
    'write-out = "\\n@@probe-status@@%{http_code}"',
    '',
  ].join('\n')
  const onAbort = () => plog({ ev: 'hold-spawn-signal-abort', seq: n, ms: ms() })
  next.signal.addEventListener('abort', onAbort, { once: true })
  plog({ ev: 'hold-spawn-begin', seq: n, budget: next.budget, returnAfterMs: k.spawnReturnMs ?? null })
  try {
    const stream = $.process.spawn({ argv: ['curl', '--disable', '--config', '-'], input: config })
    const it = typeof stream[Symbol.asyncIterator] === 'function' ? stream[Symbol.asyncIterator]() : stream
    let returned: Promise<{ tag: string }> = new Promise(() => undefined)
    if (k.spawnReturnMs !== undefined) {
      returned = $.clock.sleep(k.spawnReturnMs).then(
        async () => {
          plog({ ev: 'hold-spawn-return-call', seq: n, ms: ms() })
          try {
            const r = await it.return?.()
            plog({ ev: 'hold-spawn-return-settled', seq: n, ms: ms(), result: JSON.stringify(r ?? null).slice(0, 200) })
          } catch (err) {
            plog({ ev: 'hold-spawn-return-rejected', seq: n, ms: ms(), err: String(err) })
          }
          return { tag: 'returned' }
        },
        (err: unknown) => {
          plog({ ev: 'hold-spawn-timer-rejected', seq: n, ms: ms(), err: String(err) })
          return { tag: 'timer-failed' }
        },
      )
    }
    for (;;) {
      const pull = it.next()
      pull.then(
        (r: any) => plog({ ev: 'hold-spawn-pull-settled', seq: n, ms: ms(), done: r?.done, value: JSON.stringify(r?.value ?? null).slice(0, 160) }),
        (err: unknown) => plog({ ev: 'hold-spawn-pull-rejected', seq: n, ms: ms(), err: String(err) }),
      )
      const r: any = await Promise.race([pull, returned])
      if (r && r.tag) {
        plog({ ev: 'hold-spawn-left-after-return', seq: n, ms: ms(), how: r.tag })
        return
      }
      if (r.done) {
        plog({ ev: 'hold-spawn-done', seq: n, ms: ms(), result: r.value, budget: next.budget, aborted: next.signal.aborted })
        return
      }
    }
  } catch (err) {
    plog({ ev: 'hold-spawn-failed', seq: n, ms: ms(), err: String(err), aborted: next.signal.aborted })
  } finally {
    next.signal.removeEventListener('abort', onAbort)
  }
}

export async function probeFetch($: any, e: any, next: any): Promise<any> {
  const k = await attach($)
  const n = ++seq.fetch
  const t0 = Date.now()
  const body = parse(e.init?.body)
  const key = loopKeyOf(header(e.init?.headers, 'x-claude-code-agent-id'))
  const job = jobs.get(key)
  const loopStatus = status.get(key) ?? 'unknown'
  const fails = predicateFails(e, body, next)
  const rec = { ev: 'fetch', seq: n, key, job: job ? { id: job.id, phase: job.phase } : null, loopStatus, seen: { ...seen }, predicateFails: fails, ...describe(e, body, next) }
  const refused = (decision: string) => {
    plog({ ...rec, decision })
    return { value: refuse() }
  }
  const namesShadow = String(e.url).includes(SHADOW_MODEL) || (body ? body.model === SHADOW_MODEL : typeof e.init?.body === 'string' && e.init.body.includes(SHADOW_MODEL))
  if (next.origin?.plugin !== 'engine') {
    if (namesShadow) return refused('refuse-nonengine-shadow')
    plog({ ...rec, decision: 'pass-nonengine' })
    return next(e)
  }
  if (namesShadow) {
    const count = Array.isArray(body?.messages) ? body.messages.length : 0
    if (job && job.phase === 'registered' && count >= 1 && count <= Math.max(1, job.messageCount)) {
      job.phase = 'captured'
      plog({ ...rec, decision: 'answer-begin' })
      const value = await answer($, k, job, body, next, n)
      plog({ ev: 'fetch-answered', seq: n, job: job.id, phase: job.phase, status: value.status, ms: Date.now() - t0, aborted: next.signal.aborted })
      return { value }
    }
    return refused('refuse-shadow')
  }
  if (typeof body?.model === 'string' && classifyModel(body.model).kind !== 'unprefixed') return refused('refuse-prefixed')
  const classifier = fails.length === 0
  let pass: boolean
  if (k.pass === 'none') pass = !job
  else if (k.pass === 'loose') pass = !job || (typeof body?.model === 'string' && !Array.isArray(body.tools))
  else if (classifier) pass = classifierOn() || (seen.anyStep && !seen.routed && !job)
  else pass = !job
  if (!pass) return refused(classifier ? 'refuse-classifier' : 'refuse')
  plog({ ...rec, decision: classifier ? 'pass-classifier' : 'pass' })
  const r = await next(e)
  plog({ ev: 'fetch-settled', seq: n, status: (r as any)?.status ?? (r as any)?.value?.status, ms: Date.now() - t0, resultKeys: r && typeof r === 'object' ? Object.keys(r as any) : typeof r })
  return r
}

export function probeFetchFailed($: any, e: any, next: any): any {
  plog({ ev: 'fetch-catch', url: e.url, called: next.called, error: { kind: next.error?.kind, message: next.error?.message, budget: next.error?.budget }, pending: jobs.size })
  if (next.called) return next(e)
  const b = e.init?.body
  if (jobs.size > 0 || String(e.url).includes(SHADOW_MODEL) || (typeof b === 'string' && b.includes(SHADOW_MODEL))) return { value: refuse() }
  return next(e)
}

// ---- turn.step hook (routed model)

function chunkSummary(c: any): Record<string, unknown> {
  if (!c || typeof c !== 'object') return { kind: typeof c }
  const s: Record<string, unknown> = { kind: c.kind }
  for (const f of ['ref', 'index', 'id', 'name', 'stopReason']) if (c[f] !== undefined) s[f] = c[f]
  if (typeof c.text === 'string') s.text = c.text.slice(0, 200)
  if (typeof c.json === 'string') s.json = c.json.slice(0, 300)
  if (c.usage !== undefined) s.usage = c.usage
  return s
}

// JSON with object keys sorted: the engine reorders a tool call's arguments.
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x))
}

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b)
}

export async function* probeStep($: any, e: any, next: any, route: Route, cfg: Config, io: any, threads: Threads): AsyncGenerator<any, any, unknown> {
  const k = await attach($)
  const key = loopKeyOf(e.agentId)
  status.set(key, 'routed')
  seen.routed = true
  seen.anyStep = true
  const secrets = secretsOf(cfg)
  let send: (fetch: Fetch, request: any) => Promise<any>
  if (route.provider === 'anthropic' || route.provider === 'zai') {
    const row = ANTHROPIC_ROWS[route.provider]
    const apiKey = cfg.keys[route.provider]
    if (!apiKey) throw new Error(missingKeyMessage(route.provider))
    send = (fetch, request) => anthropicComplete(fetch, request, row, apiKey, secrets)
  } else {
    const t = targetFor(route, cfg)
    if (!t.ok) throw new Error(t.message)
    send = (fetch, request) => openaiComplete(fetch, request, e.effort, t.target, secrets)
  }
  if (jobs.has(key)) {
    plog({ ev: 'step-refused-pending', key, pending: jobs.get(key)?.id })
    throw new Error(`a job is already pending for loop ${key}`)
  }
  const handler = async (body: any, fetch: Fetch): Promise<Prepared> => {
    const resolved = resolveThread(body, threads.get(key), await recoveryFor(body, e.agentId, threads, io))
    if (!resolved.ok) return { ok: false, error: localError(routeLabel(route), resolved.message, secrets) }
    const request = buildRequest(normalizeBody(resolved.body), route.model, maxOutputTokens(e.model))
    // As `deliver` does today: the step's system prompt and tools are kept at once, the conversation withheld.
    recordStep(threads, key, resolved.body, [], resolved.anchors)
    dropBase(threads, key)
    return { ok: true, sent: resolved.body, anchors: resolved.anchors, call: send(fetch, request) }
  }
  let abandon: Job['abandon'] = () => undefined
  const abandoned = new Promise<'timeout' | 'cancelled'>(resolve => {
    abandon = resolve
  })
  const job: Job = { id: ++seq.job, key, messageCount: e.messageCount, phase: 'registered', handler, abandoned, abandon }
  jobs.set(key, job)
  const t0 = Date.now()
  plog({ ev: 'step-begin', job: job.id, key, model: e.model, messageCount: e.messageCount, turnId: e.turnId, index: e.index, agentId: e.agentId })
  const onAbort = () => {
    plog({ ev: 'step-signal-abort', job: job.id, phase: job.phase, ms: Date.now() - t0 })
    abandon('cancelled')
  }
  next.signal.addEventListener('abort', onAbort, { once: true })
  const timer = new AbortController()
  if (k.timeoutMode === 'b' && k.timeoutMs) {
    $.clock.sleep(k.timeoutMs, { signal: timer.signal }).then(
      () => {
        plog({ ev: 'step-timer-fired', job: job.id, phase: job.phase, ms: Date.now() - t0 })
        if (job.phase === 'registered' || job.phase === 'captured') abandon('timeout')
      },
      (err: unknown) => plog({ ev: 'step-timer-ended', job: job.id, err: String(err), ms: Date.now() - t0 }),
    )
  }
  const chunks: any[] = []
  let completed = false
  let result: any
  let how = 'left' // `left`: the generator was closed by its consumer (.return()) or abandoned
  try {
    if (k.flow === 'around') {
      // The rejected alternative: the engine's own chunks of an empty stub
      // around hook-made chunks of a reply fetched from the step hook.
      const engine: any[] = []
      for await (const c of next({ ...e, model: SHADOW_MODEL })) engine.push(c)
      plog({ ev: 'around-engine-chunks', chunks: engine.map(chunkSummary) })
      const prep = await handler(job.body, (url, init) => $.http.fetch(url, init))
      if (!prep.ok) throw new Error(prep.error.text)
      const h = { result: await prep.call }
      if (!h.result.ok) throw new Error(h.result.error.text)
      const stubStop = engine.find(c => c?.kind === 'stop')
      if (engine[0]) yield engine[0]
      for (const c of toChunks(h.result.reply)) yield c.kind === 'stop' && stubStop?.ref !== undefined ? { ...c, ref: stubStop.ref } : c
      if (engine.length > 1) yield engine[engine.length - 1]
      how = 'around'
      const r = h.result.reply
      recordStep(threads, key, prep.sent, r.content, prep.anchors)
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: r.content.flatMap(b => (b.type === 'tool_use' ? [{ name: b.name, input: b.input ?? {} }] : [])), stopReason: r.stopReason, usage: { ...r.usage, model: r.model } }
    }
    const it = next({ ...e, model: SHADOW_MODEL })[Symbol.asyncIterator]()
    for (;;) {
      const r = await it.next()
      if (r.done) {
        result = r.value
        break
      }
      // An error staged for hook-made delivery: the stub's chunks are drained, not passed up.
      if (job.hookError) continue
      chunks.push(chunkSummary(r.value))
      plog({ ev: 'chunk', job: job.id, n: chunks.length, phase: job.phase, ms: Date.now() - t0, ...chunkSummary(r.value) })
      if (k.abandonAfter && chunks.length >= k.abandonAfter) {
        // Stop reading beneath and never finish: what does the host do?
        plog({ ev: 'step-stops-reading', job: job.id })
        await new Promise(() => undefined)
      }
      yield r.value
    }
    completed = true
    how = 'completed'
    if (job.hookError) {
      how = 'completed (hook-made error chunks)'
      result = yield* errorChunks(e, job.hookError)
    }
    return result
  } catch (err) {
    how = `threw: ${String(err)}`
    throw err
  } finally {
    timer.abort()
    next.signal.removeEventListener('abort', onAbort)
    if (jobs.get(key) === job) jobs.delete(key)
    const o = job.outcome
    const match = o && result ? { stopReason: result.stopReason === o.stopReason, answer: result.answer === o.text.trim(), exactAnswer: result.answer === o.text, toolUses: same(result.toolUses, o.toolUses), exactToolUses: JSON.stringify(result.toolUses) === JSON.stringify(o.toolUses) } : null
    plog({
      ev: 'step-finally',
      job: job.id,
      how,
      phase: job.phase,
      aborted: next.signal.aborted,
      ms: Date.now() - t0,
      nChunks: chunks.length,
      result: result === undefined ? null : { keys: Object.keys(result ?? {}), answer: typeof result?.answer === 'string' ? result.answer.slice(0, 300) : result?.answer, toolUses: JSON.stringify(result?.toolUses ?? null).slice(0, 500), stopReason: result?.stopReason, usage: result?.usage },
      staged: o ? { kind: o.kind, messageId: o.messageId, stopReason: o.stopReason, text: o.text.slice(0, 300), toolUses: JSON.stringify(o.toolUses).slice(0, 500) } : null,
      match,
    })
    if (k.flow !== 'around') {
      const delivered = completed && job.phase === 'handed' && o?.sent && !next.signal.aborted && (o.kind === 'reply' || o.kind === 'error') && result?.stopReason != null && match?.stopReason && match.answer && match.toolUses
      if (delivered) recordStep(threads, key, o.sent, o.assistant, o.anchors ?? {})
      else dropBase(threads, key)
      plog({ ev: 'thread', job: job.id, recorded: Boolean(delivered) })
    }
  }
}

export async function probeUnprefixed($: any, e: any): Promise<void> {
  await attach($)
  status.set(loopKeyOf(e.agentId), 'unrouted')
  seen.anyStep = true
  plog({ ev: 'step-unprefixed', key: loopKeyOf(e.agentId), model: e.model, turnId: e.turnId, index: e.index })
}

// ---- observers: tool.check and turn.complete

export async function probeToolCheck($: any, e: any, next: any): Promise<any> {
  await attach($)
  const key = loopKeyOf(e.agentId)
  const t0 = Date.now()
  plog({ ev: 'tool.check', key, tool: e.name ?? e.tool ?? e.toolName, keys: Object.keys(e ?? {}), jobPending: jobs.has(key), origin: next.origin })
  const r = await next(e)
  plog({ ev: 'tool.check-result', key, tool: e.name ?? e.tool ?? e.toolName, result: JSON.stringify(r ?? null).slice(0, 400), ms: Date.now() - t0, jobPending: jobs.has(key) })
  return r
}

export async function probeTurnComplete($: any, e: any): Promise<void> {
  await attach($)
  let usage: unknown
  try {
    usage = await $.session.usage()
  } catch (err) {
    usage = `threw: ${String(err)}`
  }
  plog({ ev: 'turn.complete', key: loopKeyOf(e.agentId), sessionUsage: JSON.stringify(usage ?? null).slice(0, 1500) })
}
