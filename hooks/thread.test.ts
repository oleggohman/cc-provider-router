import { describe, expect, test } from 'claude-code/testing'
import { cfg, drain, sleeper, provider, ZERO } from '../tests/harness.ts'
import { routedStep, type AgentRef } from './register.ts'
import { resetShadow, shadowFetch } from './shadow.ts'
import { dropBase, normalizeBody, resolveThread, type ThreadState } from './thread.ts'

// Engine request shapes seen live (Claude Code 2.1.323, message threads):
// the first request of a loop is a `thread: create` with everything; later
// ones are `thread: continue` with only the new messages, no tools, and a
// system prompt reduced to the billing header. Deferred tools arrive as
// `tool_addition` blocks in `role: "system"` messages.

const BILLING = { type: 'text', text: 'x-anthropic-billing-header: cc_version=0.0.0; cch=abc' }
const SYS = [BILLING, { type: 'text', text: 'You are an agent.', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } }]
const BASH = { name: 'Bash', description: 'run', input_schema: { type: 'object' }, eager_input_streaming: true }
const PLACEHOLDER = { name: 'DeferredToolPlaceholder', description: 'never call', input_schema: { type: 'object' }, defer_loading: true }
const LATE = { name: 'mcp__x__late', description: 'late tool', input_schema: { type: 'object' }, eager_input_streaming: true }

const createBody = {
  model: 'provider-router-shadow',
  thread: { type: 'create' },
  system: SYS,
  tools: [BASH, PLACEHOLDER],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'run echo' }] },
    {
      role: 'system',
      content: [
        { type: 'text', text: 'Deferred tools: mcp__x__late' },
        { type: 'tool_addition', tool: { type: 'tool_definition', definition: LATE } },
      ],
    },
  ],
}

const continueBody = {
  model: 'provider-router-shadow',
  thread: { type: 'continue', previous_message_id: 'msg_hook_1' },
  system: [BILLING],
  messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'OK', cache_control: { type: 'ephemeral', ttl: '1h' } }] }],
}

const REPLY = [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'echo' } }]

