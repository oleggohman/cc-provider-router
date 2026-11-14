import { describe, expect, test } from 'claude-code/testing'
import * as fx from '../tests/fixtures/transcripts.ts'
import { DEFAULT_MAX_TOKENS, buildRequest, maxOutputTokens } from './request.ts'

const FIRST_PARTY = ['metadata', 'context_management', 'safeguards', 'thread', 'diagnostics', 'stream', 'thinking', 'output_config']
const openai = { provider: 'openai', model: 'gpt-5' } as const
const anthropic = { provider: 'anthropic', model: 'claude-sonnet-4-5' } as const
const zai = { provider: 'zai', model: 'glm-5.3' } as const
const custom = { provider: 'custom', name: 'gw', model: 'org/m:v1' } as const

describe('buildRequest', () => {
  test('keeps system, tools, messages; drops first-party fields; replaces the model', () => {
    const { request } = buildRequest(fx.textOnly, anthropic, {})
    expect(request.model).toBe('claude-sonnet-4-5')
    expect(request.system).toEqual(fx.textOnly.system)
    expect(request.tools).toEqual(fx.textOnly.tools)
    expect(request.messages).toEqual(fx.textOnly.messages)
    for (const k of FIRST_PARTY) expect(k in request).toBe(false)
  })

  test('max_tokens comes from the routed model, not the captured value', () => {
    expect(buildRequest(fx.textOnly, openai, {}).request.max_tokens).toBe(maxOutputTokens(openai))
    expect(buildRequest(fx.textOnly, anthropic, {}).request.max_tokens).toBe(64000)
    expect(buildRequest(fx.textOnly, custom, {}).request.max_tokens).toBe(DEFAULT_MAX_TOKENS)
    expect(buildRequest(fx.textOnly, zai, {}).request.max_tokens).not.toBe(32000 + 1)
  })

  test('tool round trip, images, documents and thinking pass to Anthropic-compatible providers as is', () => {
    for (const f of [fx.toolRoundTrip, fx.images, fx.documents, fx.thinkingBlocks]) {
      expect(buildRequest(f, zai, {}).request.messages).toEqual(f.messages)
    }
  })

  test("a subagent's own tool set and system prompt are used", () => {
    const { request } = buildRequest(fx.subagent, openai, {})
    expect(request.tools!.map((t: any) => t.name)).toEqual(['Read', 'SubagentHandback'])
    expect(request.system).toEqual(fx.subagent.system)
  })

  test('effort is carried for the adapter', () => {
    expect(buildRequest(fx.textOnly, openai, { effort: 'high' }).effort).toBe('high')
  })

  test('a body without tools gives no tools field', () => {
    const { tools: _, ...noTools } = fx.textOnly
    expect('tools' in buildRequest(noTools, openai, {}).request).toBe(false)
  })
})

describe('deferred tools / tool search', () => {
  test('kept as is for Anthropic-compatible providers', () => {
    for (const r of [anthropic, zai]) {
      const { request } = buildRequest(fx.deferredTools, r, {})
      expect(request.tools).toEqual(fx.deferredTools.tools)
      expect(JSON.stringify(request.messages)).toContain('tool_reference')
    }
  })

  test('flattened for the OpenAI adapter: loaded ones kept, others dropped, references as text', () => {
    for (const r of [openai, custom]) {
      const { request } = buildRequest(fx.deferredTools, r, {})
      const names = request.tools!.map((t: any) => t.name)
      expect(names).toEqual(['Bash', 'Read', 'ToolSearch', 'WebFetch'])
      for (const t of request.tools!) expect('defer_loading' in t).toBe(false)
      const s = JSON.stringify(request.messages)
      expect(s).not.toContain('tool_reference')
      expect(s).toContain('Tool loaded: WebFetch')
    }
    // The fixture itself is not modified.
    expect(JSON.stringify(fx.deferredTools)).toContain('tool_reference')
  })
})
