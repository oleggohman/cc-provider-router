// A provider's reply as `turn.step` chunks and the step's result.
// Every adapter turns its provider's answer into a `Reply` (Anthropic
// Messages shape: text and tool_use blocks); this module is the only place
// that knows the chunk protocol.

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'compaction' | 'refusal' | 'model_context_window_exceeded'

export type ReplyBlock = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }

export type Reply = { model: string; content: ReplyBlock[]; stopReason: StopReason; usage: Usage }

const STOPS = new Set<string>(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'compaction', 'refusal', 'model_context_window_exceeded'])

// A provider's stop reason as one the engine knows. A reply that calls tools
// and says it just ended (or says nothing) stops with `tool_use`, so the
// engine runs the tools; one that says `tool_use` but has no tool call left
// (none survived parsing) ends the turn.
export function normalizeStop(raw: unknown, callsTools: boolean): StopReason {
  if (raw === 'tool_use' && !callsTools) return 'end_turn'
  if (typeof raw === 'string' && STOPS.has(raw) && !(callsTools && raw === 'end_turn')) return raw as StopReason
  return callsTools ? 'tool_use' : 'end_turn'
}

function turnUsage(r: Reply) {
  return { ...r.usage, model: r.model }
}

// Text blocks become `text` chunks, tool calls a `tool` chunk and one `input`
// chunk with the whole arguments' JSON; a `stop` chunk ends the reply.
// Indexes count the blocks actually sent, from 0.
export function* toChunks(r: Reply): Generator<any, void, unknown> {
  let index = 0
  for (const b of r.content) {
    if (b.type === 'text') {
      if (!b.text) continue
      yield { kind: 'text', index, text: b.text }
    } else {
      yield { kind: 'tool', index, id: b.id, name: b.name }
      yield { kind: 'input', index, json: JSON.stringify(b.input ?? {}) }
    }
    index++
  }
  yield { kind: 'stop', stopReason: r.stopReason, usage: turnUsage(r) }
}

export function toResult(e: { turnId: string; index: number }, r: Reply) {
  return {
    turnId: e.turnId,
    index: e.index,
    answer: r.content.map(b => (b.type === 'text' ? b.text : '')).join(''),
    toolUses: r.content.flatMap(b => (b.type === 'tool_use' ? [{ name: b.name, input: b.input ?? {} }] : [])),
    stopReason: r.stopReason,
    usage: turnUsage(r),
  }
}