describe('resolveThread', () => {
  test('a create is used as is and needs no state', () => {
    const r = resolveThread(createBody, undefined)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body.messages).toEqual(createBody.messages)
  })

  test('a body without a thread field is used as is', () => {
    const { thread: _, ...plain } = createBody
    const r = resolveThread(plain, undefined)
    expect(r.ok).toBe(true)
  })

  test('a continue rebuilds the conversation from the loop state', () => {
    const state = { system: SYS, tools: [BASH, PLACEHOLDER], base: [...createBody.messages, { role: 'assistant', content: REPLY }] }
    const r = resolveThread(continueBody, state)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body.messages).toEqual([...createBody.messages, { role: 'assistant', content: REPLY }, ...continueBody.messages])
    expect(r.body.tools).toEqual([BASH, PLACEHOLDER])
    expect(r.body.system).toEqual(SYS)
  })

  test('a continue that carries its own tools and full system keeps them', () => {
    const state = { system: SYS, tools: [BASH], base: [] as any[] }
    const own = { ...continueBody, system: [BILLING, { type: 'text', text: 'NEW SYSTEM' }], tools: [LATE] }
    const r = resolveThread(own, state)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body.tools).toEqual([LATE])
    expect(JSON.stringify(r.body.system)).toContain('NEW SYSTEM')
  })

  test('a continue without state is a clear error, never a partial request', () => {
    const r = resolveThread(continueBody, undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('/clear')
  })

  test('a continue with no tools, empty tools or only the placeholder keeps the stored tools', () => {
    const state = { system: SYS, tools: [BASH, LATE], base: [] as any[] }
    for (const tools of [undefined, [], [PLACEHOLDER]]) {
      const r = resolveThread({ ...continueBody, tools }, state)
      expect(r.ok && r.body.tools).toEqual([BASH, LATE])
    }
  })

  test('no conversation known: rebuilt from the session history up to its last assistant turn', () => {
    const history = [createBody.messages[0], { role: 'assistant', content: REPLY }, ...continueBody.messages]
    // The loop's own system/tools kept (its conversation was dropped).
    const kept = resolveThread(continueBody, { system: SYS, tools: [BASH], base: undefined }, { history })
    expect(kept.ok).toBe(true)
    if (kept.ok) {
      expect(kept.body.messages).toEqual([createBody.messages[0], { role: 'assistant', content: REPLY }, ...continueBody.messages])
      expect(kept.body.system).toEqual(SYS)
      expect(kept.body.tools).toEqual([BASH])
    }
    // A loop never seen (an engine fork): system/tools from the fallback loop.
    const fork = resolveThread(continueBody, undefined, { history, fallback: { system: SYS, tools: [BASH], base: [] } })
    expect(fork.ok && fork.body.system).toEqual(SYS)
  })

  test('history without any assistant turn is not the thread: the clear error, never the delta alone', () => {
    const history = [createBody.messages[0]]
    for (const r of [
      resolveThread(continueBody, { system: SYS, tools: [BASH], base: undefined }, { history }),
      resolveThread(continueBody, undefined, { history, fallback: { system: SYS, tools: [BASH], base: undefined } }),
      resolveThread(continueBody, undefined, { history, fallback: { system: SYS, tools: [BASH], base: [createBody.messages[0]] } }),
    ]) {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.message).toContain('/clear')
    }
  })

  test('a fork whose own history gives no conversation builds on the main loop conversation', () => {
    const mainBase = [createBody.messages[0], { role: 'assistant', content: REPLY }]
    for (const history of [[createBody.messages[0]], undefined]) {
      const r = resolveThread(continueBody, undefined, { history, fallback: { system: SYS, tools: [BASH], base: mainBase } })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.body.messages).toEqual([...mainBase, ...continueBody.messages])
    }
  })

  test('no conversation and no way to rebuild it (no history, or no system prompt known): the clear error', () => {
    const history = [createBody.messages[0], { role: 'assistant', content: REPLY }]
    for (const r of [
      resolveThread(continueBody, { system: SYS, tools: [BASH], base: undefined }),
      resolveThread(continueBody, undefined, { history }),
      resolveThread(continueBody, undefined, { history: undefined, fallback: { system: SYS, tools: [BASH], base: [] } }),
    ]) {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.message).toContain('/clear')
    }
  })

  test('anchors: a new previous_message_id is bound to the conversation it continues', () => {
    const base = [createBody.messages[0], { role: 'assistant', content: REPLY }]
    const r = resolveThread(continueBody, { system: SYS, tools: [BASH], base })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.anchors).toEqual({ msg_hook_1: 2 })
  })

  test('anchors: a continue from an earlier known anchor (a rewind) drops the turns after it', () => {
    const u = (t: string) => ({ role: 'user', content: [{ type: 'text', text: t }] })
    const a = (t: string) => ({ role: 'assistant', content: [{ type: 'text', text: t }] })
    const base = [u('one'), a('ONE'), u('two'), a('TWO'), u('three'), a('THREE')]
    const state = { system: SYS, tools: [BASH], base, anchors: { msg_hook_1: 2, msg_hook_2: 4 } }
    const r = resolveThread(continueBody, state)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body.messages).toEqual([u('one'), a('ONE'), ...continueBody.messages])
    expect(r.anchors).toEqual({ msg_hook_1: 2 })
    expect(state.base.length).toBe(6)
  })

  test('anchors: the anchor of the newest recorded turn changes nothing', () => {
    const base = [createBody.messages[0], { role: 'assistant', content: REPLY }]
    const r = resolveThread(continueBody, { system: SYS, tools: [BASH], base, anchors: { msg_hook_1: 2 } })
    expect(r.ok && r.body.messages).toEqual([...base, ...continueBody.messages])
  })

  test('anchors: an anchor past the known conversation is the clear error', () => {
    const base = [createBody.messages[0], { role: 'assistant', content: REPLY }]
    const r = resolveThread(continueBody, { system: SYS, tools: [BASH], base, anchors: { msg_hook_1: 9 } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('/clear')
  })

  test('anchors: a create starts with none', () => {
    const r = resolveThread(createBody, { system: SYS, tools: [BASH], base: [], anchors: { msg_hook_1: 0 } })
    expect(r.ok && r.anchors).toEqual({})
  })

  test('dropBase forgets the conversation and its anchors and keeps the system prompt and tools', () => {
    const threads = new Map<string, ThreadState>([['ag-1', { system: SYS, tools: [BASH], base: [createBody.messages[0]], anchors: { msg_hook_1: 1 } }]])
    dropBase(threads, 'ag-1')
    expect(threads.get('ag-1')).toEqual({ system: SYS, tools: [BASH], base: undefined })
    expect(threads.get('ag-1')!.anchors).toBe(undefined)
    dropBase(threads, 'nobody')
    expect(threads.has('nobody')).toBe(false)
  })
})

