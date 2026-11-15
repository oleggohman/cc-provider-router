// The plugin's hooks module: registers the `http.fetch` shadow capture, the
// routed `turn.step`, compaction on `turn.complete`, and `/providers`; and
// `routedStep`, one routed step: the engine's request answered in place with
// the provider's reply, then the delivery decision.

import type { Register } from 'claude-code'
import { answerShadow, providerSend, type AnswerJob } from './answer.ts'
import { DEFAULT_TIMEOUT_MS, type Fetch, type FetchSide, type Sleep } from './call.ts'
import type { Reply } from './chunks.ts'
import { autoModeClassifierOf, loadConfig, secretsOf, type Config } from './config.ts'
import { maybeCompact, recordUsage, type UsageMap } from './context.ts'
import { PREFIX, errorChunks, localError, sanitize } from './errors.ts'
import { providersCommand } from './providers-command.ts'
import { ID_FORMS, classifyModel, prefixOf, routeLabel, type ModelKind, type Route } from './route.ts'
import {
  SHADOW_MODEL,
  closeShadow,
  endShadow,
  latestJob,
  loopKeyOf,
  noteStep,
  openShadow,
  shadowFetch,
  shadowFetchFailed,
  shadowStats,
  type OpenedShadow,
  type ShadowError,
  type ShadowHandler,
  type ShadowOptions,
  type ShadowStepEvent,
} from './shadow.ts'
import { sameDelivery } from './sse.ts'
import { dropBase, recordStep, type Recovery, type Threads } from './thread.ts'
import { checkCurl, curlFetch, fallbackFetch, selectTransport, type Spawn, type TransportCache, type TransportKind } from './transport.ts'

// What the router keeps per loop between steps.
export type LoopState = { usage: UsageMap; threads: Threads }

type StepEvent = ShadowStepEvent & { turnId: string; index: number; effort?: string | number }

// What a routed step needs from `$` and `next`; tests pass stand-ins (the
// test kit refuses `$.http.fetch` from a test's own hooks). `history` reads
// the loop's conversation from the session (see thread.ts Recovery);
// `agents` the session's agents, to tell a fork from a subagent.
export type StepIO = {
  fetch: Fetch
  sleep: Sleep
  signal: AbortSignal
  timeoutMs?: number
  history?: () => Promise<any[] | undefined>
  agents?: () => Promise<AgentRef[] | undefined>
}

// What forkedLoop reads of a `$.agent.list()` entry.
export type AgentRef = { id: string; type?: string; parentId?: string }

// Back on the subscription: the engine tracks this loop's context and thread.
export function onUnprefixedStep(s: LoopState, agentId: string | undefined): void {
  const key = loopKeyOf(agentId)
  s.usage.delete(key)
  s.threads.delete(key)
}

// A subagent's turn ended: its usage and conversation (the large part, images
// included) are freed. Its system prompt and tools stay, so a resumed agent's
// continue can be rebuilt from the session history.
export function onSubagentTurnEnd(s: LoopState, agentId: string): void {
  const key = loopKeyOf(agentId)
  s.usage.delete(key)
  dropBase(s.threads, key)
}

// Notes a step of any loop for the session flags of the autoModeClassifier
// opt-out (shadow.ts): an id with a router prefix, malformed included, counts
// as routed.
export function markStep(model: ModelKind): void {
  noteStep(model.kind !== 'unprefixed')
}

// The loop's conversation in Messages API form, for rebuilding a continue the
// router has no conversation for; undefined when the session cannot say.
async function readHistory($: any, agentId: string | undefined): Promise<any[] | undefined> {
  try {
    const r = await $.session.messages(agentId ? { as: 'api', agentId } : { as: 'api' })
    return Array.isArray(r) ? r : undefined
  } catch {
    return undefined
  }
}

// The session's agents (`$.agent.list()`); undefined when it cannot say.
async function readAgents($: any): Promise<AgentRef[] | undefined> {
  try {
    const r = await $.agent.list()
    return Array.isArray(r) ? r : undefined
  } catch {
    return undefined
  }
}

// The config, loaded once per module load. A rejected load is not kept: the
// next call loads again (e.g. after an env read was refused once).
type ConfigCache = { config?: Promise<Config> }

function cachedConfig($: any, options: Parameters<Register>[1], cache: ConfigCache): Promise<Config> {
  cache.config ??= loadConfig($, options).catch(err => {
    cache.config = undefined
    throw err
  })
  return cache.config
}

// The provider transport this module load uses: curl when `curl --version`
// runs (checked once, cached in `transport`), else `$.http.fetch`.
async function transportOf($: any, transport: TransportCache, signal?: AbortSignal): Promise<TransportKind> {
  const spawn: Spawn = req => $.process.spawn(req)
  return selectTransport(transport, () => checkCurl(spawn, signal))
}

