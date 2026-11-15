// Anthropic Messages <-> OpenAI Chat Completions translation for the
// OpenAI-compatible adapter (`openai:` and `custom:<name>:`).
// Deferred tools and `tool_reference` blocks are already flattened by
// buildRequest (request.ts); this module only changes the format.
// Prompt caching, extended thinking and server tools are not translated.

import { type Reply, type ReplyBlock, type StopReason, type Usage, normalizeStop, num } from './chunks.ts'
import type { ProviderRequest } from './request.ts'
import { blocksOf } from './thread.ts'

export type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: any; tool_calls?: any[]; tool_call_id?: string }

export type ChatRequest = {
  model: string
  messages: ChatMessage[]
  max_completion_tokens: number
  tools?: any[]
  tool_choice?: unknown
  parallel_tool_calls?: boolean
  stop?: unknown
  temperature?: unknown
  top_p?: unknown
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh'
  [k: string]: unknown
}

// `rejectsStop`: drop `stop` (the endpoint refuses it). `effortScale` 'xai':
// `xhigh` and `max` are sent as `xhigh`; 'openai' (default): both become `high`.
export type ChatOptions = { reasoning: boolean; effort?: string | number; rejectsStop?: boolean; effortScale?: 'openai' | 'xai' }

const IMAGE_MOVED = '(image attached in the next message)'
const DOCUMENT_MOVED = '(document attached in the next message)'

function textOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(b => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n')
  return ''
}

function imagePart(b: any): any | null {
  const s = b?.source
  if (s?.type === 'base64' && typeof s.data === 'string') return { type: 'image_url', image_url: { url: `data:${s.media_type ?? 'image/png'};base64,${s.data}` } }
  if (s?.type === 'url' && typeof s.url === 'string') return { type: 'image_url', image_url: { url: s.url } }
  return null
}

// A document as a file part (base64 PDF) or as text (no file part fits).
function documentPart(b: any): any | null {
  const s = b?.source
  if (s?.type === 'base64' && typeof s.data === 'string') {
    const media = s.media_type ?? 'application/pdf'
    return { type: 'file', file: { filename: typeof b.title === 'string' && b.title ? b.title : 'document.pdf', file_data: `data:${media};base64,${s.data}` } }
  }
  if (s?.type === 'text' && typeof s.data === 'string') return { type: 'text', text: s.data }
  if (s?.type === 'content') return { type: 'text', text: textOf(s.content) }
  if (s?.type === 'url' && typeof s.url === 'string') return { type: 'text', text: `Document: ${s.url}` }
  return null
}

// A user content block as a Chat content part, or null (dropped).
function userPart(b: any): any | null {
  switch (b?.type) {
    case 'image':
      return imagePart(b)
    case 'document':
      return documentPart(b)
    default:
      return typeof b?.text === 'string' ? { type: 'text', text: b.text } : null
  }
}

// One Anthropic user message: tool results first as `tool` messages (they must
// follow the assistant's tool calls), then one user message with the images
// taken out of tool results and the remaining parts.
function userMessages(m: any): ChatMessage[] {
  if (typeof m.content === 'string') return [{ role: 'user', content: m.content }]
  if (!Array.isArray(m.content)) return []
  const out: ChatMessage[] = []
  const moved: any[] = []
  const parts: any[] = []
  for (const b of m.content) {
    if (b?.type === 'tool_result') {
      const blocks = blocksOf(b.content)
      // Tool messages carry text only: images and documents (a Read of a PDF)
      // move to the user message after them, with a note in the tool content.
      const texts: string[] = []
      const notes = new Set<string>()
      for (const c of blocks) {
        if (c?.type === 'image' || c?.type === 'document') {
          const p = c.type === 'image' ? imagePart(c) : documentPart(c)
          if (p) {
            moved.push(p)
            notes.add(c.type === 'image' ? IMAGE_MOVED : DOCUMENT_MOVED)
          }
        } else if (typeof c?.text === 'string') texts.push(c.text)
      }
      const content = [...texts, ...notes].join('\n')
      out.push({ role: 'tool', tool_call_id: String(b.tool_use_id ?? ''), content: b.is_error ? `Error: ${content}` : content })
    } else {
      const p = userPart(b)
      if (p) parts.push(p)
    }
  }
  const all = [...moved, ...parts]
  if (all.length) out.push({ role: 'user', content: all })
  return out
}

