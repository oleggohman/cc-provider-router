import type { Register } from 'claude-code'
import { loadConfig, type Config } from './config.ts'
import { parseModel } from './route.ts'

// Provider router: routes each model request by its model id's prefix.
// Unprefixed models go to the engine untouched (the signed-in subscription).
// Config comes from `options` (a /config change reloads this module) and env,
// read once on the first routed step.
export const register: Register = (on, options) => {
  let config: Promise<Config> | undefined

  on('turn.step', async function* ($, e, next) {
    const route = parseModel(e.model)
    if (!route) return yield* next(e)
    config ??= loadConfig($, options)
    await config
    // Dispatch stub: provider calls arrive in later tasks. Until then a routed
    // model passes through, so the mod never breaks a session.
    return yield* next(e)
  })
}
