import type { Register } from 'claude-code'
import { raceCall, type Sleep } from './call.ts'
import { toChunks, toResult } from './chunks.ts'
import { loadConfig, missingKeyMessage, type Config } from './config.ts'
import { errorChunks, localError } from './errors.ts'
import { ANTHROPIC_ROWS, complete as anthropicComplete, type AdapterResult, type Fetch } from './providers/anthropic.ts'
import { complete as openaiComplete, targetFor } from './providers/openai.ts'
import { buildRequest } from './request.ts'
import { parseModel, type Route } from './route.ts'
import { shadowFetch, shadowStep } from './shadow.ts'

function label(r: Route): string {
  return r.provider === 'custom' ? `custom:${r.name}` : r.provider
}

// Provider router: routes each model request by its model id's prefix.
// Unprefixed models go to the engine untouched (the signed-in subscription).
// Config comes from `options` (a /config change reloads this module) and env,
// read once on the first routed step.
export const register: Register = (on, options) => {
  let config: Promise<Config> | undefined

  // Shadow capture: answers the engine's shadow requests locally and refuses
  // every request that could be one (see shadow.ts). Fail closed.
  on('http.fetch', async (_$, e, next) => shadowFetch(e, next) as any)

  on('turn.step', async function* ($, e, next) {
    const route = parseModel(e.model)
    if (!route) return yield* next(e)
    config ??= loadConfig($, options)
    const io: StepIO = {
      fetch: (url, init) => $.http.fetch(url, init),
      sleep: (ms, opts) => $.clock.sleep(ms, opts),
      signal: next.signal,
    }
    return yield* routedStep(e, next, route, await config, io)
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
  const built = buildRequest(body, route, e)
  if (!io) return yield* errorChunks(e, localError(name, 'no network access in this context', secrets))
  const out = await raceCall(io.sleep, io.signal, () => send(io, built), io.timeoutMs)
  switch (out.kind) {
    case 'cancelled':
      return cancelled(e)
    case 'timeout':
      return yield* errorChunks(e, localError(name, `no reply within ${out.ms} ms (timed out)`, secrets))
    case 'failed':
      return yield* errorChunks(e, localError(name, `request failed: ${String(out.error)}`, secrets))
    case 'done':
      if (!out.value.ok) return yield* errorChunks(e, out.value.error)
      yield* toChunks(out.value.reply)
      return toResult(e, out.value.reply)
  }
}
