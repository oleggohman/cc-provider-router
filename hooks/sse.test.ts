import { describe, expect, test } from 'claude-code/testing'
import { type Reply } from './chunks.ts'
import { answerableInPlace, mintId, sameDelivery, stubSse, toSse } from './sse.ts'

const USAGE = { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 }

function reply(over: Partial<Reply> = {}): Reply {
  return { model: 'gpt-5', content: [], stopReason: 'end_turn', usage: USAGE, ...over }
}

// Parses an SSE body into [event, data] pairs; every event must be `event:` then `data:` JSON.
function events(body: string): any[] {
  return body
    .split('\n\n')
    .filter(block => block.length > 0)
    .map(block => {
      const [eventLine = '', dataLine = '', ...rest] = block.split('\n')
      expect(rest.length).toBe(0)
      expect(eventLine.startsWith('event: ')).toBe(true)
      expect(dataLine.startsWith('data: ')).toBe(true)
      return [eventLine.slice('event: '.length), JSON.parse(dataLine.slice('data: '.length))]
    })
}

describe('toSse', () => {
  test('text only: one text block with its delta, then message_delta and message_stop', () => {
    const ev = events(toSse(reply({ content: [{ type: 'text', text: 'hello' }] }), 'msg_1'))
    expect(ev.map(([name]) => name)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
    expect(ev[1][1].content_block).toEqual({ type: 'text', text: '' })
    expect(ev[2][1].delta).toEqual({ type: 'text_delta', text: 'hello' })
  })

  test('tool call only: tool_use block with an empty input, then the whole arguments as one JSON delta', () => {
    const ev = events(toSse(reply({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] }), 'msg_1'))
    expect(ev[1][1].content_block).toEqual({ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} })
    expect(ev[2][1].delta).toEqual({ type: 'input_json_delta', partial_json: '{"command":"ls"}' })
  })

  test('text and two tool calls: indexes run 0, 1, 2 with a start and stop for each block', () => {
    const ev = events(
      toSse(
        reply({
          stopReason: 'tool_use',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a' } },
            { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { path: 'b' } },
          ],
        }),
        'msg_1',
      ),
    )
    const starts = ev.filter(([name]) => name === 'content_block_start')
    const stops = ev.filter(([name]) => name === 'content_block_stop')
    expect(starts.map(([, d]) => d.index)).toEqual([0, 1, 2])
    expect(stops.map(([, d]) => d.index)).toEqual([0, 1, 2])
    expect(ev.filter(([name]) => name === 'content_block_delta').map(([, d]) => d.index)).toEqual([0, 1, 2])
  })

  test('an empty text block is dropped and the indexes count only the blocks sent', () => {
    const ev = events(
      toSse(
        reply({
          stopReason: 'tool_use',
          content: [
            { type: 'text', text: '' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
            { type: 'text', text: 'after' },
          ],
        }),
        'msg_1',
      ),
    )
    const starts = ev.filter(([name]) => name === 'content_block_start')
    expect(starts.map(([, d]) => d.index)).toEqual([0, 1])
    expect(starts[0][1].content_block.type).toBe('tool_use')
    expect(starts[1][1].content_block.type).toBe('text')
    expect(ev.some(([, d]) => d.delta?.text === '')).toBe(false)
  })

  test('the stop reason is carried in message_delta', () => {
    for (const stop of ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'] as const) {
      const ev = events(toSse(reply({ stopReason: stop, content: [{ type: 'text', text: 'x' }] }), 'msg_1'))
      expect(ev[ev.length - 2][1].delta.stop_reason).toBe(stop)
    }
  })

  test('usage is zero everywhere, and message_start carries the reply model name and the id', () => {
    const ev = events(toSse(reply({ model: 'claude-real-9', content: [{ type: 'text', text: 'x' }] }), 'msg_abc'))
    const start = ev[0][1].message
    expect(start.id).toBe('msg_abc')
    expect(start.model).toBe('claude-real-9')
    expect(start.usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    expect(ev[ev.length - 2][1].usage).toEqual({ output_tokens: 0 })
  })

  test('arguments JSON round-trips: nested objects, unicode, an empty object', () => {
    const inputs = [
      { nested: { deep: [1, { x: 'y' }] }, flag: true, nothing: null },
      { text: 'héllo ✓ 日本 "quoted" \\ back\nline' },
      {},
    ]
    for (const input of inputs) {
      const ev = events(toSse(reply({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'N', input }] }), 'msg_1'))
      expect(JSON.parse(ev[2][1].delta.partial_json)).toEqual(input)
    }
  })

  test('the body always ends with message_delta and message_stop', () => {
    const ev = events(toSse(reply({ content: [] }), 'msg_1'))
    expect(ev.map(([name]) => name)).toEqual(['message_start', 'message_delta', 'message_stop'])
  })

  test('a reply whose stop reason cannot be answered in place is refused, not written', () => {
    let refused = false
    try {
      toSse(reply({ stopReason: 'refusal', content: [{ type: 'text', text: 'no' }] }), 'msg_1')
    } catch {
      refused = true
    }
    expect(refused).toBe(true)
  })
})

