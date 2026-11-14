import type { Register } from 'claude-code'
import { loadConfig, type Config } from './config.ts'
import { errorChunks, localError } from './errors.ts'
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
    return yield* routedStep(e, next, route, await config)
  })
}

type StepEvent = { turnId: string; index: number; model: string; messageCount: number; agentId?: string; effort?: string | number }

// A routed step: shadow capture, provider request, reply. The engine's own
// shadow chunks are drained inside shadowStep and never yielded here.
export async function* routedStep<E extends StepEvent>(
  e: E,
  next: (e: E) => AsyncIterable<unknown>,
  route: Route,
  cfg: Config,
): AsyncGenerator<any, any, unknown> {
  const secrets = [...Object.values(cfg.keys), ...[...cfg.custom.values()].map(c => c.key)]
  let body: any
  try {
    body = await shadowStep(e, next)
  } catch (err) {
    return yield* errorChunks(e, localError(label(route), `shadow request failed: ${String(err)}`, secrets))
  }
  const built = buildRequest(body, route, e)
  void built
  // Provider adapters arrive in Tasks 5-6. Until then a routed step ends
  // with a clear error and never reaches the network.
  return yield* errorChunks(e, localError(label(route), `adapter for ${label(route)} not implemented yet`, secrets))
}
