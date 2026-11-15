// Provider transport through a `curl` child process. The host ends any
// `$.http.fetch` after 30 s (docs/design-notes.md, "Answer in place: spike");
// a `curl` child started with `$.process.spawn` from the `http.fetch` hook
// holds a call as long as the timer allows (probe: scripts/probes/curl-transport.sh).
// `curlFetch` has the adapters' `Fetch` signature, so the adapters do not change.
//
// Secrets: the argv is always exactly `curl --disable --config -`. The URL,
// headers (the key among them) and body go in a curl config written to the
// child's stdin, never in argv, a file or the child's environment. `--disable`
// comes first so no `.curlrc` is read (no trace file, no proxy, no extra
// options from the user's config). Every config value goes through one
// encoder, and anything that could break out of a config line (CR, LF, NUL in
// the URL or a header, a header name outside the token grammar) is refused
// before curl starts. Error text is redacted (configured keys and every
// request header value).
//
// The child's lifetime is owned here: the loop over the spawn stream is the
// child's life (leaving it, `return()` or the dispatch's signal kills it), so
// a timeout, Esc, abandonment (the signal) or an output overflow ends the loop
// with `return()`; curl's own `max-time` is the backstop.

import type { Fetch, FetchInit, FetchResponse, Sleep } from './call.ts'
import { KEY_SOURCES } from './config.ts'
import { sanitize } from './errors.ts'

export type SpawnRequest = { argv: readonly string[]; input?: string; env?: Record<string, string> }
export type SpawnChunk = { stream: 'stdout' | 'stderr'; text: string }
export type SpawnEnd = { code: number | null; signal: string | null }
// `$.process.spawn`: pieces, then how the child ended; the first pull rejects
// when the child cannot start.
export type Spawn = (request: SpawnRequest) => AsyncIterable<SpawnChunk>

export type TransportKind = 'curl' | 'fetch'

export const CURL_ARGV = ['curl', '--disable', '--config', '-'] as const

// What each of stdout and stderr may hold, in UTF-8 bytes (as `$.process.run`).
export const OUTPUT_LIMIT = 4 * 1024 * 1024

// curl reads config lines of up to 10 MiB; a line is refused below that, so
// an escaped body stays clear of it.
export const CONFIG_LINE_LIMIT = 10_000_000

// Appended by `write-out` after the body: the separator, then the status.
export const STATUS_MARK = '\n@@provider-router-status@@'

// Variables blanked in the child's environment: the router's key sources (the
// child never needs them; the provider keys from the key table, so a new
// provider's is blanked too) and the TLS key log (session secrets to a file).
export const BLANKED_ENV: readonly string[] = [...Object.values(KEY_SOURCES).map(s => s.env), 'ROUTER_CUSTOM_API_KEYS', 'SSLKEYLOGFILE']

// RFC 9110 token.
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

// The child could not be started: nothing was sent.
export class CurlStartError extends Error {}

// The `$.http.fetch` fallback hit the host's 30 s limit.
export class HostLimitError extends Error {}

const HOST_LIMIT = 'no complete answer within 30000ms'
const HOST_LIMIT_SENTENCE =
  'the reply took longer than 30 s, the limit without curl (Claude Code ends a plugin fetch after 30 s; with curl available a reply may take up to 570 s)'

// The sentence for a `$.http.fetch` failure at the host's 30 s limit.
export function hostLimitText(error: unknown): string | undefined {
  return String(error).includes(HOST_LIMIT) ? HOST_LIMIT_SENTENCE : undefined
}

// One quoted curl config value. curl unquotes `\t \n \r \v` and takes any
// other `\x` as x, so with `"` and `\` escaped and line breaks written as
// escapes the value cannot end its line or its quotes.
export function encodeValue(value: string): string {
  return `"${value.replace(/[\\"\n\r\t\v]/g, c => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v' })[c]!)}"`
}

