// A provider's reply as an Anthropic Messages SSE body, the answer the
// router gives the engine's shadow request. The engine parses this body the
// way it parses a real answer, so tool calls it carries are judged as the
// engine's own (not as hook-made chunks).
//
// The usage in the body is zero: the engine prices what it reads, and real
// usage would make it compact on its own. The router keeps the real usage
// and records it itself (see the design notes).

import { type Reply, type StopReason, ZERO_USAGE } from './chunks.ts'

// Stop reasons the engine takes as an ordinary end of a reply. The others make
// the engine act on its own (refusal, context window, pause, compaction), so a
// reply with one of them takes the error path instead.
const IN_PLACE_STOPS = new Set<string>(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'])

export function answerableInPlace(stopReason: StopReason): boolean {
  return IN_PLACE_STOPS.has(stopReason)
}

// Model name of the stub; the same string as SHADOW_MODEL in shadow.ts (not
// imported, so this module has no dependency on the shadow state).
const SHADOW_NAME = 'provider-router-shadow'

// Message ids: unique per load of the module (a random load id) and per call.
const LOAD_ID = Math.random().toString(36).slice(2, 10)
let counter = 0

export function mintId(): string {
  counter++
  return `msg_pr_${LOAD_ID}_${counter}`
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// The SSE body of a reply. Refuses a stop reason the engine must not take in
// place; the caller answers with the stub and the error path instead.
export function toSse(r: Reply, id: string): string {
  if (!answerableInPlace(r.stopReason)) throw new Error(`stop reason ${r.stopReason} cannot be answered in place`)
  let out = frame('message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model: r.model, content: [], stop_reason: null, stop_sequence: null, usage: ZERO_USAGE },
  })
  let index = 0
  for (const b of r.content) {
    if (b.type === 'text') {
      // An empty text block is dropped, as in toChunks.
      if (!b.text) continue
      out += frame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      out += frame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } })
    } else {
      out += frame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
      out += frame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } })
    }
    out += frame('content_block_stop', { type: 'content_block_stop', index })
    index++
  }
  out += frame('message_delta', { type: 'message_delta', delta: { stop_reason: r.stopReason, stop_sequence: null }, usage: { output_tokens: 0 } })
  out += frame('message_stop', { type: 'message_stop' })
  return out
}

// The empty answer: nothing shown, nothing recorded. Used for an error reply
// (the turn.step hook then yields the error chunks) and after Esc.
export function stubSse(): string {
  return (
    frame('message_start', {
      type: 'message_start',
      message: { id: 'msg_shadow', type: 'message', role: 'assistant', model: SHADOW_NAME, content: [], stop_reason: null, stop_sequence: null, usage: ZERO_USAGE },
    }) +
    frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }) +
    frame('message_stop', { type: 'message_stop' })
  )
}

// JSON with object keys sorted at every level, so two values that differ only
// in key order give the same text.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v as object).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

// Whether the engine's result for a step reflects the staged reply: the answer
// (trimmed), the stop reason, and each tool use's name and arguments (key order
// ignored). Anything else, including a null stop reason, is a mismatch.
export function sameDelivery(result: { answer: string; toolUses: { name: string; input: unknown }[]; stopReason: string | null }, staged: Reply): boolean {
  const answer = staged.content.map(b => (b.type === 'text' ? b.text : '')).join('')
  const uses = staged.content.flatMap(b => (b.type === 'tool_use' ? [{ name: b.name, input: b.input ?? {} }] : []))
  if (result.stopReason !== staged.stopReason) return false
  if (result.answer.trim() !== answer.trim()) return false
  if (result.toolUses.length !== uses.length) return false
  return result.toolUses.every((u, i) => {
    const want = uses[i]
    return want !== undefined && u.name === want.name && canonical(u.input) === canonical(want.input)
  })
}
