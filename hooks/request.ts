// Builds the provider request from the engine's captured shadow request.
// Only fields a provider understands are kept; first-party fields (metadata,
// context_management, safeguards, thread, diagnostics, stream, thinking,
// output_config, ...) are dropped by the allow list. The model is replaced and
// max_tokens comes from the routed model's limits (limits.ts), not the
// captured value (the engine sizes it for an unknown model id). The system
// prompt's Claude identity sentence is rewritten to a neutral one: a routed
// model is not Claude.

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

// The engine's system prompt opens by identifying the agent as Claude-based
// ("You are Claude Code.", "You are Claude Code, Anthropic's official CLI for
// Claude.", "You are a Claude agent, built on Anthropic's Claude Agent SDK."
// and its truncated "...Claude Agent" form). A routed model is not Claude, so
// exactly those openers, trailing period included, are replaced with a
// neutral identity for every provider; the rest of the prompt is sent as
// captured. Only the known engine sentences match, ended by a period or by
// the end of the line: a user-authored prompt that merely starts with "You
// are a Claude ..." or "You are Claude Code Reviewer ..." is not an identity
// claim and stays as written.
const CLAUDE_IDENTITY =
  /^(?:You are Claude Code(?:, Anthropic's official CLI for Claude)?|You are a Claude agent, built on Anthropic's Claude Agent(?: SDK)?)(?:\.|(?=\n|$))/
const CODING_AGENT = 'You are a Coding agent'

function rewriteIdentity(text: string): string {
  return text.replace(CLAUDE_IDENTITY, CODING_AGENT)
}

// `system` is a string or a list of {type: 'text'} blocks (a billing-header
// block may sit before the identity one); other shapes pass through.
function rewriteSystem(system: unknown): unknown {
  if (typeof system === 'string') return rewriteIdentity(system)
  if (!Array.isArray(system)) return system
  return system.map(b => (b?.type === 'text' && typeof b.text === 'string' ? { ...b, text: rewriteIdentity(b.text) } : b))
}

export function buildRequest(body: any, model: string, maxTokens: number): ProviderRequest {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : []
  const request: ProviderRequest = { model, max_tokens: maxTokens, messages: flattenMessages(messages) }
  for (const k of KEEP) if (body?.[k] !== undefined) (request as any)[k] = body[k]
  if (request.system !== undefined) request.system = rewriteSystem(request.system)
  if (Array.isArray(body?.tools) && body.tools.length) {
    const tools = flattenTools(body.tools, referencedTools(messages))
    if (tools.length) request.tools = tools
  }
  return request
}
