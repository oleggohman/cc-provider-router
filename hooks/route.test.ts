import { describe, expect, test } from 'claude-code/testing'
import { ID_FORMS, classifyModel, parseModel } from './route.ts'

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

  test('xai: prefix', async () => {
    expect(parseModel('xai:grok-4.7')).toEqual({ provider: 'xai', model: 'grok-4.7' })
  })

  test('xai: ids may contain / and : after the prefix', async () => {
    expect(parseModel('xai:org/grok:beta')).toEqual({ provider: 'xai', model: 'org/grok:beta' })
  })

  test('a model id that merely contains xai without the prefix is not routed', async () => {
    expect(parseModel('grok-4.7')).toBe(null)
    expect(parseModel('xai-grok-4.7')).toBe(null)
    expect(parseModel('my-xai:model')).toBe(null)
    expect(classifyModel('grok-4.7')).toEqual({ kind: 'unprefixed' })
  })

  test('xai: alone is malformed (a local error, never the engine)', async () => {
    expect(parseModel('xai:')).toBe(null)
    expect(classifyModel('xai:')).toEqual({ kind: 'malformed', prefix: 'xai' })
  })

  test('ID_FORMS names xai:<id>', async () => {
    expect(ID_FORMS).toContain('xai:<id>')
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
    for (const id of ['openai:', 'anthropic:', 'zai:', 'xai:', 'custom:', 'custom:gw', 'custom:gw:', 'custom::m']) expect(classifyModel(id)).toEqual({ kind: 'malformed', prefix: id.slice(0, id.indexOf(':')) })
    for (const id of ['claude-haiku-4-5', 'foo:bar', '']) expect(classifyModel(id)).toEqual({ kind: 'unprefixed' })
    for (const id of ['openai:gpt-5', 'xai:grok-4.7', 'custom:gw:m']) expect(classifyModel(id)).toEqual({ kind: 'route', route: parseModel(id)! })
  })
})