describe('normalizeBody', () => {
  test('drops the billing header block and cache_control scope', () => {
    const n = normalizeBody(createBody)
    const text = JSON.stringify(n.system)
    expect(text).not.toContain('x-anthropic-billing-header')
    expect(text).toContain('You are an agent.')
    expect(text).not.toContain('scope')
    expect(text).toContain('ephemeral')
  })

  test('system-role messages become user text; tool_addition definitions join tools', () => {
    const n = normalizeBody(createBody)
    expect(n.messages.every((m: any) => m.role === 'user' || m.role === 'assistant')).toBe(true)
    expect(n.messages.length).toBe(1)
    expect(JSON.stringify(n.messages)).toContain('Deferred tools: mcp__x__late')
    expect(JSON.stringify(n.messages)).not.toContain('tool_addition')
    expect(n.tools.map((t: any) => t.name)).toEqual(['Bash', 'mcp__x__late'])
  })

  test('the placeholder tool and eager_input_streaming are dropped', () => {
    const n = normalizeBody(createBody)
    expect(n.tools.some((t: any) => t.name === 'DeferredToolPlaceholder')).toBe(false)
    expect(n.tools.some((t: any) => 'eager_input_streaming' in t)).toBe(false)
  })

  test('tool_addition by reference loads a deferred tool; tool_removal drops one', () => {
    const body = {
      tools: [BASH, { ...LATE, defer_loading: true }, { name: 'Gone', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'system',
          content: [
            { type: 'tool_addition', tool: { type: 'tool_reference', name: 'mcp__x__late' } },
            { type: 'tool_removal', tool: { type: 'tool_reference', name: 'Gone' } },
          ],
        },
      ],
    }
    const n = normalizeBody(body)
    expect(n.tools.map((t: any) => t.name)).toEqual(['Bash', 'mcp__x__late'])
    expect('defer_loading' in n.tools[1]).toBe(false)
    // A system message with no text leaves no message behind.
    expect(n.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  test('merged user messages keep tool_result blocks first', () => {
    const body = {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: REPLY },
        { role: 'system', content: [{ type: 'text', text: 'reminder' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'OK' }] },
      ],
    }
    const n = normalizeBody(body)
    expect(n.messages.length).toBe(3)
    expect(n.messages[2].role).toBe('user')
    expect(n.messages[2].content[0].type).toBe('tool_result')
    expect(n.messages[2].content[1]).toEqual({ type: 'text', text: 'reminder' })
  })

  test('a body without tools gets no tools field', () => {
    const n = normalizeBody({ messages: [{ role: 'user', content: 'hi' }] })
    expect('tools' in n).toBe(false)
  })

  test('a string system prompt that is only the billing header is dropped', () => {
    expect('system' in normalizeBody({ system: BILLING.text, messages: [] })).toBe(false)
    expect(normalizeBody({ system: 'plain', messages: [] }).system).toBe('plain')
  })

  test('a tool_addition definition replaces a tool of the same name', () => {
    const newer = { ...BASH, description: 'run v2' }
    const n = normalizeBody({ tools: [BASH], messages: [{ role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: newer } }] }] })
    expect(n.tools).toEqual([{ name: 'Bash', description: 'run v2', input_schema: { type: 'object' } }])
  })

  test('a system message with string content becomes user text', () => {
    const n = normalizeBody({ messages: [{ role: 'system', content: 'note' }] })
    expect(n.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'note' }] }])
  })

  test('consecutive assistant messages are merged', () => {
    const n = normalizeBody({ messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'a' }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }] })
    expect(n.messages).toEqual([{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }])
  })

  test('cache breakpoints: only the last one in the messages survives, at most 4 in all, inputs untouched', () => {
    const cc = { type: 'ephemeral' }
    const tr = (id: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: id, cache_control: cc }], cache_control: cc }] })
    const body = {
      system: [{ type: 'text', text: 's1', cache_control: cc }, { type: 'text', text: 's2', cache_control: cc }],
      tools: [{ ...BASH, cache_control: cc }, { ...LATE, cache_control: cc }],
      messages: [tr('a'), { role: 'assistant', content: 'x' }, tr('b'), { role: 'assistant', content: 'y' }, tr('c')],
    }
    const before = JSON.stringify(body)
    const n = normalizeBody(body)
    const count = (v: unknown) => (JSON.stringify(v).match(/cache_control/g) ?? []).length
    expect(count(n.messages)).toBe(1)
    expect(n.messages[4].content[0].cache_control).toEqual(cc)
    expect(count(n.messages[4].content[0].content)).toBe(0)
    expect(count(n.system) + count(n.tools) + count(n.messages)).toBe(4)
    // The later breakpoints win: the tools' first one goes.
    expect(count(n.system)).toBe(2)
    expect('cache_control' in n.tools[0]).toBe(false)
    expect(JSON.stringify(body)).toBe(before)
  })
})

