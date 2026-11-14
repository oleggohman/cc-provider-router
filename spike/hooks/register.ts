import type { Register } from 'claude-code'

// Verification spike for the provider router (Task 1). Each "spike-*" model id
// exercises one plugin API fact; findings are written as JSON lines to LOG.
const LOG = '/private/tmp/claude/provider-spike/log.jsonl'
const lines: string[] = []

const usage = (model: string, input = 0) =>
  ({
    input_tokens: input,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    model,
  }) as any

// Minimal Anthropic SSE body the engine accepts as a whole response.
const sse = (text: string) =>
  [
    ['message_start', { type: 'message_start', message: { id: 'msg_spike', type: 'message', role: 'assistant', model: 'spike', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
    .map(([ev, d]) => `event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`)
    .join('')

// Set by a turn.step hook just before it calls next(): the engine's own request
// for that step is captured by the http.fetch hook and answered locally.
// Appends one finding and returns the whole log text.
function rec(what: string, data: unknown): string {
  lines.push(JSON.stringify({ what, data }))
  return lines.join('\n') + '\n'
}

let capture: ((body: any) => void) | null = null

export const register: Register = (on, options) => {

  on('http.fetch', async ($, e, next) => {
    const body = e.init?.body
    if (e.url.includes('/v1/messages') && typeof body === 'string') {
      const parsed = JSON.parse(body)
      await $.fs.write(LOG, rec('engine-request', {
        url: e.url,
        model: parsed.model,
        captured: !!capture,
        compress: e.init?.compress ?? null,
        headerNames: Object.keys(e.init?.headers ?? {}),
      }))
      if (capture) {
        const cb = capture
        capture = null
        cb(parsed)
        return { value: { status: 200, ok: true, headers: { 'content-type': 'text/event-stream' }, text: sse('captured') } }
      }
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.model.startsWith('spike')) return yield* next(e)
    const msgs: any = await $.session.messages({ as: 'api', agentId: e.agentId } as any)
    const tools = await $.tool.list()
    await $.fs.write(LOG, rec('step', {
      model: e.model,
      agentId: e.agentId ?? null,
      index: e.index,
      messageCount: e.messageCount,
      apiMessages: Array.isArray(msgs) ? msgs.length : msgs,
      toolList: tools.length,
      toolListWithSchema: tools.filter(t => t.inputSchema).length,
      options,
    }))

    if (e.model === 'spike-echo' || e.model === 'spike-compact') {
      // Option (c) per step: let the engine build this step's request under a
      // real model id, read it in http.fetch and answer it without the network.
      let req: any = null
      capture = b => {
        req = b
      }
      const s = next({ ...e, model: 'claude-haiku-4-5' })
      for await (const _ of s) void _
      const sys = Array.isArray(req?.system) ? req.system.map((b: any) => b.text).join('\n') : String(req?.system ?? '')
      await $.fs.write(LOG, rec('captured-request', {
        agentId: e.agentId ?? null,
        keys: req ? Object.keys(req) : null,
        toolNames: req?.tools?.map((t: any) => t.name) ?? null,
        toolsWithSchema: req?.tools?.filter((t: any) => t.input_schema).length ?? 0,
        bashSchemaKeys: Object.keys(req?.tools?.find((t: any) => t.name === 'Bash')?.input_schema?.properties ?? {}),
        systemChars: sys.length,
        systemHasAgentMarker: sys.includes('SPIKE-AGENT-SYSTEM-MARKER'),
        messages: req?.messages?.length ?? null,
        reminderInRequest: JSON.stringify(req?.messages ?? []).includes('system-reminder'),
        reminderInApiMessages: JSON.stringify(msgs).includes('system-reminder'),
      }))
      const answer = `SPIKE-OK model=${e.model} agent=${e.agentId ?? 'main'} tools=${req?.tools?.length ?? 'none'}`
      yield { kind: 'text', index: 0, text: answer }
      yield { kind: 'stop', stopReason: 'end_turn', usage: usage(e.model, 150000) }
      return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: usage(e.model, 150000) }
    }

    if (e.model === 'spike-tool') {
      const last = Array.isArray(msgs) ? msgs[msgs.length - 1] : null
      const result = Array.isArray(last?.content) ? last.content.find((b: any) => b.type === 'tool_result') : null
      if (!result) {
        const id = 'toolu_spike_1'
        yield { kind: 'tool', index: 0, id, name: 'Bash' }
        yield { kind: 'input', index: 0, json: '{"command":"echo SPIKE-TOOL-RAN",' }
        yield { kind: 'input', index: 0, json: '"description":"spike"}' }
        yield { kind: 'stop', stopReason: 'tool_use', usage: usage(e.model) }
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ id, name: 'Bash', input: { command: 'echo SPIKE-TOOL-RAN', description: 'spike' } }] } as any
      }
      await $.fs.write(LOG, rec('tool-result', result))
      const answer = `SPIKE-TOOL-RESULT ${JSON.stringify(result.content)}`
      yield { kind: 'text', index: 0, text: answer }
      yield { kind: 'stop', stopReason: 'end_turn', usage: usage(e.model) }
      return { turnId: e.turnId, index: e.index, answer, toolUses: [] }
    }

    if (e.model === 'spike-fetch') {
      const r = await $.http.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-invalid', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
      })
      // Race a slow promise against the clock to check the timeout mechanics.
      const ctl = new AbortController()
      const t0 = Date.now()
      const won = await Promise.race([
        $.clock.sleep(5000).then(() => 'slow'),
        $.clock.sleep(200, { signal: ctl.signal }).then(() => 'timeout'),
      ])
      const sig: AbortSignal | undefined = (next as any).signal
      await $.fs.write(LOG, rec('fetch', { status: r.status, ok: r.ok, body: r.text.slice(0, 300), contentType: r.headers['content-type'], race: won, ms: Date.now() - t0, nextHasSignal: !!sig }))
      const answer = `SPIKE-FETCH status=${r.status} race=${won}`
      yield { kind: 'text', index: 0, text: answer }
      yield { kind: 'stop', stopReason: 'end_turn', usage: usage(e.model) }
      return { turnId: e.turnId, index: e.index, answer, toolUses: [] }
    }

    // spike-refusal and any other: an error-style reply ending with refusal.
    await $.fs.write(LOG, rec('other-model', { model: e.model }))
    const answer = `[provider-router] spike error 500: test`
    yield { kind: 'text', index: 0, text: answer }
    yield { kind: 'stop', stopReason: 'refusal', usage: usage(e.model) }
    return { turnId: e.turnId, index: e.index, answer, toolUses: [] }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const u = await $.session.usage()
    await $.fs.write(LOG, rec('turn-complete', { agentId: (e as any).agentId ?? null, context: u.context }))
    const cfg = (await $.config.list()).filter(row => row.key.startsWith('provider-spike'))
    await $.fs.write(LOG, rec('config-rows', cfg.map(c => ({ key: c.key, kind: c.kind }))))
    if ((e as any).model === 'spike-compact' || lines.some(l => l.includes('"model":"spike-compact"'))) {
      if (!(e as any).agentId) {
        // compact rejects while a turn runs; schedule it just after this one.
        $.clock.after(10, async () => {
          try {
            const res = await $.session.compact()
            await $.fs.write(LOG, rec('compact', res))
          } catch (err) {
            await $.fs.write(LOG, rec('compact-error', String(err)))
          }
        })
      }
    }
    return r
  })
}
