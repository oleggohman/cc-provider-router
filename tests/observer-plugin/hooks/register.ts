// Test-only observer: one JSON line per `http.fetch` request this hook sees,
// then `next(e)` untouched. Loaded beneath provider-router (see README.md)
// it records what actually left the router: the router's own provider calls
// and every engine request the router passed on.
//
// The file is the plugin option `logFile`, else env FETCH_OBSERVER_LOG; with
// neither the hook only passes requests on. `$.fs` has no append, so the
// lines are kept in memory and the file is rewritten per request (what the
// file held before this module loaded is kept in front).
//
// Header values are never written, only header names: names that carry a
// credential are listed with `redacted: true`.

import type { Register } from 'claude-code'

const SECRET_NAME = /authorization|api-key|apikey|cookie|token|secret|credential|signature/i

type Sink = { path?: string; resolved: boolean; prefix: string; lines: string[]; chain: Promise<unknown> }

function describe(e: any, origin: unknown, seq: number): string {
  const init = e?.init ?? {}
  const headers: Record<string, unknown> = init.headers && typeof init.headers === 'object' ? init.headers : {}
  let model: unknown
  let keys: string[] | undefined
  if (typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body)
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        model = body.model
        keys = Object.keys(body).sort()
      }
    } catch {
      // not JSON: no model, no keys
    }
  }
  return JSON.stringify({
    t: Date.now(),
    seq,
    url: String(e?.url),
    method: init.method ?? 'GET',
    model,
    bodyKeys: keys,
    bodyType: init.body === undefined ? 'none' : typeof init.body,
    origin,
    headers: Object.keys(headers)
      .sort()
      .map(name => (SECRET_NAME.test(name) || headers[name] === '[redacted]' ? { name: name.toLowerCase(), redacted: true } : { name: name.toLowerCase() })),
    agent: Object.keys(headers).some(k => k.toLowerCase() === 'x-claude-code-agent-id') ? 'subagent' : 'main',
  })
}

async function record($: any, sink: Sink, option: unknown, line: string): Promise<void> {
  sink.lines.push(line)
  if (!sink.resolved) {
    sink.resolved = true
    sink.path = (typeof option === 'string' && option) || (await $.env.get('FETCH_OBSERVER_LOG')) || undefined
    if (sink.path) {
      try {
        sink.prefix = await $.fs.read(sink.path)
      } catch {
        sink.prefix = ''
      }
    }
  }
  const path = sink.path
  if (!path) return
  sink.chain = sink.chain.then(() => $.fs.write(path, sink.prefix + sink.lines.join('\n') + '\n')).catch(() => undefined)
  await sink.chain
}

export const register: Register = (on, options) => {
  const sink: Sink = { resolved: false, prefix: '', lines: [], chain: Promise.resolve() }
  let seq = 0
  on('http.fetch', async ($, e, next) => {
    try {
      await record($, sink, (options as any)?.logFile, describe(e, next.origin, ++seq))
    } catch {
      // the observer never stands in a request's way
    }
    return next(e)
  })
}