// What the `http.fetch` hook hands a captured shadow request's handler: the
// provider transport built from that hook's own `$`, so a curl child dies
// with that hook's dispatch (Esc, abandonment) or when the call's loop ends
// (timeout, overflow; transport.ts). On curl a start failure falls back to
// `$.http.fetch` (nothing was sent); any later failure is the call's error.
export async function fetchSide($: any, signal: AbortSignal, transport: TransportCache, cache: ConfigCache, options: Parameters<Register>[1]): Promise<FetchSide> {
  const sleep: Sleep = (ms, opts) => $.clock.sleep(ms, opts)
  const httpFetch: Fetch = (url, init) => $.http.fetch(url, init)
  const kind = await transportOf($, transport, signal)
  if (kind === 'fetch') return { fetch: httpFetch, sleep, signal, transport: 'fetch' }
  const secrets = secretsOf(await cachedConfig($, options, cache))
  const spawn: Spawn = req => $.process.spawn(req)
  const curl = curlFetch(spawn, { signal, timeoutMs: DEFAULT_TIMEOUT_MS, sleep, secrets })
  return { fetch: fallbackFetch(curl, httpFetch, transport), sleep, signal, transport: 'curl' }
}

// Provider router: routes each model request by its model id's prefix.
// Unprefixed models go to the engine untouched (the signed-in subscription).
// Config comes from `options` (a /config change reloads this module) and env,
// read on the first routed step; a failed read is retried on the next one.
export const register: Register = (on, options) => {
  const cache: ConfigCache = {}
  const transport: TransportCache = {}
  const state: LoopState = { usage: new Map(), threads: new Map() }
  // Read from the options alone (no env), so the fetch hook has it at once.
  const shadowOptions: ShadowOptions = { autoModeClassifier: autoModeClassifierOf(options) }

  // Shadow capture: answers the engine's shadow requests locally and refuses
  // every request that could be one, or that names a router-prefixed model;
  // lets the auto-mode classifier through per the option (see shadow.ts).
  // Fail closed: a guard that fails is otherwise skipped and the request goes on.
  // A captured request's handler gets this hook's provider transport.
  on('http.fetch', async ($, e, next) => shadowFetch(e, next, shadowOptions, () => fetchSide($, next.signal, transport, cache, options)) as any).catch((_$, e, next) => shadowFetchFailed(e, next, shadowOptions) as any)

  on('turn.step', async function* ($, e, next) {
    const model = classifyModel(e.model)
    markStep(model)
    if (model.kind === 'unprefixed') {
      onUnprefixedStep(state, e.agentId)
      return yield* next(e)
    }
    // From here on the step never reaches the engine with its own model id:
    // any failure becomes a local error reply.
    const key = loopKeyOf(e.agentId)
    let secrets: string[] = []
    try {
      if (model.kind === 'malformed') {
        dropBase(state.threads, key)
        return yield* errorChunks(e, localError(model.prefix, `malformed model id "${e.model}": use ${ID_FORMS}`))
      }
      const cfg = await cachedConfig($, options, cache)
      secrets = secretsOf(cfg)
      const io: StepIO = {
        fetch: (url, init) => $.http.fetch(url, init),
        sleep: (ms, opts) => $.clock.sleep(ms, opts),
        signal: next.signal,
        history: () => readHistory($, e.agentId),
        agents: () => readAgents($),
      }
      const result = yield* routedStep(e, next, model.route, cfg, io, state.threads)
      recordUsage(state.usage, key, e.model, result?.usage)
      return result
    } catch (err) {
      dropBase(state.threads, key)
      return yield* errorChunks(e, localError(prefixOf(e.model), `internal error: ${String(err)}`, secrets))
    }
  }).catch(async function* (_$, e, next) {
    // The hook itself failed (threw past its own catch, or overran): a routed
    // model still never reaches the engine.
    const model = classifyModel(e.model)
    markStep(model)
    if (model.kind === 'unprefixed') return yield* next(e)
    return yield* errorChunks(e, localError(prefixOf(e.model), `internal error: ${next.error.message ?? next.error.kind}`))
  })

  // Compaction for routed main-loop turns: scheduled after the turn has
  // ended, never inside this hook (compact rejects while a turn runs).
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) {
      onSubagentTurnEnd(state, e.agentId)
      return result
    }
    if (!state.usage.has(loopKeyOf(undefined))) return result
    try {
      const cfg = await cachedConfig($, options, cache)
      maybeCompact(state.usage, cfg.contextWindows, {
        after: (ms, fn) => $.clock.after(ms, fn),
        compact: () => $.session.compact(),
      })
    } catch {
      // Config unavailable: no compaction this turn.
    }
    return result
  })

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'providers', description: 'Provider router: configured providers, keys, shadow counters; /providers models lists models', argumentHint: '[models]' })
    } catch {
      // Registration refused (e.g. a mode without commands): the router still works.
    }
    return next(e)
  })

  on('command.run', { command: 'providers' }, async ($, e) => {
    let secrets: string[] = []
    try {
      const cfg = await cachedConfig($, options, cache)
      secrets = secretsOf(cfg)
      let kind: TransportKind | undefined
      try {
        kind = await transportOf($, transport)
      } catch {
        kind = undefined
      }
      const text = await providersCommand(e.args ?? '', cfg, (url, init) => $.http.fetch(url, init), shadowStats(), (ms, opts) => $.clock.sleep(ms, opts), kind)
      return { text }
    } catch (err) {
      return { text: sanitize(`${PREFIX} /providers failed: ${String(err)}`, secrets) }
    }
  })
}

