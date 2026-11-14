import { describe, expect, test } from 'claude-code/testing'
import { fromChat, toChat } from './translate.ts'
import { buildRequest } from './request.ts'
import * as fx from '../tests/fixtures/transcripts.ts'

const OPENAI = { provider: 'openai', model: 'gpt-5' } as const

const base = (over: any = {}) => ({ model: 'gpt-5', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }], ...over })

describe('Anthropic -> Chat Completions', () => {
  test('system prompt (blocks) becomes the first system message; model and max_completion_tokens set', async () => {
    const c = toChat(base({ system: [{ type: 'text', text: 'A', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'B' }] }), { reasoning: false })
    expect(c.model).toBe('gpt-5')
    expect(c.max_completion_tokens).toBe(1000)
    expect(c.max_tokens).toBeUndefined()
    expect(c.messages[0]).toEqual({ role: 'system', content: 'A\n\nB' })
    expect(c.messages[1]).toEqual({ role: 'user', content: 'hi' })
    expect(c.stream).toBeUndefined()
  })

  test('string system prompt; no system -> no system message', async () => {
    expect(toChat(base({ system: 'S' }), { reasoning: false }).messages[0]).toEqual({ role: 'system', content: 'S' })
    expect(toChat(base(), { reasoning: false }).messages[0]!.role).toBe('user')
  })

  test('user text blocks become text parts; cache_control dropped', async () => {
    const c = toChat(buildRequest(fx.textOnly, OPENAI, {}).request, { reasoning: false })
    expect(c.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>r</system-reminder>' },
        { type: 'text', text: 'hello' },
      ],
    })
  })

  test('images: base64 -> data URL, url source -> url', async () => {
    const c = toChat(buildRequest(fx.images, OPENAI, {}).request, { reasoning: false })
    expect(c.messages[1]!.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      { type: 'text', text: 'what is this?' },
    ])
    const u = toChat(base({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }] }), { reasoning: false })
    expect(u.messages[0]!.content).toEqual([{ type: 'image_url', image_url: { url: 'https://x/y.png' } }])
  })

  test('documents: text source as text; base64 PDF as a file part; content source as text', async () => {
    const c = toChat(buildRequest(fx.documents, OPENAI, {}).request, { reasoning: false })
    expect(c.messages[1]!.content).toEqual([
      { type: 'text', text: 'doc body' },
      { type: 'text', text: 'summarise' },
    ])
    const pdf = toChat(
      base({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'document', title: 'spec.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
              { type: 'document', source: { type: 'content', content: [{ type: 'text', text: 'p1' }, { type: 'text', text: 'p2' }] } },
            ],
          },
        ],
      }),
      { reasoning: false },
    )
    expect(pdf.messages[0]!.content).toEqual([
      { type: 'file', file: { filename: 'spec.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' } },
      { type: 'text', text: 'p1\np2' },
    ])
  })

  test('assistant tool_use -> tool_calls; tool_result -> role tool message with tool_call_id', async () => {
    const c = toChat(buildRequest(fx.toolRoundTrip, OPENAI, {}).request, { reasoning: false })
    expect(c.messages.slice(1)).toEqual([
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'a.txt' },
    ])
  })

  test('assistant text and tool_use together; text joined', async () => {
    const c = toChat(
      base({
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } }] },
        ],
      }),
      { reasoning: false },
    )
    expect(c.messages[0]).toEqual({ role: 'assistant', content: 'onetwo', tool_calls: [{ id: 't1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a"}' } }] })
  })

  test('tool_result with is_error is prefixed Error:; array content joined', async () => {
    const c = toChat(
      base({
        messages: [
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'boom' }, { type: 'text', text: 'trace' }] }] },
        ],
      }),
      { reasoning: false },
    )
    expect(c.messages[0]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'Error: boom\ntrace' })
  })

  test('images inside a tool result move into a following user message; other user parts follow them', async () => {
    const c = toChat(
      base({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'shot' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } }] },
              { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBB' } }] },
              { type: 'text', text: 'next' },
            ],
          },
        ],
      }),
      { reasoning: false },
    )
    expect(c.messages).toEqual([
      { role: 'tool', tool_call_id: 't1', content: 'shot\n(image attached in the next message)' },
      { role: 'tool', tool_call_id: 't2', content: '(image attached in the next message)' },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } },
          { type: 'text', text: 'next' },
        ],
      },
    ])
  })

  test('empty tool result content still gives a tool message', async () => {
    const c = toChat(base({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }] }), { reasoning: false })
    expect(c.messages).toEqual([{ role: 'tool', tool_call_id: 't1', content: '' }])
  })

  test('thinking blocks in history are dropped; an assistant turn with only thinking is dropped', async () => {
    const c = toChat(buildRequest(fx.thinkingBlocks, OPENAI, {}).request, { reasoning: false })
    expect(c.messages.slice(1)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q2' },
    ])
    const only = toChat(base({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x' }] }] }), { reasoning: false })
    expect(only.messages).toEqual([{ role: 'user', content: 'q' }])
  })

  test('tools -> function tools; tools without input_schema (server tools) dropped', async () => {
    const c = toChat(
      buildRequest({ ...fx.textOnly, tools: [...fx.textOnly.tools, { type: 'web_search_20250305', name: 'web_search' }, { name: 'NoDesc', input_schema: { type: 'object' } }] }, OPENAI, {}).request,
      { reasoning: false },
    )
    expect(c.tools).toEqual([
      { type: 'function', function: { name: 'Bash', description: 'Run a command', parameters: fx.textOnly.tools[0]!.input_schema } },
      { type: 'function', function: { name: 'Read', description: 'Read a file', parameters: fx.textOnly.tools[1]!.input_schema } },
      { type: 'function', function: { name: 'NoDesc', parameters: { type: 'object' } } },
    ])
  })

  test('no tools -> no tools field; deferred tools come flattened from buildRequest', async () => {
    expect('tools' in toChat(base(), { reasoning: false })).toBe(false)
    const c = toChat(buildRequest(fx.deferredTools, OPENAI, {}).request, { reasoning: false })
    expect(c.tools!.map((t: any) => t.function.name)).toEqual(['Bash', 'Read', 'ToolSearch', 'WebFetch'])
    expect(c.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'toolu_s', content: 'Tool loaded: WebFetch' })
  })

  test('tool_choice mapping', async () => {
    const tc = (choice: any) => toChat(base({ tool_choice: choice }), { reasoning: false }).tool_choice
    expect(tc({ type: 'auto' })).toBe('auto')
    expect(tc({ type: 'any' })).toBe('required')
    expect(tc({ type: 'none' })).toBe('none')
    expect(tc({ type: 'tool', name: 'Bash' })).toEqual({ type: 'function', function: { name: 'Bash' } })
    expect(tc(undefined)).toBeUndefined()
  })

  test('sampling: temperature, top_p, stop kept for non-reasoning models; top_k dropped', async () => {
    const c = toChat(base({ temperature: 0.2, top_p: 0.9, top_k: 5, stop_sequences: ['X'] }), { reasoning: false })
    expect(c.temperature).toBe(0.2)
    expect(c.top_p).toBe(0.9)
    expect(c.stop).toEqual(['X'])
    expect('top_k' in c).toBe(false)
  })

  test('reasoning_effort: low/medium/high pass; xhigh/max -> high; only for reasoning models; sampling dropped there', async () => {
    const r = (effort: any) => toChat(base({ temperature: 1, top_p: 1 }), { reasoning: true, effort })
    expect(r('low').reasoning_effort).toBe('low')
    expect(r('medium').reasoning_effort).toBe('medium')
    expect(r('high').reasoning_effort).toBe('high')
    expect(r('xhigh').reasoning_effort).toBe('high')
    expect(r('max').reasoning_effort).toBe('high')
    expect(r(undefined).reasoning_effort).toBeUndefined()
    expect(r(3).reasoning_effort).toBeUndefined()
    expect('temperature' in r('low')).toBe(false)
    expect('top_p' in r('low')).toBe(false)
    expect(toChat(base(), { reasoning: false, effort: 'high' }).reasoning_effort).toBeUndefined()
  })
})