describe('answerableInPlace', () => {
  test('end_turn, tool_use, max_tokens and stop_sequence are answerable', () => {
    for (const stop of ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'] as const) expect(answerableInPlace(stop)).toBe(true)
  })

  test('refusal, model_context_window_exceeded, pause_turn and compaction are not answerable in place', () => {
    for (const stop of ['refusal', 'model_context_window_exceeded', 'pause_turn', 'compaction'] as const) expect(answerableInPlace(stop)).toBe(false)
  })
})

describe('stubSse', () => {
  test('is the empty answer of today: an empty text block, end_turn, zero usage, the shadow model name', () => {
    const ev = events(stubSse())
    expect(ev.map(([name]) => name)).toEqual(['message_start', 'content_block_start', 'content_block_stop', 'message_delta', 'message_stop'])
    expect(ev[0][1].message.id).toBe('msg_shadow')
    expect(ev[0][1].message.model).toBe('provider-router-shadow')
    expect(ev[0][1].message.usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    expect(ev[1][1].content_block).toEqual({ type: 'text', text: '' })
    expect(ev[3][1].delta.stop_reason).toBe('end_turn')
  })
})

describe('sameDelivery', () => {
  const staged = reply({
    stopReason: 'tool_use',
    content: [
      { type: 'text', text: '  hello there  ' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls', description: 'list' } },
    ],
  })

  test('matches the engine result: answer compared trimmed, tool name and arguments equal', () => {
    const result = { answer: 'hello there', toolUses: [{ name: 'Bash', input: { command: 'ls', description: 'list' } }], stopReason: 'tool_use' }
    expect(sameDelivery(result, staged)).toBe(true)
  })

  test('tool arguments compare whatever the key order', () => {
    const result = { answer: 'hello there', toolUses: [{ name: 'Bash', input: { description: 'list', command: 'ls' } }], stopReason: 'tool_use' }
    expect(sameDelivery(result, staged)).toBe(true)
  })

  test('a different argument value, tool name, answer or stop reason is a mismatch', () => {
    const base = { answer: 'hello there', toolUses: [{ name: 'Bash', input: { command: 'ls', description: 'list' } }], stopReason: 'tool_use' }
    expect(sameDelivery({ ...base, toolUses: [{ name: 'Bash', input: { command: 'rm', description: 'list' } }] }, staged)).toBe(false)
    expect(sameDelivery({ ...base, toolUses: [{ name: 'Read', input: { command: 'ls', description: 'list' } }] }, staged)).toBe(false)
    expect(sameDelivery({ ...base, answer: 'hello there!' }, staged)).toBe(false)
    expect(sameDelivery({ ...base, stopReason: 'end_turn' }, staged)).toBe(false)
  })

  test('a missing stop reason (the engine lost the body) is a mismatch', () => {
    const result = { answer: 'hello there', toolUses: [{ name: 'Bash', input: { command: 'ls', description: 'list' } }], stopReason: null }
    expect(sameDelivery(result, staged)).toBe(false)
  })

  test('a count mismatch in tool uses is a mismatch', () => {
    const result = { answer: 'hello there', toolUses: [], stopReason: 'tool_use' }
    expect(sameDelivery(result, staged)).toBe(false)
  })
})

describe('mintId', () => {
  test('two calls give different ids with the msg_pr_ prefix', () => {
    const a = mintId()
    const b = mintId()
    expect(a.startsWith('msg_pr_')).toBe(true)
    expect(b.startsWith('msg_pr_')).toBe(true)
    expect(a).not.toBe(b)
  })
})
