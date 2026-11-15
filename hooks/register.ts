import type { Register } from 'claude-code'
import { raceCall, type Sleep } from './call.ts'
import { toChunks, toResult } from './chunks.ts'
import { loadConfig, missingKeyMessage, type Config } from './config.ts'
import { createTracker, maybeCompact, trackUsage, withContextHint } from './context.ts'
import { errorChunks, localError, sanitize } from './errors.ts'
import { ANTHROPIC_ROWS, complete as anthropicComplete, type AdapterResult, type Fetch } from './providers/anthropic.ts'
import { complete as openaiComplete, targetFor } from './providers/openai.ts'
import { buildRequest } from './request.ts'
import { providersCommand } from './providers-command.ts'
import { parseModel, type Route } from './route.ts'
import { shadowFetch, shadowStats, shadowStep } from './shadow.ts'
import { createThreads, loopKeyOf, normalizeBody, recordStep, resolveThread, type Threads } from './thread.ts'

function label(r: Route): string {
  return r.provider === 'custom' ? `custom:${r.name}` : r.provider
}

// Provider router: routes each model request by its model id's prefix.
// Unprefixed models go to the engine untouched (the signed-in subscription).
// Config comes from `options` (a /config change reloads this module) and env,
// read once on the first routed step.
export const register: Register = (on, options) => {
  let config: Promise<Config> | undefined
  // Last routed input size per loop, for compaction (see context.ts).
  const usage = createTracker()
  // Each loop's conversation, for the engine's thread continues (see thread.ts).
  const threads = createThreads()

  // Shadow capture: answers the engine's shadow requests locally and refuses
  // every request that could be one (see shadow.ts). Fail closed.
  on('http.fetch', async (_$, e, next) => shadowFetch(e, next) as any)

  on('turn.step', async function* ($, e, next) {
    const route = parseModel(e.model)
    if (!route) {
      // Back on the subscription: the engine tracks this loop's context.
      usage.clear(e.agentId)
      threads.delete(loopKeyOf(e.agentId))
      return yield* next(e)
    }
    const cfg = await (config ??= loadConfig($, options))
    const io: StepIO = {
      fetch: (url, init) => $.http.fetch(url, init),
      sleep: (ms, opts) => $.clock.sleep(ms, opts),
      signal: next.signal,
    }
    return yield* trackUsage(usage, e, routedStep(e, next, route, cfg, io, threads))
  })

  // Compaction for routed main-loop turns: scheduled after the turn has
  // ended, never inside this hook (compact rejects while a turn runs).
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && !usage.get(undefined)) return result
    const cfg = await (config ??= loadConfig($, options))
    maybeCompact(usage, cfg.contextWindows, e, {
      after: (ms, fn) => $.clock.after(ms, fn),
      compact: () => $.session.compact(),
    })
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
    const cfg = await (config ??= loadConfig($, options))
    try {
      const text = await providersCommand(e.args ?? '', cfg, (url, init) => $.http.fetch(url, init), shadowStats())
      return { text }
    } catch (err) {
      const secrets = [...Object.values(cfg.keys), ...[...cfg.custom.values()].map(c => c.key)]
      return { text: sanitize(`[provider-router] /providers failed: ${String(err)}`, secrets) }
    }
  })
}

type StepEvent = { turnId: string; index: number; model: string; messageCount: number; agentId?: string; effort?: string | number }

// What a routed step needs from `$` and `next`; tests pass stand-ins (the
// test kit refuses `$.http.fetch` from a test's own hooks).
export type StepIO = { fetch: Fetch; sleep: Sleep; signal: AbortSignal; timeoutMs?: number }

// The step ended by Esc: no chunks, no error text, no response.
function cancelled(e: { turnId: string; index: number }) {
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
}

// A routed step: shadow capture, provider request, reply. The engine's own
// shadow chunks are drained inside shadowStep and never yielded here.
export async function* routedStep<E extends StepEvent>(
  e: E,
  next: (e: E) => AsyncIterable<unknown>,
  route: Route,
  cfg: Config,
  io?: StepIO,
  threads: Threads = createThreads(),
): AsyncGenerator<any, any, unknown> {
  const secrets = [...Object.values(cfg.keys), ...[...cfg.custom.values()].map(c => c.key)]
  const name = label(route)
  // Check the key / endpoint before the shadow step: no engine work for a
  // step that cannot be answered.
  let send: (io: StepIO, built: ReturnType<typeof buildRequest>) => Promise<AdapterResult>
  if (route.provider === 'anthropic' || route.provider === 'zai') {
    const row = ANTHROPIC_ROWS[route.provider]
    const key = cfg.keys[route.provider]
    if (!key) return yield* errorChunks(e, localError(name, missingKeyMessage(route.provider), secrets))
    send = (io, built) => anthropicComplete(io.fetch, built.request, row, key)
  } else {
    const t = targetFor(route, cfg)
    if (!t.ok) return yield* errorChunks(e, localError(name, t.message, secrets))
    send = (io, built) => openaiComplete(io.fetch, built.request, built.effort, t.target)
  }
  let body: any
  try {
    body = await shadowStep(e, next)
  } catch (err) {
    return yield* errorChunks(e, localError(name, `shadow request failed: ${String(err)}`, secrets))
  }
  // Message threads: rebuild a continue into the full conversation.
  const key = loopKeyOf(e.agentId)
  const resolved = resolveThread(body, threads.get(key))
  if (!resolved.ok) return yield* errorChunks(e, localError(name, resolved.message, secrets))
  const built = buildRequest(normalizeBody(resolved.body), route, e)
  if (!io) return yield* errorChunks(e, localError(name, 'no network access in this context', secrets))
  // The engine records an error step's text as the assistant turn; keep the
  // same in the loop's state so the next continue lines up.
  const fail = (err: ReturnType<typeof localError>) => {
    recordStep(threads, key, resolved.body, [{ type: 'text', text: err.text }])
    return errorChunks(e, err)
  }
  const out = await raceCall(io.sleep, io.signal, () => send(io, built), io.timeoutMs)
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
      recordStep(threads, key, resolved.body, out.value.reply.content)
      yield* toChunks(out.value.reply)
      return toResult(e, out.value.reply)
  }
}
