import { describe, expect, test } from 'claude-code/testing'
import * as fx from '../tests/fixtures/transcripts.ts'
import { buildRequest } from './request.ts'

const FIRST_PARTY = ['metadata', 'context_management', 'safeguards', 'thread', 'diagnostics', 'stream', 'thinking', 'output_config']

describe('buildRequest', () => {
  test('keeps system, tools, messages; drops first-party fields; sets the model and max_tokens', () => {
    const request = buildRequest(fx.textOnly, 'claude-sonnet-4-5', 64000)
    expect(request.model).toBe('claude-sonnet-4-5')
    expect(request.max_tokens).toBe(64000)
    expect(request.system).toEqual(fx.textOnly.system)
    expect(request.tools).toEqual(fx.textOnly.tools)
    expect(request.messages).toEqual(fx.textOnly.messages)
    for (const k of FIRST_PARTY) expect(k in request).toBe(false)
  })

  test('tool round trip, images, documents and thinking pass as is', () => {
    for (const f of [fx.toolRoundTrip, fx.images, fx.documents, fx.thinkingBlocks]) {
      expect(buildRequest(f, 'glm-5.3', 32768).messages).toEqual(f.messages)
    }
  })

  test("a subagent's own tool set and system prompt are used", () => {
    const request = buildRequest(fx.subagent, 'gpt-5', 128000)
    expect(request.tools!.map((t: any) => t.name)).toEqual(['Read', 'SubagentHandback'])
    expect(request.system).toEqual(fx.subagent.system)
  })

  test('a body without tools gives no tools field', () => {
    const { tools: _, ...noTools } = fx.textOnly
    expect('tools' in buildRequest(noTools, 'gpt-5', 1)).toBe(false)
  })

  test('a missing or malformed body gives a minimal request, never a throw', () => {
    for (const body of [undefined, null, 'not json', { messages: 'x', tools: 'y' }, { tools: [] }]) {
      const request = buildRequest(body, 'm', 8192)
      expect(request.model).toBe('m')
      expect(request.messages).toEqual([])
      expect('tools' in request).toBe(false)
      expect(request.max_tokens).toBe(8192)
    }
  })
})

describe('deferred tools / tool search', () => {
  // Every provider: none knows deferred tools or tool_reference blocks without
  // a first-party beta, so loaded ones are sent, the rest dropped, references
  // become text.
  test('flattened for every provider: loaded ones kept, others dropped, references as text', () => {
    const request = buildRequest(fx.deferredTools, 'any-model', 8192)
    const names = request.tools!.map((t: any) => t.name)
    expect(names).toEqual(['Bash', 'Read', 'ToolSearch', 'WebFetch'])
    for (const t of request.tools!) expect('defer_loading' in t).toBe(false)
    const s = JSON.stringify(request.messages)
    expect(s).not.toContain('tool_reference')
    expect(s).toContain('Tool loaded: WebFetch')
    // The fixture itself is not modified.
    expect(JSON.stringify(fx.deferredTools)).toContain('tool_reference')
  })
})
