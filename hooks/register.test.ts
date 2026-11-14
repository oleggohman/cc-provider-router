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
