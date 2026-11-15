import { expect, test } from 'claude-code/testing'

// Drains a turn.step stream; `stream.result` is undefined in the test kit.
async function drain(stream: AsyncGenerator<any, any>) {
  const chunks: any[] = []
  let step = await stream.next()
  while (!step.done) {
    chunks.push(step.value)
    step = await stream.next()
  }
  return { chunks, result: step.value }
}

test('unprefixed turn.step passes through to next unchanged', async ($, on) => {
  on('clock.sleep', () => ({ value: undefined }) as any)
  const seen: any[] = []
  on('turn.step', async function* (_$, e) {
    seen.push(e)
    yield { kind: 'text', index: 0, text: 'from-engine' } as any
    yield { kind: 'stop', stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as any
    return { turnId: e.turnId, index: e.index, answer: 'from-engine', toolUses: [] } as any
  })

  const e = { turnId: 't1', index: 0, model: 'claude-haiku-4-5', messageCount: 1 }
  const { chunks, result } = await drain($.turn.step(e) as any)

  expect(seen.length).toBe(1)
  expect(seen[0].model).toBe('claude-haiku-4-5')
  expect(seen[0].turnId).toBe('t1')
  expect(chunks[0].text).toBe('from-engine')
  expect(result.answer).toBe('from-engine')
})

// ---------------------------------------------------------------------------
// Loop state kept by the router across steps (usage for compaction, thread
// state for continues).

import { onSubagentTurnEnd, onUnprefixedStep } from './register.ts'

function loopState() {
  const usage = new Map<string, any>([['main', { model: 'openai:gpt-5', inputTokens: 1 }], ['ag-1', { model: 'openai:gpt-5', inputTokens: 2 }]])
  const threads = new Map<string, any>([['main', { system: 'S', tools: [], base: [] }], ['ag-1', { system: 'A', tools: [{ name: 'Bash' }], base: [{ role: 'user', content: 'x' }] }]])
  return { usage, threads }
}

test('an unprefixed step forgets that loop only (back on the subscription)', () => {
  const s = loopState()
  onUnprefixedStep(s, undefined)
  expect(s.usage.has('main')).toBe(false)
  expect(s.threads.has('main')).toBe(false)
  expect(s.threads.has('ag-1')).toBe(true)
  onUnprefixedStep(s, 'ag-1')
  expect(s.usage.size + s.threads.size).toBe(0)
})

test("a subagent's turn end frees its usage and conversation, keeps its system prompt and tools for a resume", () => {
  const s = loopState()
  onSubagentTurnEnd(s, 'ag-1')
  expect(s.usage.has('ag-1')).toBe(false)
  expect(s.threads.get('ag-1')).toEqual({ system: 'A', tools: [{ name: 'Bash' }], base: undefined })
  expect(s.usage.has('main')).toBe(true)
  expect(s.threads.get('main').base).toEqual([])
})

function engineStub(on: any) {
  const seen: any[] = []
  on('turn.step', async function* (_$: any, e: any) {
    seen.push(e)
    return { turnId: e.turnId, index: e.index, answer: 'ENGINE', toolUses: [] } as any
  } as any)
  return seen
}

test('a malformed prefixed id is answered locally and never reaches the engine', async ($, on) => {
  on('clock.sleep', () => ({ value: undefined }) as any)
  const seen = engineStub(on)
  for (const model of ['openai:', 'custom:gw', 'custom:gw:']) {
    const { result } = await drain($.turn.step({ turnId: 't1', index: 0, model, messageCount: 1 }) as any)
    expect(result.answer).toContain('[provider-router]')
    expect(result.answer).toContain('malformed model id')
    expect(result.stopReason).toBe('refusal')
  }
  expect(seen.length).toBe(0)
})

test('a failed config load is not kept: the step ends with a local error, the next one loads again', async ($, on) => {
  on('clock.sleep', () => ({ value: undefined }) as any)
  let calls = 0
  on('env.get', (_$: any, e: any) => {
    if (calls++ === 0) throw new Error('env refused')
    return { value: e.name === 'OPENAI_API_KEY' ? 'sk-test-plugin-key-123456' : undefined }
  })
  const net: any[] = []
  on('http.fetch', (_$: any, e: any) => {
    net.push(e)
    return { value: { status: 200, ok: true, headers: {}, text: '' } }
  })
  const seen = engineStub(on)
  const first = await drain($.turn.step({ turnId: 't1', index: 0, model: 'openai:gpt-5', messageCount: 1 }) as any)
  expect(first.result.answer).toContain('[provider-router] openai error')
  expect(seen.length).toBe(0)
  const second = await drain($.turn.step({ turnId: 't1', index: 1, model: 'openai:gpt-5', messageCount: 1 }) as any)
  // Past the config and the key check: the engine was asked for the shadow.
  expect(second.result.answer).toContain('shadow request failed')
  expect(seen.length).toBe(1)
  expect(net.length).toBe(0)
})

test('session.start: a refused /providers registration does not fail the session', async ($, on) => {
  let asked = 0
  on('command.register', () => {
    asked++
    throw new Error('commands are off in this mode')
  })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }) as any)
  const r: any = await ($ as any).session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  expect(asked).toBe(1)
  expect(r.cwd).toBe('/tmp')
})
