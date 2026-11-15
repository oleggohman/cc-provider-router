// Builds the provider request from the engine's captured shadow request.
// Only fields a provider understands are kept; first-party fields (metadata,
// context_management, safeguards, thread, diagnostics, stream, thinking,
// output_config, ...) are dropped by the allow list. The model is replaced and
// max_tokens comes from the routed model's limits (limits.ts), not the
// captured value (the engine sizes it for an unknown model id).

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

const KEEP = ['system', 'tool_choice', 'stop_sequences', 'temperature', 'top_p', 'top_k'] as const

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

// No routed provider takes deferred tools or `tool_reference` blocks (on the
// Claude Platform they need a beta the router does not send; OpenAI-compatible
// servers do not know them): a deferred tool is sent once loaded (else
// dropped) and a reference becomes plain text.
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

export function buildRequest(body: any, model: string, maxTokens: number): ProviderRequest {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : []
  const request: ProviderRequest = { model, max_tokens: maxTokens, messages: flattenMessages(messages) }
  for (const k of KEEP) if (body?.[k] !== undefined) (request as any)[k] = body[k]
  if (Array.isArray(body?.tools) && body.tools.length) {
    const tools = flattenTools(body.tools, referencedTools(messages))
    if (tools.length) request.tools = tools
  }
  return request
}
