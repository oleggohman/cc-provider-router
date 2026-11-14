// Builds the provider request from the engine's captured shadow request.
// Only fields a provider understands are kept; first-party fields (metadata,
// context_management, safeguards, thread, diagnostics, stream, thinking,
// output_config, ...) are dropped by the allow list. The model is replaced and
// max_tokens comes from the routed model's limits, not the captured value
// (the engine sizes it for an unknown model id).

import type { Route } from './route.ts'

export type Flavor = 'anthropic' | 'openai'

export type ProviderRequest = {
  model: string
  max_tokens: number
  system?: unknown
  messages: any[]
  tools?: any[]
  tool_choice?: unknown
  stop_sequences?: unknown
  temperature?: unknown
  top_p?: unknown
  top_k?: unknown
}

export type Built = { request: ProviderRequest; effort: string | number | undefined }

const KEEP = ['system', 'tool_choice', 'stop_sequences', 'temperature', 'top_p', 'top_k'] as const

// Max output tokens per routed model (prefix match on the id).
const MAX_OUTPUT: [string, number][] = [
  ['openai:gpt-5', 128000],
  ['openai:gpt-4.1', 32768],
  ['openai:gpt-4o', 16384],
  ['openai:o3', 100000],
  ['openai:o4-mini', 100000],
  ['anthropic:claude-opus', 32000],
  ['anthropic:claude-sonnet', 64000],
  ['anthropic:claude-haiku', 64000],
  ['zai:glm', 32768],
]

export const DEFAULT_MAX_TOKENS = 8192

export function routeKey(r: Route): string {
  return r.provider === 'custom' ? `custom:${r.name}:${r.model}` : `${r.provider}:${r.model}`
}

export function maxOutputTokens(r: Route): number {
  const key = routeKey(r)
  for (const [p, n] of MAX_OUTPUT) if (key.startsWith(p)) return n
  return DEFAULT_MAX_TOKENS
}

export function flavorOf(r: Route): Flavor {
  return r.provider === 'anthropic' || r.provider === 'zai' ? 'anthropic' : 'openai'
}

// Names of deferred tools loaded so far (by a `tool_reference` block).
function referencedTools(messages: any[]): Set<string> {
  const names = new Set<string>()
  const walk = (v: any): void => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      if (v.type === 'tool_reference' && typeof v.tool_name === 'string') names.add(v.tool_name)
      for (const k of Object.keys(v)) walk(v[k])
    }
  }
  walk(messages)
  return names
}

// OpenAI-compatible providers know neither deferred tools nor
// `tool_reference` blocks: a deferred tool is sent once loaded (else dropped)
// and a reference becomes plain text.
function flattenBlock(b: any): any {
  if (b?.type === 'tool_reference') return { type: 'text', text: `Tool loaded: ${b.tool_name}` }
  if (b?.type === 'tool_result' && Array.isArray(b.content)) return { ...b, content: b.content.map(flattenBlock) }
  return b
}

function flattenMessages(messages: any[]): any[] {
  return messages.map(m => (Array.isArray(m?.content) ? { ...m, content: m.content.map(flattenBlock) } : m))
}

function flattenTools(tools: any[], loaded: Set<string>): any[] {
  return tools
    .filter(t => !t?.defer_loading || loaded.has(t.name))
    .map(t => {
      if (!t || typeof t !== 'object' || !('defer_loading' in t)) return t
      const { defer_loading: _, ...rest } = t
      return rest
    })
}

export function buildRequest(body: any, route: Route, e: { effort?: string | number }): Built {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : []
  const request: ProviderRequest = { model: route.model, max_tokens: maxOutputTokens(route), messages }
  for (const k of KEEP) if (body?.[k] !== undefined) (request as any)[k] = body[k]
  if (Array.isArray(body?.tools) && body.tools.length) request.tools = body.tools
  if (flavorOf(route) === 'openai') {
    const loaded = referencedTools(messages)
    request.messages = flattenMessages(messages)
    if (request.tools) {
      request.tools = flattenTools(request.tools, loaded)
      if (!request.tools.length) delete request.tools
    }
  }
  return { request, effort: e.effort }
}