const reply = (message: any, extra: any = {}) =>
  JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', model: 'gpt-5-2025-08-07', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }, ...extra })

const withFinish = (message: any, finish: any) => {
  const j = JSON.parse(reply(message))
  j.choices[0].finish_reason = finish
  return JSON.stringify(j)
}

describe('Chat Completions -> reply', () => {
  test('text reply; usage mapped, cache fields 0; model from the reply', async () => {
    const r = fromChat(reply({ content: 'Hello' }), 'gpt-5')!
    expect(r.content).toEqual([{ type: 'text', text: 'Hello' }])
    expect(r.stopReason).toBe('end_turn')
    expect(r.model).toBe('gpt-5-2025-08-07')
    expect(r.usage).toEqual({ input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  })

  test('tool_calls -> tool_use blocks after the text, arguments parsed', async () => {
    const r = fromChat(
      withFinish(
        {
          content: 'Running.',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
            { id: 'call_2', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a"}' } },
          ],
        },
        'tool_calls',
      ),
      'gpt-5',
    )!
    expect(r.content).toEqual([
      { type: 'text', text: 'Running.' },
      { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 'call_2', name: 'Read', input: { file_path: 'a' } },
    ])
    expect(r.stopReason).toBe('tool_use')
  })

  test('malformed, empty or non-object arguments -> empty input object', async () => {
    const r = fromChat(
      withFinish(
        {
          content: null,
          tool_calls: [
            { id: 'a', type: 'function', function: { name: 'Bash', arguments: '{"command": "ls"' } },
            { id: 'b', type: 'function', function: { name: 'Bash', arguments: '' } },
            { id: 'c', type: 'function', function: { name: 'Bash', arguments: '[1,2]' } },
          ],
        },
        'tool_calls',
      ),
      'gpt-5',
    )!
    expect(r.content.map(b => (b.type === 'tool_use' ? b.input : null))).toEqual([{}, {}, {}])
  })

  test('tool call without an id gets a generated one', async () => {
    const r = fromChat(withFinish({ tool_calls: [{ type: 'function', function: { name: 'Bash', arguments: '{}' } }] }, 'tool_calls'), 'gpt-5')!
    const b = r.content[0]!
    expect(b.type === 'tool_use' && typeof b.id === 'string' && b.id.length > 0).toBe(true)
  })

  test('finish_reason mapping', async () => {
    const f = (fr: any, msg: any = { content: 'x' }) => fromChat(withFinish(msg, fr), 'gpt-5')!.stopReason
    expect(f('stop')).toBe('end_turn')
    expect(f('length')).toBe('max_tokens')
    expect(f('content_filter')).toBe('refusal')
    expect(f(null)).toBe('end_turn')
    expect(f('weird')).toBe('end_turn')
    // tool calls with a finish_reason of stop (some servers) still run the tools
    expect(f('stop', { tool_calls: [{ id: 'a', type: 'function', function: { name: 'Bash', arguments: '{}' } }] })).toBe('tool_use')
  })

  test('refusal field becomes text with stop refusal', async () => {
    const r = fromChat(reply({ content: null, refusal: 'I cannot help with that.' }), 'gpt-5')!
    expect(r.content).toEqual([{ type: 'text', text: 'I cannot help with that.' }])
    expect(r.stopReason).toBe('refusal')
  })

  test('empty content: no blocks, end_turn; missing usage reads 0; missing model uses fallback', async () => {
    const j = JSON.parse(reply({ content: '' }))
    delete j.usage
    delete j.model
    const r = fromChat(JSON.stringify(j), 'my-model')!
    expect(r.content).toEqual([])
    expect(r.stopReason).toBe('end_turn')
    expect(r.model).toBe('my-model')
    expect(r.usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  })

  test('content as an array of text parts (some servers) is joined', async () => {
    const r = fromChat(reply({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'gpt-5')!
    expect(r.content).toEqual([{ type: 'text', text: 'ab' }])
  })

  test('not a chat completion -> null', async () => {
    expect(fromChat('not json', 'm')).toBe(null)
    expect(fromChat('{"choices":[]}', 'm')).toBe(null)
    expect(fromChat('{"error":{"message":"x"}}', 'm')).toBe(null)
  })
})
