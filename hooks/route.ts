// Model-id router: decides from a model id's prefix which provider serves it.

// The built-in providers: `<provider>:<id>`, each with its own key (config.ts).
export type SimpleProvider = 'anthropic' | 'openai' | 'zai' | 'xai'

export type Route = { [P in SimpleProvider]: { provider: P; model: string } }[SimpleProvider] | { provider: 'custom'; name: string; model: string }

const SIMPLE: readonly SimpleProvider[] = ['anthropic', 'openai', 'zai', 'xai']

// Every router prefix: an id starting with one is the router's, never the
// engine's (shadow.ts refuses such ids on the way to the first-party host).
export const ROUTER_PREFIXES: readonly string[] = [...SIMPLE, 'custom']

// The id forms the router accepts, as named in error text.
export const ID_FORMS = `${SIMPLE.map(p => `${p}:<id>`).join(', ')} or custom:<name>:<id>`

// Parses `anthropic:<id>`, `openai:<id>`, `zai:<id>`, `xai:<id>` or `custom:<name>:<id>`.
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

// The text before an id's first `:` ('' when it has none).
export function prefixOf(id: string): string {
  return id.slice(0, Math.max(0, id.indexOf(':')))
}

export type ModelKind = { kind: 'route'; route: Route } | { kind: 'malformed'; prefix: string } | { kind: 'unprefixed' }

// What the router does with a model id: route it; answer it with a local
// error when it has a router prefix but does not parse (`openai:`,
// `custom:gw`, `custom:gw:`), never sending it to the engine on the
// subscription; or pass it to the engine untouched.
export function classifyModel(id: string): ModelKind {
  const route = parseModel(id)
  if (route) return { kind: 'route', route }
  const prefix = prefixOf(id)
  return ROUTER_PREFIXES.includes(prefix) ? { kind: 'malformed', prefix } : { kind: 'unprefixed' }
}

// The label of a custom endpoint in errors and /providers.
export function customLabel(name: string): string {
  return `custom:${name}`
}

// The label of a route in errors and /providers.
export function routeLabel(r: Route): string {
  return r.provider === 'custom' ? customLabel(r.name) : r.provider
}
