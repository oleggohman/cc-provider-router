// Stand-ins shared by the Task 7 tests: an engine that sends its shadow
// request through the mod's shadowFetch (the network beneath counts calls),
// a provider fetch, a controllable sleep, and a stream drain. No live
// provider is ever called.

import { shadowFetch } from '../hooks/shadow.ts'

export const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

export function engine() {
  const network: any[] = []
  const seen: any[] = []
  const next = async function* (e: any): AsyncGenerator<any, any> {
    seen.push(e)
    const headers: Record<string, string> = { 'x-claude-code-session-id': 's1' }
    if (e.agentId) headers['x-claude-code-agent-id'] = e.agentId
    const body = {
      model: e.model,
      system: [{ type: 'text', text: 'CAPTURED-SYS' }],
      tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'list files' }],
      max_tokens: 32000,
      stream: true,
    }
    await shadowFetch({ url: 'https://api.anthropic.com/v1/messages', init: { method: 'POST', headers, compress: 'gzip', body: JSON.stringify(body) } }, (x: any) => {
      network.push(x)
      return { value: { status: 200, ok: true, headers: {}, text: '' } }
    })
    yield { kind: 'text', index: 0, text: 'ENGINE-STUB-CHUNK' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: ZERO }
    return { turnId: e.turnId, index: e.index, answer: 'ENGINE-STUB-CHUNK', toolUses: [] }
  }
  return { network, seen, next }
}

export type Answer = { status: number; text: string } | Error

// A provider stand-in: answers per call (a function of url/init, or a list),
// or throws when the answer is an Error.
export function provider(answers: Answer[] | ((url: string, init: any) => Answer)) {
  const calls: { url: string; init: any }[] = []
  const fetch = async (url: string, init: any) => {
    calls.push({ url, init })
    const a = typeof answers === 'function' ? answers(url, init) : (answers[calls.length - 1] ?? answers[answers.length - 1]!)
    if (a instanceof Error) throw a
    return { status: a.status, ok: a.status >= 200 && a.status < 300, headers: { 'content-type': 'application/json' }, text: a.text }
  }
  return { calls, fetch }
}

// A sleep that never fires on its own (the provider reply always wins).
export function sleeper() {
  const calls: number[] = []
  const sleep = (ms: number, o?: { signal?: AbortSignal }) =>
    new Promise<void>((_resolve, reject) => {
      calls.push(ms)
      o?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
  return { calls, sleep }
}

export async function drain(g: AsyncGenerator<any, any> | AsyncIterable<any>) {
  const it = (g as any)[Symbol.asyncIterator] ? (g as any)[Symbol.asyncIterator]() : g
  const chunks: any[] = []
  let s = await it.next()
  while (!s.done) {
    chunks.push(s.value)
    s = await it.next()
  }
  return { chunks, result: s.value }
}

export function cfg(keys: Record<string, string>, over: any = {}): any {
  return { keys, custom: new Map(), contextWindows: new Map(), warnings: [], ...over }
}

export const step = (model: string, over: any = {}) => ({ turnId: 't1', index: 0, model, messageCount: 3, effort: 'high', ...over })

export async function tick() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
