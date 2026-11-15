import { describe, expect, test } from 'claude-code/testing'
import * as fx from '../tests/fixtures/transcripts.ts'
import { buildRequest } from './request.ts'
import { resolveThread, type ThreadState } from './thread.ts'

const FIRST_PARTY = ['metadata', 'context_management', 'safeguards', 'thread', 'diagnostics', 'stream', 'thinking', 'output_config']

describe('buildRequest', () => {
  test('keeps system (identity rewritten), tools, messages; drops first-party fields; sets the model and max_tokens', () => {
    const request = buildRequest(fx.textOnly, 'claude-sonnet-4-5', 64000)
    expect(request.model).toBe('claude-sonnet-4-5')
    expect(request.max_tokens).toBe(64000)
    expect(request.system).toEqual([{ type: 'text', text: 'You are a Coding agent', cache_control: { type: 'ephemeral' } }])
    expect(request.tools).toEqual(fx.textOnly.tools)
    expect(request.messages).toEqual(fx.textOnly.messages)
    for (const k of FIRST_PARTY) expect(k in request).toBe(false)
  })

  test('tool round trip, images, documents and thinking pass as is', () => {
    for (const f of [fx.toolRoundTrip, fx.images, fx.documents, fx.thinkingBlocks]) {
      expect(buildRequest(f, 'glm-5.3', 32768).messages).toEqual(f.messages)
    }
  })

  test("a subagent's own tool set and system prompt are used", () => {
    const request = buildRequest(fx.subagent, 'gpt-5', 128000)
    expect(request.tools!.map((t: any) => t.name)).toEqual(['Read', 'SubagentHandback'])
    expect(request.system).toEqual(fx.subagent.system)
  })

  test('a body without tools gives no tools field', () => {
    const { tools: _, ...noTools } = fx.textOnly
    expect('tools' in buildRequest(noTools, 'gpt-5', 1)).toBe(false)
  })

  test('a missing or malformed body gives a minimal request, never a throw', () => {
    for (const body of [undefined, null, 'not json', { messages: 'x', tools: 'y' }, { tools: [] }]) {
      const request = buildRequest(body, 'm', 8192)
      expect(request.model).toBe('m')
      expect(request.messages).toEqual([])
      expect('tools' in request).toBe(false)
      expect(request.max_tokens).toBe(8192)
    }
  })

  test('a malformed system passes through unchanged, never a throw', () => {
    for (const system of [42, [null], [{ type: 'text', text: 42 }], { type: 'text', text: 'You are Claude Code.' }]) {
      expect(buildRequest({ ...fx.textOnly, system }, 'm', 8192).system).toEqual(system)
    }
  })
})

describe('deferred tools / tool search', () => {
  // Every provider: none knows deferred tools or tool_reference blocks without
  // a first-party beta, so loaded ones are sent, the rest dropped, references
  // become text.
  test('flattened for every provider: loaded ones kept, others dropped, references as text', () => {
    const request = buildRequest(fx.deferredTools, 'any-model', 8192)
    const names = request.tools!.map((t: any) => t.name)
    expect(names).toEqual(['Bash', 'Read', 'ToolSearch', 'WebFetch'])
    for (const t of request.tools!) expect('defer_loading' in t).toBe(false)
    const s = JSON.stringify(request.messages)
    expect(s).not.toContain('tool_reference')
    expect(s).toContain('Tool loaded: WebFetch')
    // The fixture itself is not modified.
    expect(JSON.stringify(fx.deferredTools)).toContain('tool_reference')
  })
})