// The step ended by Esc: no chunks, no error text, no response.
function cancelled(e: { turnId: string; index: number }) {
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
}

// The loop a never-seen loop forks, by `$.agent.list()`: an id the list does
// not name is an engine fork (compaction, memory) of the main loop; a listed
// `fork` forks its parent. Any other listed agent is a real subagent with its
// own system prompt and tools, and so is every id when the list cannot be
// read: undefined, no fork.
async function forkedLoop(agentId: string, io: StepIO): Promise<string | undefined> {
  let agents: AgentRef[] | undefined
  try {
    agents = await io.agents?.()
  } catch {
    agents = undefined
  }
  if (!Array.isArray(agents)) return undefined
  const self = agents.find(a => a?.id === agentId)
  if (!self) return loopKeyOf(undefined)
  return self.type === 'fork' ? loopKeyOf(self.parentId) : undefined
}

// For a continue the loop holds no conversation for: the session history and,
// for a fork the router has no state for, the forked loop's state.
async function recoveryFor(body: any, agentId: string | undefined, threads: Threads, io: StepIO): Promise<Recovery> {
  const key = loopKeyOf(agentId)
  if (body?.thread?.type !== 'continue' || threads.get(key)?.base) return {}
  let history: any[] | undefined
  try {
    history = await io.history?.()
  } catch {
    history = undefined
  }
  if (!agentId || threads.has(key)) return { history }
  const forked = await forkedLoop(agentId, io)
  return { history, fallback: forked === undefined ? undefined : threads.get(forked) }
}

// The engine's result reflects the staged reply (sse.ts sameDelivery); a
// result of any other shape does not.
function delivered(result: any, reply: Reply): boolean {
  if (!result || typeof result !== 'object' || typeof result.answer !== 'string' || !Array.isArray(result.toolUses)) return false
  return sameDelivery(result, reply)
}

