import { describe, expect, test } from 'claude-code/testing'
import { type Reply, normalizeStop, toChunks, toResult } from './chunks.ts'

const USAGE = { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 }
const E = { turnId: 't9', index: 3 }

function reply(over: Partial<Reply> = {}): Reply {
  return { model: 'gpt-5', content: [], stopReason: 'end_turn', usage: USAGE, ...over }
}

function all(r: Reply): any[] {
  return [...toChunks(r)]
}

describe('toChunks', () => {
  test('text only: one text chunk per block, then the stop chunk with usage and model', () => {
    const chunks = all(reply({ content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] }))
    expect(chunks).toEqual([
      { kind: 'text', index: 0, text: 'hello' },
      { kind: 'text', index: 1, text: 'world' },
      { kind: 'stop', stopReason: 'end_turn', usage: { ...USAGE, model: 'gpt-5' } },
    ])
  })

  test('tool call: a tool chunk then its arguments as one input chunk', () => {
    const chunks = all(reply({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] }))
    expect(chunks[0]).toEqual({ kind: 'tool', index: 0, id: 'toolu_1', name: 'Bash' })
    expect(chunks[1]).toEqual({ kind: 'input', index: 0, json: '{"command":"ls"}' })
    expect(chunks[2].kind).toBe('stop')
    expect(chunks[2].stopReason).toBe('tool_use')
  })

  test('tool call without arguments sends {}', () => {
    const chunks = all(reply({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Noop', input: undefined }] }))
    expect(chunks[1]).toEqual({ kind: 'input', index: 0, json: '{}' })
  })

  test('mixed: text and tool calls keep their order and block indexes', () => {
    const chunks = all(
      reply({
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x' } },
          { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'pwd' } },
        ],
      }),
    )
    expect(chunks.map(c => `${c.kind}:${c.index ?? ''}`)).toEqual(['text:0', 'tool:1', 'input:1', 'tool:2', 'input:2', 'stop:'])
  })

  test('empty text blocks are skipped', () => {
    const chunks = all(reply({ content: [{ type: 'text', text: '' }, { type: 'text', text: 'x' }] }))
    expect(chunks[0]).toEqual({ kind: 'text', index: 0, text: 'x' })
  })

  test('each stop reason passes through', () => {
    for (const s of ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded'] as const) {
      const chunks = all(reply({ stopReason: s }))
      expect(chunks[chunks.length - 1].stopReason).toBe(s)
    }
  })
})

describe('normalizeStop', () => {
  test('known reasons kept; unknown or missing become end_turn, or tool_use when the reply calls tools', () => {
    expect(normalizeStop('max_tokens', false)).toBe('max_tokens')
    expect(normalizeStop('refusal', true)).toBe('refusal')
    expect(normalizeStop(null, false)).toBe('end_turn')
    expect(normalizeStop('weird', false)).toBe('end_turn')
    expect(normalizeStop(undefined, true)).toBe('tool_use')
    expect(normalizeStop('end_turn', true)).toBe('tool_use')
  })
})

describe('toResult', () => {
  test('answer joins the text, toolUses list name and input, usage carries the model', () => {
    const r = toResult(
      E,
      reply({
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: 'a' },
          { type: 'tool_use', id: 'x', name: 'Read', input: { file_path: '/y' } },
          { type: 'text', text: 'b' },
        ],
      }),
    )
    expect(r).toEqual({
      turnId: 't9',
      index: 3,
      answer: 'ab',
      toolUses: [{ name: 'Read', input: { file_path: '/y' } }],
      stopReason: 'tool_use',
      usage: { ...USAGE, model: 'gpt-5' },
    })
  })

  test('empty reply: empty answer, no tool uses', () => {
    const r = toResult(E, reply())
    expect(r.answer).toBe('')
    expect(r.toolUses).toEqual([])
    expect(r.stopReason).toBe('end_turn')
  })
})
