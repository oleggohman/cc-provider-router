import { describe, expect, test } from 'claude-code/testing'
import { DEFAULT_MAX_TOKENS, maxOutputTokens, windowFor } from './limits.ts'

describe('maxOutputTokens', () => {
  test('per-model values by prefix on the prefixed id', () => {
    expect(maxOutputTokens('zai:glm-5.3')).toBe(32768)
    expect(maxOutputTokens('openai:gpt-5')).toBe(128000)
    expect(maxOutputTokens('openai:gpt-5.1-mini')).toBe(128000)
    expect(maxOutputTokens('openai:gpt-4o-mini')).toBe(16384)
    expect(maxOutputTokens('openai:gpt-4.1-nano')).toBe(32768)
    expect(maxOutputTokens('openai:o3-pro')).toBe(100000)
    expect(maxOutputTokens('openai:o4-mini')).toBe(100000)
    expect(maxOutputTokens('openai:o1')).toBe(100000)
    expect(maxOutputTokens('anthropic:claude-opus-4-6')).toBe(32000)
    expect(maxOutputTokens('anthropic:claude-sonnet-4-5-20250929')).toBe(64000)
    expect(maxOutputTokens('anthropic:claude-haiku-4-5')).toBe(64000)
    expect(maxOutputTokens('anthropic:claude-fable-5-2')).toBe(128000)
    expect(maxOutputTokens('anthropic:claude-fable-5')).toBe(128000)
  })

  test('xai: output limit by family (32768 is an assumption; xAI publishes no maximum)', () => {
    expect(maxOutputTokens('xai:grok-4.7')).toBe(32768)
    expect(maxOutputTokens('xai:grok-4.7-latest')).toBe(32768)
    expect(maxOutputTokens('xai:grok-4.3')).toBe(32768)
    expect(maxOutputTokens('xai:grok-4.20-0309-reasoning')).toBe(32768)
    expect(maxOutputTokens('xai:grok-4.20-multi-agent-0309')).toBe(32768)
    expect(maxOutputTokens('xai:grok-build-0.1')).toBe(32768)
  })

  test('unknown xai: ids outside the grok-4 and grok-build families get the default', () => {
    expect(maxOutputTokens('xai:grok-2')).toBe(DEFAULT_MAX_TOKENS)
    expect(maxOutputTokens('xai:grok-3-mini')).toBe(DEFAULT_MAX_TOKENS)
  })

  test('unknown ids and every custom: model get the default', () => {
    expect(DEFAULT_MAX_TOKENS).toBe(8192)
    expect(maxOutputTokens('openai:never-heard-of')).toBe(DEFAULT_MAX_TOKENS)
    expect(maxOutputTokens('custom:gw:glm-5.3')).toBe(DEFAULT_MAX_TOKENS)
  })
})

describe('windowFor', () => {
  test('built-in windows match by prefix, so dated and newer ids are covered', () => {
    const none = new Map<string, number>()
    expect(windowFor('openai:gpt-5', none)).toBe(400000)
    expect(windowFor('openai:gpt-5.1', none)).toBe(400000)
    expect(windowFor('openai:gpt-4o-mini', none)).toBe(128000)
    expect(windowFor('anthropic:claude-sonnet-4-6', none)).toBe(200000)
    expect(windowFor('anthropic:claude-opus-4-5-20251101', none)).toBe(200000)
    expect(windowFor('anthropic:claude-fable-5-2', none)).toBe(1000000)
    expect(windowFor('zai:glm-5.3', none)).toBe(200000)
  })

  test('xai: windows by family, most specific row first', () => {
    const none = new Map<string, number>()
    expect(windowFor('xai:grok-4.7', none)).toBe(500000)
    expect(windowFor('xai:grok-4.7-latest', none)).toBe(500000)
    expect(windowFor('xai:grok-4.5', none)).toBe(500000)
    expect(windowFor('xai:grok-4.3', none)).toBe(1000000)
    expect(windowFor('xai:grok-4.20-0309-reasoning', none)).toBe(1000000)
    expect(windowFor('xai:grok-4.20-multi-agent-0309', none)).toBe(1000000)
    expect(windowFor('xai:grok-build-0.1', none)).toBe(256000)
    expect(windowFor('xai:grok-2', none)).toBeUndefined()
  })

  test('a contextWindows entry (exact id) wins over the built-in table and adds new ids', () => {
    const user = new Map([['openai:gpt-5', 272000], ['custom:gw:llama-3', 8192]])
    expect(windowFor('openai:gpt-5', user)).toBe(272000)
    expect(windowFor('openai:gpt-5-mini', user)).toBe(400000)
    expect(windowFor('custom:gw:llama-3', user)).toBe(8192)
  })

  test('a contextWindows entry for an exact xai: id wins over the xai row', () => {
    const user = new Map([['xai:grok-4.7', 262144]])
    expect(windowFor('xai:grok-4.7', user)).toBe(262144)
    expect(windowFor('xai:grok-4.7-latest', user)).toBe(500000)
  })

  test('unknown model and every custom: model without an entry have no window', () => {
    const none = new Map<string, number>()
    expect(windowFor('openai:never-heard-of', none)).toBeUndefined()
    expect(windowFor('custom:gw:glm-5.3', none)).toBeUndefined()
  })
})