// An engine stand-in that sends one given body per step through shadowFetch.
function threadEngine(bodies: any[]) {
  const network: any[] = []
  let i = 0
  const next = async function* (e: any): AsyncGenerator<any, any> {
    const headers: Record<string, string> = { 'x-claude-code-session-id': 's1' }
    if (e.agentId) headers['x-claude-code-agent-id'] = e.agentId
    const body = { ...bodies[i++], model: e.model }
    await shadowFetch({ url: 'https://api.anthropic.com/v1/messages', init: { method: 'POST', headers, compress: 'gzip', body: JSON.stringify(body) } }, (x: any) => {
      network.push(x)
      return { value: { status: 200, ok: true, headers: {}, text: '' } }
    })
    yield { kind: 'stop', stopReason: 'end_turn', usage: ZERO }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] }
  }
  return { network, next }
}

describe('routed steps across a thread', () => {
  const route = { provider: 'zai', model: 'glm-5.3' } as const
  const toolReply = JSON.stringify({ content: REPLY, stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 1 } })
  const textReply = JSON.stringify({ content: [{ type: 'text', text: 'SMOKE' }], stop_reason: 'end_turn', usage: { input_tokens: 6, output_tokens: 1 } })
  const e = (index: number, over: any = {}) => ({ turnId: 't1', index, model: 'zai:glm-5.3', messageCount: 10, ...over })

  test('the second step sends the whole conversation, the tools and the system prompt', async () => {
    resetShadow()
    const eng = threadEngine([createBody, continueBody])
    const p = provider([{ status: 200, text: toolReply }, { status: 200, text: textReply }])
    const io = { fetch: p.fetch, sleep: sleeper().sleep, signal: new AbortController().signal }
    const threads = new Map<string, ThreadState>()
    await drain(routedStep(e(0), eng.next, route, cfg({ zai: 'k-zai-1' }), io, threads))
    const second = await drain(routedStep(e(1), eng.next, route, cfg({ zai: 'k-zai-1' }), io, threads))
    expect(second.result.answer).toBe('SMOKE')
    expect(eng.network.length).toBe(0)
    const sent = JSON.parse(p.calls[1]!.init.body)
    expect(sent.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(sent.messages[1].content).toEqual(REPLY)
    expect(sent.messages[2].content[0].type).toBe('tool_result')
    expect(sent.tools.map((t: any) => t.name)).toEqual(['Bash', 'mcp__x__late'])
    expect(JSON.stringify(sent.system)).toContain('You are an agent.')
    expect(JSON.stringify(sent)).not.toContain('x-anthropic-billing-header')
    expect('thread' in sent).toBe(false)
  })

  test('threads are kept per loop: a subagent continue does not use main state', async () => {
    resetShadow()
    const eng = threadEngine([createBody, continueBody])
    const p = provider([{ status: 200, text: toolReply }])
    const io = { fetch: p.fetch, sleep: sleeper().sleep, signal: new AbortController().signal }
    const threads = new Map<string, ThreadState>()
    await drain(routedStep(e(0), eng.next, route, cfg({ zai: 'k-zai-1' }), io, threads))
    const sub = await drain(routedStep(e(0, { agentId: 'ag-1' }), eng.next, route, cfg({ zai: 'k-zai-1' }), io, threads))
    expect(sub.result.answer).toContain('[provider-router]')
    expect(sub.result.answer).toContain('/clear')
    expect(p.calls.length).toBe(1)
  })

  test('a provider error is recorded as the assistant turn the engine keeps', async () => {
    resetShadow()
    const eng = threadEngine([createBody, continueBody])
    const p = provider([{ status: 500, text: '{}' }, { status: 200, text: textReply }])
    const io = { fetch: p.fetch, sleep: sleeper().sleep, signal: new AbortController().signal }
    const threads = new Map<string, ThreadState>()
    const first = await drain(routedStep(e(0), eng.next, route, cfg({ zai: 'k-zai-1' }), io, threads))
    await drain(routedStep(e(1), eng.next, route, cfg({ zai: 'k-zai-1' }), io, threads))
    const sent = JSON.parse(p.calls[1]!.init.body)
    expect(sent.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: first.result.answer }] })
  })

  test('a cancelled step (Esc) records nothing: the next continue builds on the last recorded turn', async () => {
    resetShadow()
    const cancelledBody = {
      model: 'provider-router-shadow',
      thread: { type: 'continue', previous_message_id: 'msg_hook_1' },
      system: [BILLING],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'CANCELLED-INPUT' }] }],
    }
    const eng = threadEngine([createBody, cancelledBody, continueBody])
    const p = provider([{ status: 200, text: toolReply }, { status: 200, text: textReply }])
    const esc = new AbortController()
    const bodies: string[] = []
    // Step 1's provider call never answers; Esc is pressed while it runs.
    const fetch = async (url: string, init: any) => {
      bodies.push(init.body)
      if (bodies.length === 2) {
        esc.abort()
        return new Promise<never>(() => {})
      }
      return p.fetch(url, init)
    }
    const threads = new Map<string, ThreadState>()
    const live = new AbortController().signal
    await drain(routedStep(e(0), eng.next, route, cfg({ zai: 'k-zai-1' }), { fetch, sleep: sleeper().sleep, signal: live }, threads))
    const cancelled = await drain(routedStep(e(1), eng.next, route, cfg({ zai: 'k-zai-1' }), { fetch, sleep: sleeper().sleep, signal: esc.signal }, threads))
    expect(cancelled.chunks).toEqual([])
    expect(cancelled.result.answer).toBe('')
    const third = await drain(routedStep(e(2), eng.next, route, cfg({ zai: 'k-zai-1' }), { fetch, sleep: sleeper().sleep, signal: live }, threads))
    expect(third.result.answer).toBe('SMOKE')
    const sent = JSON.parse(bodies[2]!)
    expect(sent.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(sent.messages[1].content).toEqual(REPLY)
    expect(JSON.stringify(sent)).not.toContain('CANCELLED-INPUT')
    expect(eng.network.length).toBe(0)
  })

  test('a timed-out step is recorded like an error: its text is the assistant turn', async () => {
    resetShadow()
    const eng = threadEngine([createBody, continueBody])
    const p = provider([{ status: 200, text: textReply }])
    let n = 0
    const fetch = async (url: string, init: any) => (++n === 1 ? new Promise<never>(() => {}) : p.fetch(url, init))
    // A sleep that fires at once: the timer wins the first call.
    const fire = async () => {}
    const threads = new Map<string, ThreadState>()
    const signal = new AbortController().signal
    const first = await drain(routedStep(e(0), eng.next, route, cfg({ zai: 'k-zai-1' }), { fetch, sleep: fire, signal, timeoutMs: 5 }, threads))
    expect(first.result.answer).toContain('timed out')
    await drain(routedStep(e(1), eng.next, route, cfg({ zai: 'k-zai-1' }), { fetch, sleep: sleeper().sleep, signal }, threads))
    const sent = JSON.parse(p.calls[0]!.init.body)
    expect(sent.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: first.result.answer }] })
  })

  test('a fork continuing the main thread is rebuilt from its session history with the main system prompt and tools', async () => {
    resetShadow()
    const eng = threadEngine([createBody, continueBody])
    const p = provider([{ status: 200, text: toolReply }, { status: 200, text: textReply }])
    const threads = new Map<string, ThreadState>()
    const signal = new AbortController().signal
    await drain(routedStep(e(0), eng.next, route, cfg({ zai: 'k-zai-1' }), { fetch: p.fetch, sleep: sleeper().sleep, signal }, threads))
    // The engine's API-form history, with its first-party forms (normalized later).
    const history = [...createBody.messages, { role: 'assistant', content: REPLY }, ...continueBody.messages]
    const asked: string[] = []
    // An engine fork: an id $.agent.list() does not name.
    const io = { fetch: p.fetch, sleep: sleeper().sleep, signal, history: async () => (asked.push('h'), history), agents: async () => [{ id: 'ag-other', type: 'general-purpose' }] }
    const fork = await drain(routedStep(e(1, { agentId: 'fork-1' }), eng.next, route, cfg({ zai: 'k-zai-1' }), io, threads))
    expect(fork.result.answer).toBe('SMOKE')
    expect(asked.length).toBe(1)
    const sent = JSON.parse(p.calls[1]!.init.body)
    expect(sent.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(JSON.stringify(sent.system)).toContain('You are an agent.')
    expect(sent.tools.map((t: any) => t.name)).toEqual(['Bash', 'mcp__x__late'])
    expect(eng.network.length).toBe(0)
  })

  test('a fork whose history holds only its own prompt continues the main conversation', async () => {
    resetShadow()
    const eng = threadEngine([createBody, continueBody])
    const p = provider([{ status: 200, text: toolReply }, { status: 200, text: textReply }])
    const threads = new Map<string, ThreadState>()
    const signal = new AbortController().signal
    await drain(routedStep(e(0), eng.next, route, cfg({ zai: 'k-zai-1' }), { fetch: p.fetch, sleep: sleeper().sleep, signal }, threads))
    const io = { fetch: p.fetch, sleep: sleeper().sleep, signal, history: async () => [...continueBody.messages], agents: async () => [] }
    const fork = await drain(routedStep(e(1, { agentId: 'fork-1' }), eng.next, route, cfg({ zai: 'k-zai-1' }), io, threads))
    expect(fork.result.answer).toBe('SMOKE')
    const sent = JSON.parse(p.calls[1]!.init.body)
    expect(sent.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(sent.messages[1].content).toEqual(REPLY)
  })

  test('a listed fork (type fork) is rebuilt with its parent loop system prompt and tools', async () => {
    const subCreate = { ...createBody, system: [BILLING, { type: 'text', text: 'You are a sub.' }], tools: [LATE] }
    const history = [...createBody.messages, { role: 'assistant', content: REPLY }, ...continueBody.messages]
    const cases = [
      { listed: [{ id: 'fork-1', type: 'fork' }], system: 'You are an agent.', tools: ['Bash', 'mcp__x__late'] },
      { listed: [{ id: 'ag-1', type: 'general-purpose' }, { id: 'fork-1', type: 'fork', parentId: 'ag-1' }], system: 'You are a sub.', tools: ['mcp__x__late'] },
    ]
    for (const c of cases) {
      resetShadow()
      const eng = threadEngine([createBody, subCreate, continueBody])
      const p = provider([{ status: 200, text: toolReply }, { status: 200, text: toolReply }, { status: 200, text: textReply }])
      const threads = new Map<string, ThreadState>()
      const signal = new AbortController().signal
      const plain = { fetch: p.fetch, sleep: sleeper().sleep, signal }
      await drain(routedStep(e(0), eng.next, route, cfg({ zai: 'k-zai-1' }), plain, threads))
      await drain(routedStep(e(0, { agentId: 'ag-1' }), eng.next, route, cfg({ zai: 'k-zai-1' }), plain, threads))
      const io = { ...plain, history: async () => history, agents: async () => c.listed }
      const fork = await drain(routedStep(e(1, { agentId: 'fork-1' }), eng.next, route, cfg({ zai: 'k-zai-1' }), io, threads))
      expect(fork.result.answer).toBe('SMOKE')
      const sent = JSON.parse(p.calls[2]!.init.body)
      expect(JSON.stringify(sent.system)).toContain(c.system)
      expect(sent.tools.map((t: any) => t.name)).toEqual(c.tools)
      expect(eng.network.length).toBe(0)
    }
  })

  test('a real subagent the router never saw does not get the main system prompt or tools', async () => {
    const history = [...createBody.messages, { role: 'assistant', content: REPLY }, ...continueBody.messages]
    const listings: Array<(() => Promise<AgentRef[] | undefined>) | undefined> = [
      async () => [{ id: 'ag-1', type: 'general-purpose' }], // listed: a subagent, not a fork
      async () => undefined, // the list cannot be read
      async () => {
        throw new Error('refused')
      },
      undefined, // no list at all
    ]
    for (const agents of listings) {
      resetShadow()
      const eng = threadEngine([createBody, continueBody])
      const p = provider([{ status: 200, text: toolReply }, { status: 200, text: textReply }])
      const threads = new Map<string, ThreadState>()
      const signal = new AbortController().signal
      await drain(routedStep(e(0), eng.next, route, cfg({ zai: 'k-zai-1' }), { fetch: p.fetch, sleep: sleeper().sleep, signal }, threads))
      const io = { fetch: p.fetch, sleep: sleeper().sleep, signal, history: async () => history, agents }
      const sub = await drain(routedStep(e(1, { agentId: 'ag-1' }), eng.next, route, cfg({ zai: 'k-zai-1' }), io, threads))
      expect(sub.result.answer).toContain('[provider-router]')
      expect(sub.result.answer).toContain('/clear')
      expect(p.calls.length).toBe(1)
      expect(eng.network.length).toBe(0)
    }
  })

  test('a continue from an earlier turn (rewind) does not resend the dropped turns', async () => {
    resetShadow()
    const u = (t: string) => [{ role: 'user', content: [{ type: 'text', text: t }] }]
    const cont = (anchor: string, text: string) => ({ model: 'provider-router-shadow', thread: { type: 'continue', previous_message_id: anchor }, system: [BILLING], messages: u(text) })
    const reply = (t: string) => ({ status: 200, text: JSON.stringify({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 6, output_tokens: 1 } }) })
    const eng = threadEngine([createBody, cont('msg_hook_a', 'TWO'), cont('msg_hook_b', 'THREE'), cont('msg_hook_a', 'REDO-TWO')])
    const p = provider([reply('R1'), reply('R2'), reply('R3'), reply('R4')])
    const threads = new Map<string, ThreadState>()
    const io = { fetch: p.fetch, sleep: sleeper().sleep, signal: new AbortController().signal }
    for (let i = 0; i < 4; i++) await drain(routedStep(e(i), eng.next, route, cfg({ zai: 'k-zai-1' }), io, threads))
    const third = JSON.stringify(JSON.parse(p.calls[2]!.init.body).messages)
    expect(third).toContain('R2')
    const rewound = JSON.parse(p.calls[3]!.init.body)
    const text = JSON.stringify(rewound.messages)
    expect(text).toContain('R1')
    expect(text).toContain('REDO-TWO')
    expect(text).not.toContain('"TWO"')
    expect(text).not.toContain('R2')
    expect(text).not.toContain('THREE')
    expect(eng.network.length).toBe(0)
  })

  test('an early error with no captured request drops the conversation; the next continue is rebuilt from history', async () => {
    resetShadow()
    // Step 1's shadow is never captured (the engine sends nothing).
    let i = 0
    const inner = threadEngine([createBody, continueBody])
    const next = async function* (ev: any): AsyncGenerator<any, any> {
      if (i++ === 1) return { turnId: ev.turnId, index: ev.index, answer: '', toolUses: [] }
      return yield* inner.next(ev)
    }
    const p = provider([{ status: 200, text: toolReply }, { status: 200, text: textReply }])
    const threads = new Map<string, ThreadState>()
    const signal = new AbortController().signal
    await drain(routedStep(e(0), next, route, cfg({ zai: 'k-zai-1' }), { fetch: p.fetch, sleep: sleeper().sleep, signal }, threads))
    const failed = await drain(routedStep(e(1), next, route, cfg({ zai: 'k-zai-1' }), { fetch: p.fetch, sleep: sleeper().sleep, signal }, threads))
    expect(failed.result.answer).toContain('not captured')
    expect(threads.get('main')!.base).toBe(undefined)
    // Without history: the clear error, no provider call.
    const lost = await drain(routedStep(e(2), next, route, cfg({ zai: 'k-zai-1' }), { fetch: p.fetch, sleep: sleeper().sleep, signal }, threads))
    expect(lost.result.answer).toContain('/clear')
    expect(p.calls.length).toBe(1)
    // With history (what the engine holds, incl. the error turn): rebuilt.
    resetShadow()
    i = 1
    const history = [createBody.messages[0], { role: 'assistant', content: REPLY }, ...continueBody.messages, { role: 'assistant', content: [{ type: 'text', text: failed.result.answer }] }]
    const inner2 = threadEngine([continueBody])
    const next2 = async function* (ev: any): AsyncGenerator<any, any> {
      return yield* inner2.next(ev)
    }
    const ok = await drain(routedStep(e(3), next2, route, cfg({ zai: 'k-zai-1' }), { fetch: p.fetch, sleep: sleeper().sleep, signal, history: async () => history }, threads))
    expect(ok.result.answer).toBe('SMOKE')
    const sent = JSON.parse(p.calls[1]!.init.body)
    expect(sent.messages.length).toBe(5)
    expect(sent.messages[3].content[0].text).toContain('not captured')
  })
})