function utf8Length(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

function checkUrl(url: string): void {
  if (!url || /[\u0000-\u0020\u007f]/.test(url)) throw new Error('curl transport: the URL is empty or holds a space or control character')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('curl transport: the URL does not parse')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('curl transport: the URL must be http or https')
}

// The config for one request, written to curl's stdin. Throws (before curl
// starts) on anything that cannot be written safely.
export function buildConfig(url: string, init: FetchInit, timeoutMs: number): string {
  checkUrl(url)
  const method = init.method || 'POST'
  if (!TOKEN_RE.test(method)) throw new Error('curl transport: invalid method')
  const lines = [`url = ${encodeValue(url)}`]
  if (method !== 'POST') lines.push(`request = ${encodeValue(method)}`)
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    if (!TOKEN_RE.test(name)) throw new Error('curl transport: invalid header name')
    if (/[\r\n\0]/.test(String(value))) throw new Error(`curl transport: the header value of ${name} holds CR, LF or NUL`)
    lines.push(`header = ${encodeValue(`${name}: ${value}`)}`)
  }
  const body = init.body ?? ''
  if (body.includes('\0')) throw new Error('curl transport: the request body holds NUL')
  // `data-binary` reads a file for a value starting with `@`; a JSON body never does.
  if (body.startsWith('@')) throw new Error('curl transport: the request body starts with @')
  const data = `data-binary = ${encodeValue(body)}`
  if (utf8Length(data) >= CONFIG_LINE_LIMIT) throw new Error('curl transport: request too large for curl (over 10 MB once escaped)')
  lines.push(data)
  lines.push('silent', 'show-error', 'globoff', `proto = ${encodeValue('=https,http')}`, `max-redirs = ${encodeValue('0')}`)
  lines.push(`max-time = ${encodeValue(String(Math.max(1, Math.ceil(timeoutMs / 1000))))}`)
  lines.push(`write-out = ${encodeValue(`${STATUS_MARK}%{http_code}`)}`)
  return `${lines.join('\n')}\n`
}

// `signal`: the dispatch's (Esc, abandonment); `timeoutMs` with `sleep`: the
// call's own timer (and curl's max-time); `env`: extra child variables (HOME,
// CURL_HOME), never a key; `secrets`: redacted from error text.
export type CurlOptions = {
  signal: AbortSignal
  timeoutMs: number
  sleep?: Sleep
  env?: Record<string, string>
  secrets?: readonly string[]
}

function parseReply(stdout: string): FetchResponse {
  const at = stdout.lastIndexOf(STATUS_MARK)
  if (at < 0) throw new Error('curl transport: unreadable reply (no status)')
  const code = stdout.slice(at + STATUS_MARK.length).trim()
  if (!/^[1-5]\d\d$/.test(code)) throw new Error('curl transport: unreadable reply (bad status)')
  const status = Number(code)
  return { status, ok: status >= 200 && status < 300, text: stdout.slice(0, at) }
}

export function curlFetch(spawn: Spawn, o: CurlOptions): Fetch {
  return async (url, init) => {
    if (o.signal.aborted) throw new Error('curl transport: aborted')
    // Each header value whole and by its words (`Bearer <key>`).
    const headerValues = Object.values(init.headers ?? {}).flatMap(v => [String(v), ...String(v).split(/\s+/)])
    const hidden = [...(o.secrets ?? []), ...headerValues].filter(s => s.length >= 8)
    const env: Record<string, string> = { ...(o.env ?? {}) }
    for (const name of BLANKED_ENV) env[name] = ''
    for (const v of Object.values(env)) {
      if (hidden.some(s => s.length >= 8 && v.includes(s))) throw new Error('curl transport: refused to put a secret in the child environment')
    }
    const config = buildConfig(url, init, o.timeoutMs)
    let stop: (why: 'timeout' | 'aborted') => void = () => undefined
    const stopped = new Promise<{ stop: 'timeout' | 'aborted' }>(resolve => {
      stop = why => resolve({ stop: why })
    })
    const onAbort = () => stop('aborted')
    const timer = new AbortController()
    let iterator: AsyncIterator<SpawnChunk, SpawnEnd> | undefined
    let ended = false
    const end = (): void => {
      if (ended || !iterator) return
      ended = true
      const it = iterator
      Promise.resolve()
        .then(() => it.return?.())
        .catch(() => undefined)
    }
    const out: string[] = []
    const err: string[] = []
    let outBytes = 0
    let errBytes = 0
    let read = false
    let finished = false
    try {
      o.signal.addEventListener('abort', onAbort, { once: true })
      try {
        o.sleep?.(o.timeoutMs, { signal: timer.signal }).then(
          () => stop('timeout'),
          () => undefined,
        )
      } catch {
        // No timer: curl's own max-time still ends the call.
      }
      try {
        iterator = spawn({ argv: CURL_ARGV, input: config, env })[Symbol.asyncIterator]() as AsyncIterator<SpawnChunk, SpawnEnd>
      } catch (cause) {
        finished = true
        throw new CurlStartError(`curl transport: cannot start curl: ${sanitize(String(cause), hidden)}`)
      }
      let exit: SpawnEnd | undefined
      for (;;) {
        const pull = iterator.next().then(
          v => ({ v }),
          (e: unknown) => ({ e }),
        )
        const r = await Promise.race([pull, stopped])
        if ('stop' in r) {
          end()
          throw new Error(r.stop === 'timeout' ? `curl transport: no reply within ${o.timeoutMs} ms (timed out)` : 'curl transport: aborted')
        }
        if ('e' in r) {
          finished = true
          if (o.signal.aborted) throw new Error('curl transport: aborted')
          const text = sanitize(String(r.e), hidden)
          // The host rejects the first pull when the child cannot start;
          // once a piece arrived the child ran and may have sent the request.
          if (!read) throw new CurlStartError(`curl transport: cannot start curl: ${text}`)
          throw new Error(`curl transport: ${text}`)
        }
        if (r.v.done) {
          finished = true
          exit = r.v.value
          break
        }
        read = true
        const chunk = r.v.value
        if (chunk.stream === 'stderr') {
          errBytes += utf8Length(chunk.text)
          if (errBytes > OUTPUT_LIMIT) throw new Error('curl transport: reply too large (curl wrote over 4 MiB to stderr)')
          err.push(chunk.text)
        } else {
          outBytes += utf8Length(chunk.text)
          if (outBytes > OUTPUT_LIMIT) throw new Error('curl transport: reply too large (over 4 MiB)')
          out.push(chunk.text)
        }
      }
      if (!exit || exit.code === null) throw new Error(`curl transport: curl ended by ${exit?.signal ?? 'an unknown cause'}`)
      if (exit.code !== 0) {
        const detail = sanitize(err.join('').trim(), hidden)
        throw new Error(`curl failed (exit ${exit.code})${detail ? `: ${detail}` : ''}`)
      }
      return parseReply(out.join(''))
    } finally {
      o.signal.removeEventListener('abort', onAbort)
      timer.abort()
      if (!finished) end()
    }
  }
}

