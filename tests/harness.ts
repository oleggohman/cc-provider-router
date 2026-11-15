// Shared test stand-ins: an engine that sends its shadow request through the
// mod's shadowFetch (the network beneath counts calls) and reads the answer
// as Claude Code does, a provider fetch, a controllable sleep, and a stream
// drain. No live provider is ever called.

import type { FetchSide } from '../hooks/call.ts'
import { shadowFetch } from '../hooks/shadow.ts'

export const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Object keys in reverse order at every level: the engine hands tool
// arguments back with the same values, keys reordered.
function reordered(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reordered)
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).reverse().map(k => [k, reordered((v as any)[k])]))
  return v
}

const ENGINE_STOPS = new Set(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'])

// What the engine makes of the answer to its request, as Claude Code 2.1.325
// does (docs/design-notes.md, "Answer in place: spike", row 11): the SSE's
// blocks as chunks (an empty text block gives none), a stop chunk with the
// SSE's usage and model, and a result whose `answer` is the text trimmed and
// whose tool arguments hold the same values with keys reordered. A refused
// request (no 200), a body that does not parse, one cut before
// `message_stop`, or an unknown stop reason: no stop chunk, and the result's
// `stopReason` and `usage` are null.
export function engineReads(e: { turnId: string; index: number }, response: { status?: number; text?: string } | undefined): { chunks: any[]; result: any } {
  const chunks: any[] = []
  const failed = { turnId: e.turnId, index: e.index, answer: '', toolUses: [] as any[], stopReason: null, usage: null }
  if (!response || response.status !== 200 || typeof response.text !== 'string') return { chunks, result: failed }
  let model = ''
  let stop: string | null = null
  let ended = false
  let text = ''
  const tools: { name: string; json: string }[] = []
  try {
    for (const frame of response.text.split('\n\n')) {
      if (!frame.trim()) continue
      const data = frame.split('\n').find(l => l.startsWith('data: '))
      if (!data) throw new Error('no data line')
      const ev = JSON.parse(data.slice(6))
      if (ev.type === 'message_start') model = ev.message?.model ?? ''
      else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        chunks.push({ kind: 'tool', index: ev.index, id: ev.content_block.id, name: ev.content_block.name })
        tools.push({ name: ev.content_block.name, json: '' })
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        if (ev.delta.text) chunks.push({ kind: 'text', index: ev.index, text: ev.delta.text })
        text += ev.delta.text
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta') {
        chunks.push({ kind: 'input', index: ev.index, json: ev.delta.partial_json })
        tools[tools.length - 1]!.json += ev.delta.partial_json
      } else if (ev.type === 'message_delta') stop = ev.delta?.stop_reason ?? null
      else if (ev.type === 'message_stop') ended = true
    }
  } catch {
    return { chunks, result: { ...failed, answer: text.trim() } }
  }
  const toolUses = tools.map(t => ({ name: t.name, input: reordered(JSON.parse(t.json || '{}')) }))
  if (!ended || stop === null || !ENGINE_STOPS.has(stop)) return { chunks, result: { ...failed, answer: text.trim(), toolUses } }
  const usage = { ...ZERO, model }
  chunks.push({ kind: 'stop', stopReason: stop, usage })
  return { chunks, result: { turnId: e.turnId, index: e.index, answer: text.trim(), toolUses, stopReason: stop, usage } }
}

// `extra` adds fields to the engine's request body (e.g. metadata, thinking).
// `refs`: yield `engine` chunks around the answer's chunks, as the engine
// does (they carry no content). `side`: the fetch hook's transport factory,
// as register.ts passes it.
export function engine(extra: Record<string, unknown> = {}, opts: { refs?: boolean; side?: () => Promise<FetchSide> } = {}) {
  const network: any[] = []
  const seen: any[] = []
  const answers: any[] = []
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
      ...extra,
      stream: true,
    }
    if (opts.refs) yield { kind: 'engine', ref: 1 }
    const out: any = await shadowFetch(
      { url: 'https://api.anthropic.com/v1/messages', init: { method: 'POST', headers, compress: 'gzip', body: JSON.stringify(body) } },
      (x: any) => {
        network.push(x)
        return { value: { status: 200, ok: true, headers: {}, text: '' } }
      },
      { autoModeClassifier: true },
      opts.side,
    )
    answers.push(out?.value)
    const read = engineReads(e, out?.value)
    for (const c of read.chunks) yield c
    if (opts.refs) yield { kind: 'engine', ref: 2 }
    return read.result
  }
  return { network, seen, answers, next }
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

// A sleep that never fires on its own (the provider reply always wins),
// unless the test calls `fire()` (the timer wins).
export function sleeper() {
  const calls: { ms: number; signal?: AbortSignal }[] = []
  let fire: (() => void) | undefined
  const sleep = (ms: number, o?: { signal?: AbortSignal }) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ ms, signal: o?.signal })
      fire = resolve
      o?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
  return { calls, sleep, fire: () => fire?.() }
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
  return { keys, custom: new Map(), contextWindows: new Map(), autoModeClassifier: true, warnings: [], ...over }
}

export const step = (model: string, over: any = {}) => ({ turnId: 't1', index: 0, model, messageCount: 3, effort: 'high', ...over })

export async function tick() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