function assistantMessage(m: any): ChatMessage | null {
  if (typeof m.content === 'string') return m.content ? { role: 'assistant', content: m.content } : null
  if (!Array.isArray(m.content)) return null
  let text = ''
  const calls: any[] = []
  for (const b of m.content) {
    if (b?.type === 'text' && typeof b.text === 'string') text += b.text
    else if (b?.type === 'tool_use') calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } })
    // thinking, redacted_thinking and server tool blocks are dropped
  }
  if (!text && !calls.length) return null
  const msg: ChatMessage = { role: 'assistant', content: text || null }
  if (calls.length) msg.tool_calls = calls
  return msg
}

function systemText(system: unknown): string {
  return typeof system === 'string' ? system : Array.isArray(system) ? system.map(b => (typeof b?.text === 'string' ? b.text : '')).filter(Boolean).join('\n\n') : ''
}

function toolChoice(c: any): unknown {
  switch (c?.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'none':
      return 'none'
    case 'tool':
      return { type: 'function', function: { name: c.name } }
    default:
      return undefined
  }
}

function reasoningEffort(effort: unknown, scale: ChatOptions['effortScale']): ChatRequest['reasoning_effort'] {
  if (effort === 'low' || effort === 'medium' || effort === 'high') return effort
  if (effort === 'xhigh' || effort === 'max') return scale === 'xai' ? 'xhigh' : 'high'
  return undefined
}

export function toChat(req: ProviderRequest, opts: ChatOptions): ChatRequest {
  const messages: ChatMessage[] = []
  const sys = systemText(req.system)
  if (sys) messages.push({ role: 'system', content: sys })
  for (const m of req.messages) {
    if (m?.role === 'user') messages.push(...userMessages(m))
    else if (m?.role === 'assistant') {
      const a = assistantMessage(m)
      if (a) messages.push(a)
    }
  }
  const chat: ChatRequest = { model: req.model, messages, max_completion_tokens: req.max_tokens }
  const tools = (req.tools ?? [])
    .filter(t => t && typeof t.name === 'string' && t.input_schema && typeof t.input_schema === 'object')
    .map(t => ({ type: 'function', function: { name: t.name, ...(typeof t.description === 'string' ? { description: t.description } : {}), parameters: t.input_schema } }))
  if (tools.length) chat.tools = tools
  const tc = toolChoice(req.tool_choice)
  if (tc !== undefined) chat.tool_choice = tc
  // One tool call per reply, as the captured request asked (only with tools:
  // OpenAI rejects parallel_tool_calls without them).
  if (tools.length && (req.tool_choice as any)?.disable_parallel_tool_use === true) chat.parallel_tool_calls = false
  if (req.stop_sequences !== undefined && !opts.rejectsStop) chat.stop = req.stop_sequences
  if (opts.reasoning) {
    // Reasoning models reject custom sampling settings.
    const effort = reasoningEffort(opts.effort, opts.effortScale)
    if (effort) chat.reasoning_effort = effort
  } else {
    if (req.temperature !== undefined) chat.temperature = req.temperature
    if (req.top_p !== undefined) chat.top_p = req.top_p
  }
  return chat
}

const FINISH: Record<string, StopReason> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
}

function usageOf(u: any): Usage {
  return { input_tokens: num(u?.prompt_tokens), output_tokens: num(u?.completion_tokens), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
}

// Tool arguments as an object. Malformed, empty or non-object JSON gives {}:
// the tool's own input check then tells the model what is missing.
function args(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw !== 'string') return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

let generated = 0

// A Chat Completions reply as a Reply, or null when the body is not one.
export function fromChat(text: string, fallbackModel: string): Reply | null {
  let j: any
  try {
    j = JSON.parse(text)
  } catch {
    return null
  }
  const choice = Array.isArray(j?.choices) ? j.choices[0] : undefined
  const msg = choice?.message
  if (!msg || typeof msg !== 'object') return null
  const content: ReplyBlock[] = []
  // Some servers send content as an array of text parts.
  const body = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('') : ''
  let refused = false
  if (body) content.push({ type: 'text', text: body })
  else if (typeof msg.refusal === 'string' && msg.refusal) {
    content.push({ type: 'text', text: msg.refusal })
    refused = true
  }
  for (const c of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    const name = c?.function?.name
    if (typeof name !== 'string' || !name) continue
    const id = typeof c.id === 'string' && c.id ? c.id : `call_router_${Date.now().toString(36)}_${++generated}`
    content.push({ type: 'tool_use', id, name, input: args(c.function.arguments) })
  }
  const callsTools = content.some(b => b.type === 'tool_use')
  const mapped = refused ? 'refusal' : FINISH[String(choice.finish_reason)]
  return {
    model: typeof j.model === 'string' && j.model ? j.model : fallbackModel,
    content,
    stopReason: normalizeStop(mapped, callsTools),
    usage: usageOf(j.usage),
  }
}
