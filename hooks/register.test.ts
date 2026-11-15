import { describe, expect, test } from 'claude-code/testing'
import { compactThreshold, maybeCompact, type UsageMap } from './context.ts'
import { fetchSide, markStep, onSubagentTurnEnd, onUnprefixedStep, routedStep } from './register.ts'
import { classifyModel } from './route.ts'
import { SHADOW_MODEL, endShadow, latestJob, resetShadow, sessionFlags, shadowFetch, shadowStats } from './shadow.ts'
import type { ThreadState } from './thread.ts'
import type { TransportCache } from './transport.ts'
import { cfg, drain, engine, provider, sleeper, step, tick } from '../tests/harness.ts'

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

// ---------------------------------------------------------------------------
// Session flags for the autoModeClassifier opt-out (shadow.ts): set by the
// turn.step hook for every step, before anything else runs.

test('markStep: a routed step of any loop sets routedSeen and stepSeen; an unprefixed step never clears routedSeen', () => {
  resetShadow()
  markStep(classifyModel('claude-haiku-4-5'))
  expect(sessionFlags()).toEqual({ routedSeen: false, stepSeen: true })
  markStep(classifyModel('custom:gw:m'))
  expect(sessionFlags()).toEqual({ routedSeen: true, stepSeen: true })
  markStep(classifyModel('claude-haiku-4-5'))
  expect(sessionFlags()).toEqual({ routedSeen: true, stepSeen: true })
  resetShadow()
})

test('markStep: a malformed prefixed id counts as routed (the stricter reading)', () => {
  resetShadow()
  markStep(classifyModel('openai:'))
  expect(sessionFlags()).toEqual({ routedSeen: true, stepSeen: true })
  resetShadow()
})

test('the plugin loads with autoModeClassifier false and unprefixed steps still pass through', { options: { autoModeClassifier: false } }, async ($, on) => {
  on('clock.sleep', () => ({ value: undefined }) as any)
  const seen = engineStub(on)
  const { result } = await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-4-5', messageCount: 1 }) as any)
  expect(seen.length).toBe(1)
  expect(result.answer).toBe('ENGINE')
})

// ---------------------------------------------------------------------------
// Provider transport (transport.ts): built from the http.fetch hook's own `$`
// for a captured shadow request's handler; shown by /providers.

const FAKE = 'FAKEKEYregister01234567'

function fake$(over: { spawn?: (req: any) => any; fetch?: (url: string, init: any) => Promise<any> } = {}) {
  const spawned: any[] = []
  const fetched: string[] = []
  const versionOk = (req: any) => {
    spawned.push(req)
    const chunks = req.argv.includes('--version')
      ? [{ stream: 'stdout', text: 'curl 8.7.1 (x) libcurl/8.7.1\n' }]
      : [{ stream: 'stdout', text: '{"ok":1}\n@@provider-router-status@@200' }]
    let i = 0
    return { [Symbol.asyncIterator]: () => ({ next: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: { code: 0, signal: null } }) }) }
  }
  const $ = {
    env: { get: async (n: string) => (n === 'OPENAI_API_KEY' ? FAKE : undefined) },
    process: { spawn: over.spawn ?? versionOk },
    clock: { sleep: () => new Promise<void>(() => undefined) },
    http: {
      fetch: over.fetch ?? (async (url: string) => (fetched.push(url), { status: 200, ok: true, headers: {}, text: '{}' })),
    },
  }
  return { $, spawned, fetched }
}

