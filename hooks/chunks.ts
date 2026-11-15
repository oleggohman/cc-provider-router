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

export const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// A usage count from a provider's reply: a finite number, else 0.
export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

const STOP_REASONS = ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'compaction', 'refusal', 'model_context_window_exceeded'] as const

export type StopReason = (typeof STOP_REASONS)[number]

export type ReplyBlock = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }

export type Reply = { model: string; content: ReplyBlock[]; stopReason: StopReason; usage: Usage }

const STOPS = new Set<string>(STOP_REASONS)

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
