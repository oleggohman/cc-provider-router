// The plugin's hooks module: registers the `http.fetch` shadow capture, the
// routed `turn.step`, compaction on `turn.complete`, and `/providers`; and
// `routedStep`, one routed step from shadow capture to provider reply.

import type { Register } from 'claude-code'
import { raceCall, type AdapterResult, type Fetch, type Sleep } from './call.ts'
import { toChunks, toResult } from './chunks.ts'
import { loadConfig, missingKeyMessage, secretsOf, type Config } from './config.ts'
import { maybeCompact, recordUsage, withContextHint, type UsageMap } from './context.ts'
import { PREFIX, errorChunks, localError, sanitize } from './errors.ts'
import { maxOutputTokens } from './limits.ts'
import { ANTHROPIC_ROWS, complete as anthropicComplete } from './providers/anthropic.ts'
import { complete as openaiComplete, targetFor } from './providers/openai.ts'
import { providersCommand } from './providers-command.ts'
import { buildRequest, type ProviderRequest } from './request.ts'
import { ID_FORMS, classifyModel, prefixOf, routeLabel, type Route } from './route.ts'
import { loopKeyOf, shadowFetch, shadowFetchFailed, shadowStats, shadowStep, type ShadowStepEvent } from './shadow.ts'
import { dropBase, normalizeBody, recordStep, resolveThread, type Recovery, type Threads } from './thread.ts'

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

// Provider router: routes each model request by its model id's prefix.
// Unprefixed models go to the engine untouched (the signed-in subscription).
// Config comes from `options` (a /config change reloads this module) and env,
// read on the first routed step; a failed read is retried on the next one.
export const register: Register = (on, options) => {
  const cache: ConfigCache = {}
  const state: LoopState = { usage: new Map(), threads: new Map() }

  // Shadow capture: answers the engine's shadow requests locally and refuses
  // every request that could be one (see shadow.ts). Fail closed: a guard
  // that fails is otherwise skipped and the request goes on.
  on('http.fetch', async (_$, e, next) => shadowFetch(e, next) as any).catch((_$, e, next) => shadowFetchFailed(e, next) as any)

  on('turn.step', async function* ($, e, next) {
    const model = classifyModel(e.model)
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
    if (classifyModel(e.model).kind === 'unprefixed') return yield* next(e)
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
      const text = await providersCommand(e.args ?? '', cfg, (url, init) => $.http.fetch(url, init), shadowStats(), (ms, opts) => $.clock.sleep(ms, opts))
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

// A routed step: shadow capture, provider request, reply. The engine's own
// shadow chunks are drained inside shadowStep and never yielded here.
//
// Thread-state invariants (thread.ts): a step that reached the provider and
// failed is recorded with its error text as the assistant turn (the engine
// records it so); a step cancelled before its reply was delivered records
// nothing; a step whose delivery was cut short, or that failed before its
// request was captured, drops the loop's conversation, since the engine
// records a turn the router cannot place. A step is recorded only once its
// reply is delivered (see deliver).
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
  let send: (request: ProviderRequest) => Promise<AdapterResult>
  if (route.provider === 'anthropic' || route.provider === 'zai') {
    const row = ANTHROPIC_ROWS[route.provider]
    const apiKey = cfg.keys[route.provider]
    if (!apiKey) return yield* early(missingKeyMessage(route.provider))
    send = request => anthropicComplete(io.fetch, request, row, apiKey, secrets)
  } else {
    const t = targetFor(route, cfg)
    if (!t.ok) return yield* early(t.message)
    send = request => openaiComplete(io.fetch, request, e.effort, t.target, secrets)
  }
  let body: any
  try {
    body = await shadowStep(e, next, io.signal)
  } catch (err) {
    // Esc during the shadow step ends the step as cleanly as Esc during the
    // provider call.
    if (io.signal.aborted) return cancelled(e)
    return yield* early(`shadow request failed: ${String(err)}`)
  }
  // Message threads: rebuild a continue into the full conversation.
  const resolved = resolveThread(body, threads.get(key), await recoveryFor(body, e.agentId, threads, io))
  if (!resolved.ok) return yield* early(resolved.message)
  const request = buildRequest(normalizeBody(resolved.body), route.model, maxOutputTokens(e.model))
  // A reply counts as delivered once the engine has read every chunk, the
  // stop chunk included, and asked for the result without Esc. Only then is
  // the step recorded. Until then the loop keeps this step's system prompt
  // and tools but no conversation: a delivery cut short (Esc, the stream
  // closed or left) leaves the engine with an unknown part of the reply, so
  // the next continue is rebuilt from the session history instead of
  // resending a reply (and tool calls) the engine never took.
  const { body: sent, anchors } = resolved
  function* deliver<R>(chunks: Generator<any, R, unknown>, assistant: any[]): Generator<any, R, unknown> {
    recordStep(threads, key, sent, assistant, anchors)
    const done = threads.get(key)!
    dropBase(threads, key)
    const result = yield* chunks
    if (!io.signal.aborted) threads.set(key, done)
    return result
  }
  const fail = (err: ReturnType<typeof localError>) => deliver(errorChunks(e, err), [{ type: 'text', text: err.text }])
  const out = await raceCall(io.sleep, io.signal, () => send(request), io.timeoutMs)
  switch (out.kind) {
    case 'cancelled':
      // Nothing recorded: the next continue builds on the last recorded turn.
      return cancelled(e)
    case 'timeout':
      return yield* fail(localError(name, `no reply within ${out.ms} ms (timed out)`, secrets))
    case 'failed':
      return yield* fail(localError(name, `request failed: ${String(out.error)}`, secrets))
    case 'done':
      if (!out.value.ok) return yield* fail(withContextHint(out.value.error, e.agentId))
      yield* deliver(toChunks(out.value.reply), out.value.reply.content)
      return toResult(e, out.value.reply)
  }
}