test('fetchSide: curl when curl --version runs (checked once per load); calls go through curl with the key on stdin only', async () => {
  const f = fake$()
  const t: TransportCache = {}
  const cache = {}
  const side = await fetchSide(f.$, new AbortController().signal, t, cache, {})
  expect(side.transport).toBe('curl')
  const r = await side.fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${FAKE}` }, body: '{}' })
  expect(r.status).toBe(200)
  await fetchSide(f.$, new AbortController().signal, t, cache, {})
  expect(f.spawned.filter(s => s.argv.includes('--version')).length).toBe(1)
  const call = f.spawned.find(s => !s.argv.includes('--version'))
  expect(call.argv).toEqual(['curl', '--disable', '--config', '-'])
  expect(JSON.stringify([call.argv, call.env]).includes(FAKE)).toBe(false)
  expect(f.fetched.length).toBe(0)
})

test('fetchSide: $.http.fetch when curl cannot be started', async () => {
  const f = fake$({
    spawn: () => {
      throw new Error('spawn curl ENOENT')
    },
  })
  const side = await fetchSide(f.$, new AbortController().signal, {}, {}, {})
  expect(side.transport).toBe('fetch')
  await side.fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: {}, body: '{}' })
  expect(f.fetched).toEqual(['https://api.openai.com/v1/chat/completions'])
})

test('/providers shows the autoModeClassifier option and the classifier counters', { options: { autoModeClassifier: false } }, async ($, on) => {
  on('env.get', () => ({ value: undefined }) as any)
  const r: any = await ($ as any).command.run({ command: 'providers', args: '' })
  expect(r.text).toContain('autoModeClassifier: off')
  expect(r.text).toMatch(/classifier requests: passed \d+, refused \d+/)
})

test('/providers names the transport; in the test kit (no process noun) it is fetch with its 30 s limit', async ($, on) => {
  on('env.get', () => ({ value: undefined }) as any)
  const r: any = await ($ as any).command.run({ command: 'providers', args: '' })
  expect(r.text).toContain('transport: fetch (30 s limit)')
})

// ---------------------------------------------------------------------------
// routedStep, answer in place: the step registers a job whose handler answers
// the engine's shadow request with the provider's reply; the engine's own
// chunks flow up; after the stream the step decides delivery.

const ZAI = { provider: 'zai', model: 'glm-5.3' } as const
const ZAI_ID = 'zai:glm-5.3'
const zcfg = () => cfg({ zai: 'k-zai-test-1' })
const reply = (content: any[], stop = 'end_turn') => ({ status: 200, text: JSON.stringify({ model: 'glm-5.3', content, stop_reason: stop, usage: { input_tokens: 42, output_tokens: 3 } }) })
const TEXT = reply([{ type: 'text', text: '  Hello there \n' }])
const TOOL = reply([{ type: 'text', text: 'Running' }, { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls', cwd: '/tmp', opts: { a: 1, b: [1, { c: 2, d: 3 }] } } }], 'tool_use')
const io = (fetch: any, signal = new AbortController().signal, over: any = {}) => ({ fetch, sleep: sleeper().sleep, signal, ...over })
const zstep = (over: any = {}) => step('zai:glm-5.3', over)

// The engine's stream as the step reads it, with what it yielded and returned.
function tap(next: (e: any) => AsyncGenerator<any, any>) {
  const yielded: any[] = []
  const t = { yielded, returned: undefined as any, next: undefined as any }
  t.next = async function* (e: any): AsyncGenerator<any, any> {
    const it = next(e)
    let s = await it.next()
    while (!s.done) {
      yielded.push(s.value)
      yield s.value
      s = await it.next()
    }
    t.returned = s.value
    return s.value
  }
  return t
}

// A provider call that waits until the test settles it.
function held() {
  const calls: any[] = []
  let settle: ((v: any) => void) | undefined
  let fail: ((e: unknown) => void) | undefined
  const fetch = (url: string, init: any) => {
    calls.push({ url, init })
    return new Promise<any>((res, rej) => {
      settle = (a: any) => res({ status: a.status, ok: a.status >= 200 && a.status < 300, text: a.text })
      fail = rej
    })
  }
  return { calls, fetch, settle: (a: any) => settle?.(a), fail: (e: unknown) => fail?.(e) }
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 50 && !cond(); i++) await tick()
}

describe('routedStep: the engine answers in place', () => {
  test("registers a job with the handler, yields the engine's chunks unchanged, returns its result, ends the job", async () => {
    resetShadow()
    const eng = engine({}, { refs: true })
    const t = tap(eng.next)
    const p = provider([TOOL])
    const g = routedStep(zstep(), t.next, ZAI, zcfg(), io(p.fetch), new Map())
    const first = await g.next()
    // The job is pending while the engine's stream runs.
    expect(shadowStats().pending).toBe(1)
    const rest = await drain(g)
    const chunks = [first.value, ...rest.chunks]
    expect(eng.seen[0].model).toBe(SHADOW_MODEL)
    expect(eng.network.length).toBe(0)
    expect(p.calls.length).toBe(1)
    expect(eng.answers[0].text).toContain('"id":"msg_pr_')
    expect(eng.answers[0].text).toContain('"input_tokens":0')
    expect(chunks).toEqual(t.yielded)
    expect(chunks.map(c => c.kind)).toEqual(['engine', 'text', 'tool', 'input', 'stop', 'engine'])
    // The step returns the engine's result as it is: its zeros, not the
    // provider's usage (that goes to the usage record, see below).
    expect(rest.result).toEqual(t.returned)
    expect(rest.result.usage.input_tokens).toBe(0)
    expect(shadowStats()).toEqual({ shadowLeaks: 0, shadowRefused: 0, pending: 0, blind: false, classifierPassed: 0, classifierRefused: 0 })
  })

  test("an error outcome: none of the stub's chunks, then the error chunks and their result", async () => {
    resetShadow()
    const eng = engine({}, { refs: true })
    const t = tap(eng.next)
    const p = provider([{ status: 500, text: '{"error":{"message":"boom"}}' }])
    const { chunks, result } = await drain(routedStep(zstep(), t.next, ZAI, zcfg(), io(p.fetch), new Map()))
    // The engine read the stub (an empty answer) and yielded its chunks.
    expect(eng.answers[0].text).toContain('msg_shadow')
    expect(t.yielded.some(c => c.kind === 'stop' && c.stopReason === 'end_turn')).toBe(true)
    expect(chunks.length).toBe(2)
    expect(chunks[0].kind).toBe('text')
    expect(chunks[0].text.startsWith('[provider-router] zai error 500')).toBe(true)
    expect(chunks[1]).toEqual({ kind: 'stop', stopReason: 'refusal', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'zai:glm-5.3' } })
    expect(result.answer).toBe(chunks[0].text)
    expect(result.stopReason).toBe('refusal')
    expect(eng.network.length).toBe(0)
    expect(shadowStats().pending).toBe(0)
  })

  test('a cancelled outcome (Esc during the provider call): nothing yielded, the cancelled result', async () => {
    resetShadow()
    const eng = engine({}, { refs: true })
    const h = held()
    const esc = new AbortController()
    const pending = drain(routedStep(zstep(), eng.next, ZAI, zcfg(), io(h.fetch, esc.signal), new Map()))
    await until(() => h.calls.length > 0)
    esc.abort()
    const { chunks, result } = await pending
    expect(chunks).toEqual([])
    expect(result).toEqual({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: null, usage: null })
    expect(eng.answers[0].text).toContain('msg_shadow')
    expect(shadowStats().pending).toBe(0)
    // A late reply changes nothing and rejects nothing.
    h.settle(TEXT)
    await tick()
  })

  test('an early failure (missing key, unknown endpoint) answers without calling next', async () => {
    resetShadow()
    const eng = engine()
    const p = provider([TEXT])
    const missing = await drain(routedStep(zstep(), eng.next, ZAI, cfg({}), io(p.fetch), new Map()))
    expect(missing.result.answer).toContain('ZAI_API_KEY')
    const unknown = await drain(routedStep(step('custom:nope:m'), eng.next, { provider: 'custom', name: 'nope', model: 'm' } as any, cfg({}), io(p.fetch), new Map()))
    expect(unknown.result.answer).toContain('[provider-router]')
    expect(unknown.result.stopReason).toBe('refusal')
    expect(eng.seen.length).toBe(0)
    expect(p.calls.length).toBe(0)
    expect(shadowStats().pending).toBe(0)
  })

  test('the handler gets the fetch hook transport: curl when curl runs, never the step io fetch', async () => {
    resetShadow()
    const spawned: any[] = []
    const okReply = JSON.stringify({ choices: [{ message: { content: 'VIA-CURL' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } })
    const f = fake$({
      spawn: (req: any) => {
        spawned.push(req)
        const chunks = req.argv.includes('--version') ? [{ stream: 'stdout', text: 'curl 8.7.1\n' }] : [{ stream: 'stdout', text: `${okReply}\n@@provider-router-status@@200` }]
        let i = 0
        return { [Symbol.asyncIterator]: () => ({ next: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: { code: 0, signal: null } }) }) }
      },
    })
    const kinds: string[] = []
    const side = async () => {
      const s = await fetchSide(f.$, new AbortController().signal, {}, {}, {})
      kinds.push(s.transport)
      return s
    }
    const eng = engine({}, { side })
    const stepFetch = provider([TEXT])
    const { result } = await drain(routedStep(step('openai:gpt-5'), eng.next, { provider: 'openai', model: 'gpt-5' } as any, cfg({ openai: FAKE }), io(stepFetch.fetch), new Map()))
    expect(kinds).toEqual(['curl'])
    expect(result.answer).toBe('VIA-CURL')
    expect(stepFetch.calls.length).toBe(0)
    expect(f.fetched.length).toBe(0)
    const call = spawned.find(s => !s.argv.includes('--version'))
    expect(call.argv).toEqual(['curl', '--disable', '--config', '-'])
    expect(eng.network.length).toBe(0)
  })
})

describe('routedStep: usage comes from the job, not the engine result', () => {
  // The engine's result carries the SSE's zeros; the provider's real usage
  // goes to the loop's usage record only after a delivered step.
  const usageAt = (inputTokens: number) => ({ status: 200, text: JSON.stringify({ model: 'glm-5.3', content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn', usage: { input_tokens: inputTokens, output_tokens: 3 } }) })
  const record = (map: UsageMap) => map.get('main')

  test('a delivered reply records the provider\'s real usage for its loop', async () => {
    resetShadow()
    const usage: UsageMap = new Map()
    const { result } = await drain(routedStep(zstep(), engine().next, ZAI, zcfg(), io(provider([TEXT]).fetch), new Map(), usage))
    expect(record(usage)).toEqual({ model: 'zai:glm-5.3', inputTokens: 42 })
    expect(result.usage.input_tokens).toBe(0)
  })

  test('an error step records nothing and keeps the previous record', async () => {
    resetShadow()
    const usage: UsageMap = new Map([['main', { model: 'zai:glm-5.3', inputTokens: 390000 }]])
    await drain(routedStep(zstep(), engine().next, ZAI, zcfg(), io(provider([{ status: 503, text: '{}' }]).fetch), new Map(), usage))
    expect(record(usage)).toEqual({ model: 'zai:glm-5.3', inputTokens: 390000 })
  })

  test('a step whose delivery does not match records nothing', async () => {
    resetShadow()
    const usage: UsageMap = new Map()
    const eng = engine()
    const next = async function* (e: any): AsyncGenerator<any, any> {
      return { ...(yield* eng.next(e)), stopReason: null }
    }
    await drain(routedStep(zstep(), next, ZAI, zcfg(), io(provider([TEXT]).fetch), new Map(), usage))
    expect(usage.size).toBe(0)
  })

  test('Esc before delivery records nothing', async () => {
    resetShadow()
    const usage: UsageMap = new Map()
    const h = held()
    const esc = new AbortController()
    const pending = drain(routedStep(zstep(), engine().next, ZAI, zcfg(), io(h.fetch, esc.signal), new Map(), usage))
    await until(() => h.calls.length > 0)
    esc.abort()
    await pending
    expect(usage.size).toBe(0)
    h.settle(TEXT)
    await tick()
  })

  test("the mod's own compaction is scheduled from the recorded usage, the engine's result stays at zero", async () => {
    resetShadow()
    const at = compactThreshold(ZAI_ID, new Map())!
    const usage: UsageMap = new Map()
    const { result } = await drain(routedStep(zstep(), engine().next, ZAI, zcfg(), io(provider([usageAt(at)]).fetch), new Map(), usage))
    expect(result.usage.input_tokens).toBe(0)
    const queued: Array<() => void> = []
    expect(maybeCompact(usage, new Map(), { after: (_ms, fn) => void queued.push(fn), compact: async () => ({}) })).toBe(true)
    expect(queued.length).toBe(1)
  })
})

describe('routedStep: the delivery decision', () => {
  const PRIOR: ThreadState = { system: 'OLD-SYS', tools: [{ name: 'Old' }], base: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'OLD' }], anchors: { msg_old: 2 } }
  const seeded = () => new Map<string, ThreadState>([['main', structuredClone(PRIOR)]])
  const minted = (eng: { answers: any[] }) => /"id":"(msg_pr_[^"]+)"/.exec(eng.answers[0].text)![1]!

  test('handed reply, the result matches (answer trimmed, argument keys reordered), not aborted: recorded with the minted id as an anchor', async () => {
    resetShadow()
    const eng = engine()
    const threads = seeded()
    const { result } = await drain(routedStep(zstep(), eng.next, ZAI, zcfg(), io(provider([TOOL]).fetch), threads))
    expect(result.answer).toBe('Running')
    expect(Object.keys(result.toolUses[0].input)).toEqual(['opts', 'cwd', 'command'])
    const s = threads.get('main')!
    expect(s.base).toEqual([{ role: 'user', content: 'list files' }, { role: 'assistant', content: JSON.parse(TOOL.text).content }])
    expect(s.anchors).toEqual({ [minted(eng)]: 2 })
    expect(s.system).toEqual([{ type: 'text', text: 'CAPTURED-SYS' }])
    expect(s.tools!.map((x: any) => x.name)).toEqual(['Bash'])
  })

  test('handed error, the error chunks read to the end, not aborted: the error text is recorded, only after the last read', async () => {
    resetShadow()
    const threads = seeded()
    const g = routedStep(zstep(), engine().next, ZAI, zcfg(), io(provider([{ status: 503, text: '{}' }]).fetch), threads)
    const text = await g.next()
    const stop = await g.next()
    expect(stop.value.kind).toBe('stop')
    expect(threads.get('main')!.base).toBe(undefined)
    const end = await g.next()
    expect(end.done).toBe(true)
    expect(threads.get('main')!.base).toEqual([{ role: 'user', content: 'list files' }, { role: 'assistant', content: [{ type: 'text', text: text.value.text }] }])
  })

  test('handed reply, the result differs (stop reason null, other text, other argument value, other tool name): the conversation is dropped, system and tools kept', async () => {
    const changes: Array<(r: any) => any> = [
      r => ({ ...r, stopReason: null }),
      r => ({ ...r, answer: 'Running!' }),
      r => ({ ...r, toolUses: [{ ...r.toolUses[0], input: { ...r.toolUses[0].input, command: 'rm' } }] }),
      r => ({ ...r, toolUses: [{ ...r.toolUses[0], name: 'Write' }] }),
      r => ({ ...r, toolUses: [] }),
    ]
    for (const change of changes) {
      resetShadow()
      const eng = engine()
      const next = async function* (e: any): AsyncGenerator<any, any> {
        return change(yield* eng.next(e))
      }
      const threads = seeded()
      const { result } = await drain(routedStep(zstep(), next, ZAI, zcfg(), io(provider([TOOL]).fetch), threads))
      expect(result.answer === 'Running' || result.answer === 'Running!').toBe(true)
      const s = threads.get('main')!
      expect(s.base).toBe(undefined)
      expect(s.anchors).toBe(undefined)
      expect(s.system).toEqual([{ type: 'text', text: 'CAPTURED-SYS' }])
      expect(s.tools!.map((x: any) => x.name)).toEqual(['Bash'])
    }
  })

  test('handed cancelled, aborted: nothing recorded, the conversation dropped, nothing yielded', async () => {
    resetShadow()
    const h = held()
    const esc = new AbortController()
    const threads = seeded()
    const pending = drain(routedStep(zstep(), engine().next, ZAI, zcfg(), io(h.fetch, esc.signal), threads))
    await until(() => h.calls.length > 0)
    esc.abort()
    const { chunks } = await pending
    expect(chunks).toEqual([])
    expect(threads.get('main')!.base).toBe(undefined)
    expect(threads.get('main')!.system).toEqual([{ type: 'text', text: 'CAPTURED-SYS' }])
  })

  test('captured, never handed (the stream ended first): the conversation is dropped, an error reply, a late reply discarded', async () => {
    resetShadow()
    const h = held()
    const threads = seeded()
    // An engine whose stream ends without waiting for its request's answer.
    const answers: any[] = []
    const next = async function* (e: any): AsyncGenerator<any, any> {
      const body = JSON.stringify({ model: e.model, system: [{ type: 'text', text: 'CAPTURED-SYS' }], tools: [{ name: 'Bash', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'go' }] })
      void Promise.resolve(shadowFetch({ url: 'https://api.anthropic.com/v1/messages', init: { method: 'POST', headers: { 'x-claude-code-session-id': 's1' }, body } }, () => ({ value: { status: 599 } }), { autoModeClassifier: true })).then(a => answers.push(a))
      await until(() => h.calls.length > 0)
      yield { kind: 'engine', ref: 1 }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    }
    const { chunks, result } = await drain(routedStep(zstep(), next, ZAI, zcfg(), io(h.fetch), threads))
    expect(chunks.map(c => c.kind)).toEqual(['text', 'stop'])
    expect(result.answer).toContain('[provider-router] zai error')
    expect(result.answer).toContain('not handed')
    expect(threads.get('main')!.base).toBe(undefined)
    expect(shadowStats().pending).toBe(0)
    h.settle(TEXT)
    await until(() => answers.length > 0)
    expect(answers[0].value.text).toContain('msg_shadow')
    expect(threads.get('main')!.base).toBe(undefined)
  })

  test('registered (never captured), not aborted: the conversation is dropped and the breaker rule applies', async () => {
    resetShadow()
    const threads = seeded()
    const silent = async function* (e: any): AsyncGenerator<any, any> {
      yield { kind: 'engine', ref: 1 }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] }
    }
    const { chunks, result } = await drain(routedStep(zstep(), silent, ZAI, zcfg(), io(provider([TEXT]).fetch), threads))
    expect(chunks.some(c => c.kind === 'engine')).toBe(false)
    expect(result.answer).toContain('not captured')
    expect(result.answer).toContain('routing is off')
    expect(threads.get('main')!.base).toBe(undefined)
    expect(threads.get('main')!.system).toBe('OLD-SYS')
    expect(shadowStats().blind).toBe(true)
    resetShadow()
  })

  test('aborted before handed (Esc before the request): nothing recorded, the loop state untouched, nothing yielded', async () => {
    resetShadow()
    const threads = seeded()
    const esc = new AbortController()
    const next = async function* (e: any): AsyncGenerator<any, any> {
      yield { kind: 'engine', ref: 1 }
      esc.abort()
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    }
    const { chunks, result } = await drain(routedStep(zstep(), next, ZAI, zcfg(), io(provider([TEXT]).fetch, esc.signal), threads))
    expect(chunks).toEqual([])
    expect(result.stopReason).toBe(null)
    expect(threads.get('main')).toEqual(PRIOR)
    expect(shadowStats().blind).toBe(false)
    expect(shadowStats().pending).toBe(0)
  })

  test('iterator closed mid-stream: the conversation is dropped, the job ended, the engine stream closed', async () => {
    resetShadow()
    const threads = seeded()
    let closed = false
    const eng = engine()
    const next = async function* (e: any): AsyncGenerator<any, any> {
      try {
        return yield* eng.next(e)
      } finally {
        closed = true
      }
    }
    const g = routedStep(zstep(), next, ZAI, zcfg(), io(provider([TOOL]).fetch), threads)
    expect((await g.next()).value.kind).toBe('text')
    await g.return(undefined)
    expect(closed).toBe(true)
    expect(threads.get('main')!.base).toBe(undefined)
    expect(threads.get('main')!.system).toEqual([{ type: 'text', text: 'CAPTURED-SYS' }])
    expect(shadowStats().pending).toBe(0)
  })
})

describe('routedStep: abandonment and job identity', () => {
  test("the step's signal aborting while the generator stays suspended: the listener ends the job, a new step runs, the old continuation touches nothing", async () => {
    resetShadow()
    const h = held()
    const threads = new Map<string, ThreadState>()
    const stepCtl = new AbortController()
    // The fetch hook's own dispatch stays live (the turn.step hook's budget ran out).
    const side = async () => ({ fetch: h.fetch, sleep: sleeper().sleep, signal: new AbortController().signal, transport: 'fetch' as const })
    const old = routedStep(zstep(), engine({}, { side }).next, ZAI, zcfg(), io(provider([]).fetch, stepCtl.signal), threads)
    const pull = old.next()
    await until(() => h.calls.length > 0)
    expect(shadowStats().pending).toBe(1)
    stepCtl.abort()
    expect(shadowStats().pending).toBe(0)
    // The next step on the loop starts and records its reply.
    const fresh = engine()
    const r = await drain(routedStep(zstep({ index: 1 }), fresh.next, ZAI, zcfg(), io(provider([TEXT]).fetch), threads))
    expect(r.result.answer).toBe('Hello there')
    const recorded = structuredClone(threads.get('main'))
    expect(recorded!.base!.length).toBe(2)
    // The old provider call answers late; the old generator is resumed to its end.
    h.settle(TOOL)
    await pull
    await drain(old)
    expect(threads.get('main')).toEqual(recorded)
    expect(shadowStats().pending).toBe(0)
  })

  test('a timeout followed at once by a new step on the loop; a late reply of the timed-out call changes nothing', async () => {
    resetShadow()
    const h = held()
    const s = sleeper()
    const threads = new Map<string, ThreadState>()
    const first = drain(routedStep(zstep(), engine().next, ZAI, zcfg(), { fetch: h.fetch, sleep: s.sleep, signal: new AbortController().signal, timeoutMs: 1000 }, threads))
    await until(() => s.calls.length > 0)
    s.fire()
    const timedOut = await first
    expect(timedOut.result.answer).toContain('timed out')
    expect(threads.get('main')!.base![1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: timedOut.result.answer }] })
    const next = await drain(routedStep(zstep({ index: 1 }), engine().next, ZAI, zcfg(), io(provider([TEXT]).fetch), threads))
    expect(next.result.answer).toBe('Hello there')
    const recorded = structuredClone(threads.get('main'))
    h.settle(TOOL)
    await tick()
    expect(threads.get('main')).toEqual(recorded)
  })

  test("a continuation whose job is no longer the loop's newest leaves the loop's state alone", async () => {
    resetShadow()
    const threads = new Map<string, ThreadState>()
    const old = routedStep(zstep(), engine().next, ZAI, zcfg(), io(provider([TOOL]).fetch), threads)
    expect((await old.next()).value.kind).toBe('text')
    // The old job is ended from outside (as the abort listener would) while
    // its stream is suspended; a newer step then records.
    endShadow('main', latestJob('main')!)
    await drain(routedStep(zstep({ index: 1 }), engine().next, ZAI, zcfg(), io(provider([TEXT]).fetch), threads))
    const recorded = structuredClone(threads.get('main'))
    expect(recorded!.base![1].content).toEqual([{ type: 'text', text: '  Hello there \n' }])
    await drain(old)
    expect(threads.get('main')).toEqual(recorded)
  })

  test('listeners and timers are gone once a step settles (reply, error, Esc)', async () => {
    const counted = (ctl: AbortController) => {
      const c = { n: 0, signal: undefined as any }
      c.signal = {
        get aborted() {
          return ctl.signal.aborted
        },
        addEventListener: (t: 'abort', f: any, o?: any) => (c.n++, ctl.signal.addEventListener(t, f, o)),
        removeEventListener: (t: 'abort', f: any) => (c.n--, ctl.signal.removeEventListener(t, f)),
      }
      return c
    }
    for (const kind of ['reply', 'error', 'esc'] as const) {
      resetShadow()
      const ctl = new AbortController()
      const c = counted(ctl)
      const s = sleeper()
      const h = held()
      const fetch = kind === 'reply' ? provider([TEXT]).fetch : kind === 'error' ? provider([{ status: 500, text: '{}' }]).fetch : h.fetch
      const pending = drain(routedStep(zstep(), engine().next, ZAI, zcfg(), { fetch, sleep: s.sleep, signal: c.signal }, new Map()))
      if (kind === 'esc') {
        await until(() => h.calls.length > 0)
        ctl.abort()
        // Fired `once` listeners leave on their own.
        c.n = 0
      }
      await pending
      await tick()
      if (kind !== 'esc') expect([kind, c.n]).toEqual([kind, 0])
      expect(s.calls.every(x => x.signal?.aborted)).toBe(true)
      expect(shadowStats().pending).toBe(0)
    }
  })
})
