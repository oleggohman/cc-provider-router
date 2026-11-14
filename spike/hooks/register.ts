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
const SHADOW = 'provider-router-shadow'

// Captures the engine's request for one shadow step under `model`.
async function shadow(next: any, e: any, model: string): Promise<any> {
  let req: any = null
  capture = b => {
    req = b
  }
  let chunks = 0
  let err: string | null = null
  try {
    for await (const _ of next({ ...e, model })) chunks++
  } catch (x) {
    err = String(x)
  }
  capture = null
  return { req, chunks, err }
}


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
      // Fail closed: a shadow-model request that matches no capture never
      // reaches the network.
      if (parsed.model === SHADOW) {
        await $.fs.write(LOG, rec('shadow-refused', { model: parsed.model }))
        return { value: { status: 400, ok: false, headers: { 'content-type': 'application/json' }, text: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'provider-router: shadow request refused' } }) } }
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
      // Real first, then shadow: MCP connectors may still be connecting on the
      // first step, so the later capture sees the fuller tool list.
      const real = await shadow(next, e, 'claude-haiku-4-5')
      const sh = await shadow(next, e, SHADOW)
      const req = real.req
      const a = sh.req, b = real.req
      const sysOf = (r: any) => (Array.isArray(r?.system) ? r.system.map((x: any) => x.text).join('\n') : String(r?.system ?? ''))
      const sa = sysOf(a), sb = sysOf(b)
      let firstDiff = -1
      for (let i = 0; i < Math.max(sa.length, sb.length); i++) if (sa[i] !== sb[i]) { firstDiff = i; break }
      await $.fs.write(LOG, rec('shadow-compare', {
        agentId: e.agentId ?? null,
        shadowCaptured: !!a, shadowChunks: sh.chunks, shadowErr: sh.err,
        realCaptured: !!b, realErr: real.err,
        shadowKeys: a ? Object.keys(a) : null, realKeys: b ? Object.keys(b) : null,
        toolsEqual: JSON.stringify(a?.tools) === JSON.stringify(b?.tools),
        toolNamesShadow: a?.tools?.map((t: any) => t.name) ?? null,
        toolNamesReal: b?.tools?.map((t: any) => t.name) ?? null,
        systemEqual: sa === sb, systemCharsShadow: sa.length, systemCharsReal: sb.length,
        systemDiff: firstDiff < 0 ? null : { at: firstDiff, shadow: sa.slice(Math.max(0, firstDiff - 60), firstDiff + 120), real: sb.slice(Math.max(0, firstDiff - 60), firstDiff + 120) },
        messagesEqual: JSON.stringify(a?.messages) === JSON.stringify(b?.messages),
        maxTokens: [a?.max_tokens, b?.max_tokens], thinking: [a?.thinking ?? null, b?.thinking ?? null],
        contextMgmt: [a?.context_management ?? null, b?.context_management ?? null],
        model: [a?.model, b?.model],
        namesEqual: JSON.stringify(a?.tools?.map((t: any) => t.name)) === JSON.stringify(b?.tools?.map((t: any) => t.name)),
        toolDiffs: (a?.tools ?? []).map((t: any, i: number) => {
          const u = b?.tools?.[i]
          if (JSON.stringify(t) === JSON.stringify(u)) return null
          const ks = [...new Set([...Object.keys(t), ...Object.keys(u ?? {})])].filter(k => JSON.stringify(t[k]) !== JSON.stringify(u?.[k]))
          return { name: t.name, keys: ks, shadow: ks.map(k => JSON.stringify(t[k])?.slice(0, 200)), real: ks.map(k => JSON.stringify(u?.[k])?.slice(0, 200)) }
        }).filter(Boolean),
        msgText: (() => { const x = JSON.stringify(a?.messages) ?? '', y = JSON.stringify(b?.messages) ?? ''; let i = 0; while (i < x.length && x[i] === y[i]) i++; return { at: i, shadow: x.slice(i - 80, i + 400), real: y.slice(i - 80, i + 900) } })(),
        outputConfig: a?.output_config ?? null,
        msgDiff: JSON.stringify(a?.messages).length - JSON.stringify(b?.messages).length,
      }))
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