// Whether `curl --version` runs: `curl`, `fetch` when it cannot start or
// answers otherwise, `unknown` when the signal cut the check.
export async function checkCurl(spawn: Spawn, signal?: AbortSignal): Promise<TransportKind | 'unknown'> {
  if (signal?.aborted) return 'unknown'
  let iterator: AsyncIterator<SpawnChunk, SpawnEnd> | undefined
  try {
    iterator = spawn({ argv: ['curl', '--disable', '--version'], env: { SSLKEYLOGFILE: '' } })[Symbol.asyncIterator]() as AsyncIterator<SpawnChunk, SpawnEnd>
    let stdout = ''
    for (;;) {
      const r = await iterator.next()
      if (r.done) return r.value?.code === 0 && stdout.startsWith('curl ') ? 'curl' : 'fetch'
      if (r.value.stream === 'stdout') stdout += r.value.text
      if (stdout.length > 65_536) {
        await iterator.return?.()
        return 'fetch'
      }
    }
  } catch {
    return signal?.aborted ? 'unknown' : 'fetch'
  }
}

// Per module load: the transport once known, and a check in flight.
export type TransportCache = { kind?: TransportKind; pending?: Promise<TransportKind | 'unknown'> }

// The transport to use: checked once per cache; a check the signal cut is not
// kept (this call uses `$.http.fetch`, the next one checks again).
export async function selectTransport(cache: TransportCache, check: () => Promise<TransportKind | 'unknown'>): Promise<TransportKind> {
  if (cache.kind) return cache.kind
  cache.pending ??= check().catch(() => 'fetch' as const)
  const result = await cache.pending
  cache.pending = undefined
  if (result === 'unknown') return 'fetch'
  cache.kind ??= result
  return cache.kind
}

export function transportLine(kind: TransportKind): string {
  return kind === 'curl' ? 'transport: curl' : 'transport: fetch (30 s limit)'
}

// The curl transport, falling back to `$.http.fetch` only when curl could not
// be started (nothing was sent); later calls of the module load then use
// `$.http.fetch` at once. Any other curl failure is the call's error: the
// request may have been sent, so it is never retried.
export function fallbackFetch(curl: Fetch, httpFetch: Fetch, cache: TransportCache): Fetch {
  return async (url, init) => {
    try {
      return await curl(url, init)
    } catch (err) {
      if (!(err instanceof CurlStartError)) throw err
      cache.kind = 'fetch'
    }
    try {
      return await httpFetch(url, init)
    } catch (err) {
      const limit = hostLimitText(err)
      throw limit ? new HostLimitError(limit) : err
    }
  }
}