describe('system prompt identity rewrite', () => {
  // The engine's system prompt opens with a Claude identity sentence; a
  // routed model is not Claude, so the sentence becomes a neutral one for
  // every provider. The billing header may sit before it.
  const billing = { type: 'text', text: 'x-anthropic-billing-header: cc_version=0.0.0; cch=abc' }

  test('a Claude identity sentence (CLI wording) is rewritten, the rest of the prompt and cache_control kept', () => {
    const body = {
      ...fx.textOnly,
      system: [
        billing,
        { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.\n\nUse the tools.", cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Later blocks are untouched.' },
      ],
    }
    const request = buildRequest(body, 'glm-5.3', 8192)
    expect(request.system).toEqual([
      billing,
      { type: 'text', text: 'You are a Coding agent\n\nUse the tools.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Later blocks are untouched.' },
    ])
  })

  test("the Agent SDK wording (built on Anthropic's Claude Agent SDK) is rewritten, in blocks and in a string system", () => {
    const sdk = "You are a Claude agent, built on Anthropic's Claude Agent SDK.\n\nDo the task."
    expect(buildRequest({ ...fx.textOnly, system: [{ type: 'text', text: sdk }] }, 'gpt-5', 8192).system)
      .toEqual([{ type: 'text', text: 'You are a Coding agent\n\nDo the task.' }])
    expect(buildRequest({ ...fx.textOnly, system: sdk }, 'gpt-5', 8192).system).toBe('You are a Coding agent\n\nDo the task.')
  })

  test('every known engine opener is rewritten: with its period, or bare at the end of the line', () => {
    const openers = [
      'You are Claude Code',
      "You are Claude Code, Anthropic's official CLI for Claude",
      "You are a Claude agent, built on Anthropic's Claude Agent SDK",
      "You are a Claude agent, built on Anthropic's Claude Agent",
    ]
    const sys = (system: string) => buildRequest({ ...fx.textOnly, system }, 'gpt-5', 8192).system
    for (const opener of openers) {
      expect(sys(`${opener}. Rest.`)).toBe('You are a Coding agent Rest.')
      expect(sys(`${opener}\nRest.`)).toBe('You are a Coding agent\nRest.')
      expect(sys(opener)).toBe('You are a Coding agent')
    }
  })

  test('a system prompt that does not open with a Claude identity stays as is', () => {
    expect(buildRequest(fx.subagent, 'gpt-5', 8192).system).toEqual(fx.subagent.system)
    expect(buildRequest({ ...fx.textOnly, system: 'You are an agent.' }, 'gpt-5', 8192).system).toBe('You are an agent.')
  })

  test("a user-authored prompt that merely opens with 'You are (a) Claude...' is not an identity claim and stays as is", () => {
    const prompts = [
      'You are a Claude Code specialist for payments. Review the diff.',
      'You are Claude Code Reviewer, a strict reviewer.',
      'You are an agent for Claude Code users.',
      'Reminder: You are Claude Code.',
    ]
    for (const system of prompts) {
      expect(buildRequest({ ...fx.textOnly, system }, 'gpt-5', 8192).system).toBe(system)
      expect(buildRequest({ ...fx.textOnly, system: [{ type: 'text', text: system }] }, 'gpt-5', 8192).system).toEqual([{ type: 'text', text: system }])
    }
  })

  test('the loop state keeps the original identity, so a continue is rewritten again on every send', () => {
    // routedStep stores resolveThread's body (pre-rewrite) and rewrites in
    // buildRequest per send: the stored system must stay the engine's own.
    const identity = { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: 'ephemeral' } }
    const state: ThreadState = {
      system: [billing, identity],
      tools: fx.textOnly.tools,
      base: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }],
    }
    const cont = {
      model: 'provider-router-shadow',
      thread: { type: 'continue', previous_message_id: 'msg_hook_1' },
      system: [billing],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    }
    const r = resolveThread(cont, state, {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body.system).toEqual([billing, identity])
    const request = buildRequest(r.body, 'gpt-5', 8192)
    expect(request.system).toEqual([billing, { ...identity, text: 'You are a Coding agent' }])
    // The state and the resolved body are not mutated by the rewrite.
    expect(state.system).toEqual([billing, identity])
    expect(r.body.system).toEqual([billing, identity])
  })
})
