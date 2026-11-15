import { describe, expect, test } from 'claude-code/testing'
import { malformedPrefix, parseModel } from './route.ts'

describe('parseModel', () => {
  test('no prefix is not routed', async () => {
    expect(parseModel('claude-opus-4-6')).toBe(null)
    expect(parseModel('sonnet')).toBe(null)
  })

  test('anthropic: prefix', async () => {
    expect(parseModel('anthropic:claude-haiku-4-5')).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' })
  })

  test('openai: prefix', async () => {
    expect(parseModel('openai:gpt-5')).toEqual({ provider: 'openai', model: 'gpt-5' })
  })

  test('zai: prefix', async () => {
    expect(parseModel('zai:glm-5.3')).toEqual({ provider: 'zai', model: 'glm-5.3' })
  })

  test('zai: with an empty id is not routed', async () => {
    expect(parseModel('zai:')).toBe(null)
  })

  test('custom:<name>:<id>', async () => {
    expect(parseModel('custom:mygw:llama3')).toEqual({ provider: 'custom', name: 'mygw', model: 'llama3' })
  })

  test('ids may contain / and :', async () => {
    expect(parseModel('openai:org/model:v1')).toEqual({ provider: 'openai', model: 'org/model:v1' })
    expect(parseModel('custom:gw:org/model:v1:free')).toEqual({ provider: 'custom', name: 'gw', model: 'org/model:v1:free' })
  })

  test('unknown custom name still parses (resolved against config later)', async () => {
    expect(parseModel('custom:nosuch:m')).toEqual({ provider: 'custom', name: 'nosuch', model: 'm' })
  })

  test('custom without a name or id is not routed', async () => {
    expect(parseModel('custom:')).toBe(null)
    expect(parseModel('custom:gw')).toBe(null)
    expect(parseModel('custom:gw:')).toBe(null)
    expect(parseModel('custom::m')).toBe(null)
  })

  test('empty id is not routed', async () => {
    expect(parseModel('')).toBe(null)
    expect(parseModel('anthropic:')).toBe(null)
    expect(parseModel('openai:')).toBe(null)
  })

  test('unknown prefix is not routed', async () => {
    expect(parseModel('foo:bar')).toBe(null)
  })

  test('a known prefix with a bad remainder is malformed (a clear error, never the engine)', async () => {
    for (const id of ['openai:', 'anthropic:', 'zai:', 'custom:', 'custom:gw', 'custom:gw:', 'custom::m']) expect(malformedPrefix(id)).toBe(id.slice(0, id.indexOf(':')))
    for (const id of ['claude-haiku-4-5', 'foo:bar', 'openai:gpt-5', 'custom:gw:m', '']) expect(malformedPrefix(id)).toBe(undefined)
  })
})
