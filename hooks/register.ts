import type { Register } from 'claude-code'
import { parseModel } from './route.ts'

// Provider router: routes each model request by its model id's prefix.
// Unprefixed models go to the engine untouched (the signed-in subscription).
export const register: Register = (on) => {
  on('turn.step', async function* ($, e, next) {
    const route = parseModel(e.model)
    if (!route) return yield* next(e)
    // Dispatch stub: provider calls arrive in later tasks. Until then a routed
    // model passes through, so the mod never breaks a session.
    return yield* next(e)
  })
}
