// Model-id router: decides from a model id's prefix which provider serves it.

export type Route =
  | { provider: 'anthropic' | 'openai' | 'zai'; model: string }
  | { provider: 'custom'; name: string; model: string }

const SIMPLE = ['anthropic', 'openai', 'zai'] as const

// Parses `anthropic:<id>`, `openai:<id>`, `zai:<id>` or `custom:<name>:<id>`.
// `<id>` may contain `/` and `:`. Returns null for an unprefixed or malformed
// id, which the router passes to the engine untouched.
export function parseModel(id: string): Route | null {
  const colon = id.indexOf(':')
  if (colon < 0) return null
  const prefix = id.slice(0, colon)
  const rest = id.slice(colon + 1)
  for (const p of SIMPLE) {
    if (prefix === p) return rest ? { provider: p, model: rest } : null
  }
  if (prefix === 'custom') {
    const sep = rest.indexOf(':')
    if (sep <= 0) return null
    const name = rest.slice(0, sep)
    const model = rest.slice(sep + 1)
    return model ? { provider: 'custom', name, model } : null
  }
  return null
}