// A routed step, answered in place: the step registers a job for its loop
// whose handler (answer.ts answerShadow, run by the `http.fetch` hook) answers
// the engine's shadow request with the provider's reply as SSE; the engine's
// own chunks flow up from here; after the stream the step decides delivery
// from the job and the engine's result.
//
// Chunks the engine yields before the job was handed its answer are held:
// sent on once the answer is the reply, dropped when it is the empty stub (an
// error: the error chunks follow; Esc: nothing) or never came.
//
// Delivery (thread-state invariants, thread.ts). The handler keeps the step's
// system prompt and effective tools on the loop at capture, without its
// conversation, so any step cut short after capture has already dropped it.
// Then: a handed reply whose result matches (answer trimmed, tool arguments
// in any key order, the stop reason) with no Esc is recorded, the minted id
// bound as an anchor; a mismatch keeps it dropped. A handed error is recorded
// with its error text once the error chunks were read to the end without
// Esc. Esc records nothing (before capture the loop is left as it was). A
// step never captured, or captured but never handed, drops the conversation.
// A job is ended by the stream's `finally` or, when the dispatch is
// abandoned without one (the hook's budget), by the signal's abort listener;
// a late continuation touches the loop's state only while its job is the
// loop's newest.
export async function* routedStep<E extends StepEvent>(
  e: E,
  next: (e: E) => AsyncIterable<unknown>,
  route: Route,
  cfg: Config,
  io: StepIO,
  threads: Threads,
): AsyncGenerator<any, any, unknown> {
  const secrets = secretsOf(cfg)
  const name = routeLabel(route)
  const key = loopKeyOf(e.agentId)
  const early = (message: string) => {
    dropBase(threads, key)
    return errorChunks(e, localError(name, message, secrets))
  }
  // Check the key / endpoint before the shadow step: no engine work for a
  // step that cannot be answered.
  const target = providerSend(route, cfg, e.effort, io.fetch)
  if (!target.ok) return yield* early(target.message)
  let job: AnswerJob | undefined
  // Called by the `http.fetch` hook for the captured request, with that
  // hook's transport (`side`); the step's own io stands in without one.
  const handler: ShadowHandler = (body, side) =>
    answerShadow(job!, body, { event: e, route, config: cfg, threads }, {
      fetch: side?.fetch ?? io.fetch,
      sleep: side?.sleep ?? io.sleep,
      signal: side?.signal ?? io.signal,
      timeoutMs: io.timeoutMs,
      recovery: b => recoveryFor(b, e.agentId, threads, io),
      transport: side?.transport ?? 'fetch',
    })
  let opened: OpenedShadow
  try {
    opened = openShadow(key, { messageCount: e.messageCount, handler })
  } catch (err) {
    return yield* early(`shadow request failed: ${String(err)}`)
  }
  const current = opened.job as AnswerJob
  job = current
  const newest = () => latestJob(key) === current.id
  // Abandoned without a `finally` (Esc, the hook's budget, the dispatch
  // given up): the job ends here and a late answer is discarded.
  const onAbort = () => {
    if (current.phase !== 'handed') current.phase = 'abandoned'
    endShadow(key, current.id)
  }
  io.signal.addEventListener('abort', onAbort, { once: true })
  const handed = () => (current.phase === 'handed' ? current.outcome : undefined)
  const it = next({ ...e, model: SHADOW_MODEL })[Symbol.asyncIterator]()
  const held: unknown[] = []
  let result: any
  let failure: unknown
  let ended = false
  let uncaptured: ShadowError | undefined
  try {
    while (true) {
      const s = await it.next()
      if (s.done) {
        result = s.value
        break
      }
      const outcome = handed()
      if (outcome?.kind === 'reply') {
        yield* held.splice(0)
        yield s.value
      } else if (!outcome) held.push(s.value)
    }
    ended = true
  } catch (err) {
    failure = err
    ended = true
  } finally {
    io.signal.removeEventListener('abort', onAbort)
    if (!ended) {
      // Closed or left mid-stream: the engine's stream is closed too.
      try {
        await it.return?.()
      } catch {
        // The engine's own close failing changes nothing here.
      }
    }
    if (current.phase !== 'handed') current.phase = 'abandoned'
    uncaptured = closeShadow(key, opened, { aborted: io.signal.aborted, failure })
  }
  const outcome = handed()
  if (io.signal.aborted) {
    // Esc: nothing recorded. A reply already flowing ends as the engine says.
    return outcome?.kind === 'reply' && !failure ? result : cancelled(e)
  }
  if (uncaptured) {
    if (newest()) dropBase(threads, key)
    return yield* errorChunks(e, localError(name, `shadow request failed: ${String(uncaptured)}`, secrets))
  }
  if (!outcome) {
    if (newest()) dropBase(threads, key)
    const why = failure ? `the engine's stream failed: ${String(failure)}` : 'the reply was not handed to Claude Code (its request ended first)'
    return yield* errorChunks(e, localError(name, why, secrets))
  }
  if (outcome.kind === 'cancelled') {
    // The fetch hook's dispatch ended without Esc here: an empty answer, so
    // the step says so instead of ending silently.
    if (newest()) dropBase(threads, key)
    return yield* errorChunks(e, localError(name, 'the request was cancelled before the reply arrived', secrets))
  }
  if (outcome.kind === 'error') {
    const out = yield* errorChunks(e, outcome.error)
    // Recorded once the error chunks were read to the end, without Esc.
    if (newest()) {
      if (!failure && !io.signal.aborted && current.sent !== undefined) recordStep(threads, key, current.sent, [{ type: 'text', text: outcome.error.text }], current.anchors ?? {})
      else dropBase(threads, key)
    }
    return out
  }
  if (failure || !delivered(result, outcome.reply)) {
    if (newest()) dropBase(threads, key)
    if (failure) return yield* errorChunks(e, localError(name, `the engine's stream failed: ${String(failure)}`, secrets))
    return result
  }
  if (newest()) {
    const sent = current.sent
    const length = (Array.isArray(sent?.messages) ? sent.messages.length : 0) + 1
    recordStep(threads, key, sent, outcome.reply.content, { ...current.anchors, [outcome.messageId]: length })
  }
  // The provider's real usage, as before answer in place: the engine's result
  // carries the SSE's zeros.
  return { ...result, usage: { ...outcome.reply.usage, model: e.model } }
}
