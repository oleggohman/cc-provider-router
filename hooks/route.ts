// Model-id router: decides from a model id's prefix which provider serves it.

type Simple = 'anthropic' | 'openai' | 'zai'

export type Route = { [P in Simple]: { provider: P; model: string } }[Simple] | { provider: 'custom'; name: string; model: string }

const SIMPLE: readonly Simple[] = ['anthropic', 'openai', 'zai']

// Parses `anthropic:<id>`, `openai:<id>`, `zai:<id>` or `custom:<name>:<id>`.
// `<id>` may contain `/` and `:`. Returns null for an unprefixed id (the
// router passes it to the engine untouched) and for a malformed one (see
// malformedPrefix).
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

// The router prefix of an id that has one but does not parse (`openai:`,
// `custom:gw`, `custom:gw:`): such a step is answered with a local error,
// never sent to the engine on the subscription.
export function malformedPrefix(id: string): string | undefined {
  const prefix = id.slice(0, Math.max(0, id.indexOf(':')))
  if (![...SIMPLE, 'custom'].includes(prefix)) return undefined
  return parseModel(id) ? undefined : prefix
}
