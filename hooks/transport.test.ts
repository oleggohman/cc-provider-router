import { describe, expect, test } from 'claude-code/testing'
import { KEY_SOURCES } from './config.ts'
import {
  BLANKED_ENV,
  CURL_ARGV,
  CONFIG_LINE_LIMIT,
  CurlStartError,
  OUTPUT_LIMIT,
  STATUS_MARK,
  buildConfig,
  checkCurl,
  curlFetch,
  encodeValue,
  fallbackFetch,
  hostLimitText,
  selectTransport,
  transportLine,
  type Spawn,
  type SpawnChunk,
  type SpawnEnd,
  type SpawnRequest,
  type TransportCache,
} from './transport.ts'
import { tick } from '../tests/harness.ts'

const FAKE_KEY = 'FAKEKEYtransport0123'
const URL_OK = 'https://api.example.test/v1/chat/completions'
const INIT = () => ({ method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${FAKE_KEY}` }, body: '{"model":"m","messages":[]}' })

type Script = { chunks?: SpawnChunk[]; end?: SpawnEnd; hang?: boolean; startError?: Error; failAfterChunks?: Error }

// A stand-in for `$.process.spawn`: hands out the scripted pieces, then the
// exit (or waits forever with `hang`); records every request, pull and
// return(). return() settles a pending pull as the host does (done).
function fakeSpawn(script: Script = {}) {
  const calls: SpawnRequest[] = []
  const state = { pulls: 0, returned: 0 }
  const spawn: Spawn = req => {
    calls.push(req)
    const chunks = script.chunks ?? [{ stream: 'stdout', text: `{"ok":true}${STATUS_MARK}200` }]
    let i = 0
    let wake: ((r: IteratorResult<SpawnChunk, SpawnEnd>) => void) | undefined
    const it: AsyncIterator<SpawnChunk, SpawnEnd> & AsyncIterable<SpawnChunk> = {
      next: () => {
        state.pulls++
        if (script.startError && i === 0) return Promise.reject(script.startError)
        if (i < chunks.length) return Promise.resolve({ done: false, value: chunks[i++]! })
        if (script.failAfterChunks) return Promise.reject(script.failAfterChunks)
        if (script.hang) return new Promise(r => (wake = r))
        return Promise.resolve({ done: true, value: script.end ?? { code: 0, signal: null } })
      },
      return: () => {
        state.returned++
        wake?.({ done: true, value: { code: null, signal: 'SIGTERM' } })
        return Promise.resolve({ done: true, value: { code: null, signal: 'SIGTERM' } })
      },
      [Symbol.asyncIterator]() {
        return this
      },
    }
    return it
  }
  return { spawn, calls, state }
}

// A sleep that fires only when the test says so.
function timer() {
  const calls: { ms: number; signal?: AbortSignal }[] = []
  let fire: (() => void) | undefined
  const sleep = (ms: number, o?: { signal?: AbortSignal }) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ ms, signal: o?.signal })
      fire = resolve
      o?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
  return { sleep, calls, fire: () => fire?.() }
}

const opts = (over: any = {}) => ({ signal: new AbortController().signal, timeoutMs: 570_000, ...over })

// Parses a curl config the way curl's tool_parsecfg.c does for the lines we
// write: `name = "quoted"` (\t \n \r \v mapped, any other `\x` -> x) or a bare
// switch. A stand-in that makes the injection tests readable; the same
// payloads also run against a real curl (scripts/curl-integration.ts).
function parseConfig(text: string): { name: string; value?: string }[] {
  const out: { name: string; value?: string }[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const m = /^([a-z-]+)(?:\s*=\s*"((?:[^"\\]|\\.)*)")?\s*$/.exec(line)
    if (!m) throw new Error(`unparseable config line: ${line.slice(0, 80)}`)
    const value = m[2]?.replace(/\\(.)/g, (_s, c: string) => ({ t: '\t', n: '\n', r: '\r', v: '\v' })[c] ?? c)
    out.push(value === undefined ? { name: m[1]! } : { name: m[1]!, value })
  }
  return out
}

describe('curlFetch: argv and config', () => {
  test('argv is exactly curl --disable --config -, nothing secret in argv or env', async () => {
    const s = fakeSpawn()
    await curlFetch(s.spawn, opts())(URL_OK, INIT())
    expect(s.calls.length).toBe(1)
    const req = s.calls[0]!
    expect([...req.argv]).toEqual(['curl', '--disable', '--config', '-'])
    expect([...CURL_ARGV]).toEqual(['curl', '--disable', '--config', '-'])
    const outside = JSON.stringify({ argv: req.argv, env: req.env, cwd: (req as any).cwd })
    for (const secret of [FAKE_KEY, URL_OK, 'chat/completions', '"messages"']) expect(outside.includes(secret)).toBe(false)
    expect(req.input?.includes(FAKE_KEY)).toBe(true)
  })

  test('the config on stdin holds every directive the plan lists', async () => {
    const s = fakeSpawn()
    await curlFetch(s.spawn, opts({ timeoutMs: 570_000 }))(URL_OK, INIT())
    const lines = parseConfig(s.calls[0]!.input!)
    const names = lines.map(l => l.name)
    expect(lines.find(l => l.name === 'url')?.value).toBe(URL_OK)
    expect(lines.filter(l => l.name === 'header').map(l => l.value)).toEqual(['content-type: application/json', `authorization: Bearer ${FAKE_KEY}`])
    expect(lines.find(l => l.name === 'data-binary')?.value).toBe('{"model":"m","messages":[]}')
    for (const n of ['silent', 'show-error', 'globoff']) expect(names.includes(n)).toBe(true)
    expect(lines.find(l => l.name === 'proto')?.value).toBe('=https,http')
    expect(lines.find(l => l.name === 'max-redirs')?.value).toBe('0')
    expect(lines.find(l => l.name === 'max-time')?.value).toBe('570')
    expect(lines.find(l => l.name === 'write-out')?.value).toBe(`${STATUS_MARK}%{http_code}`)
    // POST is implied by the data; no `request` line for it.
    expect(names.includes('request')).toBe(false)
  })

  test('another method is written as a request line', () => {
    const cfg = buildConfig(URL_OK, { method: 'PUT', headers: {}, body: '{}' }, 30_000)
    expect(parseConfig(cfg).find(l => l.name === 'request')?.value).toBe('PUT')
  })

  test('max-time rounds up to whole seconds, at least 1', () => {
    expect(parseConfig(buildConfig(URL_OK, INIT(), 1500)).find(l => l.name === 'max-time')?.value).toBe('2')
    expect(parseConfig(buildConfig(URL_OK, INIT(), 1)).find(l => l.name === 'max-time')?.value).toBe('1')
  })

  test('the child env blanks the key variables and the TLS key log, sets no key', async () => {
    const s = fakeSpawn()
    await curlFetch(s.spawn, opts({ env: { HOME: '/tmp/x', CURL_HOME: '/tmp/x' } }))(URL_OK, INIT())
    const env = s.calls[0]!.env!
    for (const n of ['OPENAI_API_KEY', 'ROUTER_ANTHROPIC_API_KEY', 'ZAI_API_KEY', 'XAI_API_KEY', 'ROUTER_CUSTOM_API_KEYS', 'SSLKEYLOGFILE']) expect(env[n]).toBe('')
    expect(env.HOME).toBe('/tmp/x')
    expect(JSON.stringify(env).includes(FAKE_KEY)).toBe(false)
  })

  test('the child env blanks the env variable of every key source (a new provider is blanked without a change here)', async () => {
    const s = fakeSpawn()
    await curlFetch(s.spawn, opts({ env: { HOME: '/tmp/x' } }))(URL_OK, INIT())
    const env = s.calls[0]!.env!
    const sources = Object.values(KEY_SOURCES).map(k => k.env)
    expect(sources.length).toBeGreaterThan(0)
    for (const n of sources) expect(env[n]).toBe('')
    for (const n of [...sources, 'ROUTER_CUSTOM_API_KEYS', 'SSLKEYLOGFILE']) expect(BLANKED_ENV.includes(n)).toBe(true)
  })

  test('a key passed through opts.env is refused before curl starts', async () => {
    const s = fakeSpawn()
    let err: unknown
    try {
      await curlFetch(s.spawn, opts({ env: { HOME: FAKE_KEY }, secrets: [FAKE_KEY] }))(URL_OK, INIT())
    } catch (e) {
      err = e
    }
    expect(String(err).includes('environment')).toBe(true)
    expect(String(err).includes(FAKE_KEY)).toBe(false)
    expect(s.calls.length).toBe(0)
  })
})

describe('encodeValue and validation', () => {
  test('escapes quote, backslash, newline, tab and carriage return', () => {
    expect(encodeValue('a"b\\c\nd\te\rf')).toBe('"a\\"b\\\\c\\nd\\te\\rf"')
    expect(encodeValue('')).toBe('""')
    expect(encodeValue('héllo ✓')).toBe('"héllo ✓"')
  })

  test('directive-injection payloads cannot add a config line', () => {
    const payloads = ['"\nurl = "http://evil.test/"', '"\noutput = "/tmp/pwned"', 'ends in a backslash \\', '\\"\nheader = "x: y', '\r\nproxy = "http://127.0.0.1:9"']
    for (const p of payloads) {
      const cfg = buildConfig(URL_OK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: p }, 10_000)
      const lines = parseConfig(cfg)
      expect(lines.filter(l => l.name === 'url').length).toBe(1)
      expect(lines.some(l => l.name === 'output' || l.name === 'proxy')).toBe(false)
      expect(lines.filter(l => l.name === 'header').length).toBe(1)
      expect(lines.find(l => l.name === 'data-binary')?.value).toBe(p)
    }
  })

  test('bad header names are rejected before curl starts', async () => {
    for (const name of ['bad name', 'x:y', '', 'x\ny', 'ünï']) {
      const s = fakeSpawn()
      let err: unknown
      try {
        await curlFetch(s.spawn, opts())(URL_OK, { method: 'POST', headers: { [name]: 'v' }, body: '{}' })
      } catch (e) {
        err = e
      }
      expect(String(err).includes('header name')).toBe(true)
      expect(s.calls.length).toBe(0)
    }
  })

  test('header values with CR, LF or NUL are rejected, the value never shown', async () => {
    for (const v of [`Bearer ${FAKE_KEY}\r\nx-evil: 1`, `Bearer ${FAKE_KEY}\n`, `Bearer ${FAKE_KEY}\0`]) {
      const s = fakeSpawn()
      let err: unknown
      try {
        await curlFetch(s.spawn, opts())(URL_OK, { method: 'POST', headers: { authorization: v }, body: '{}' })
      } catch (e) {
        err = e
      }
      expect(String(err).includes('header value')).toBe(true)
      expect(String(err).includes(FAKE_KEY)).toBe(false)
      expect(s.calls.length).toBe(0)
    }
  })

  test('URLs: only parseable http(s) with no control characters or spaces', async () => {
    for (const u of ['ftp://x.test/a', 'file:///etc/passwd', 'not a url', 'https://x.test/a\nurl = "http://evil"', 'https://x.test/\0', 'https://x.test/a b', 'gopher://x', '']) {
      const s = fakeSpawn()
      let err: unknown
      try {
        await curlFetch(s.spawn, opts())(u, INIT())
      } catch (e) {
        err = e
      }
      expect(String(err).includes('URL')).toBe(true)
      expect(s.calls.length).toBe(0)
    }
    const ok = fakeSpawn()
    await curlFetch(ok.spawn, opts())('http://127.0.0.1:8765/v1/chat/completions', INIT())
    expect(ok.calls.length).toBe(1)
  })

  test('a body with NUL or a leading @ (curl would read a file) is rejected', async () => {
    for (const body of ['{"a":"\0"}', '@/etc/passwd']) {
      const s = fakeSpawn()
      let err: unknown
      try {
        await curlFetch(s.spawn, opts())(URL_OK, { method: 'POST', headers: {}, body })
      } catch (e) {
        err = e
      }
      expect(String(err).includes('body')).toBe(true)
      expect(s.calls.length).toBe(0)
    }
  })
})

describe('curlFetch: replies and failures', () => {
  test('status and body are read from stdout, the mark split across pieces', async () => {
    const half = Math.floor(STATUS_MARK.length / 2)
    const s = fakeSpawn({ chunks: [{ stream: 'stdout', text: '{"id":"x",' }, { stream: 'stdout', text: `"y":1}${STATUS_MARK.slice(0, half)}` }, { stream: 'stdout', text: `${STATUS_MARK.slice(half)}201` }] })
    const r = await curlFetch(s.spawn, opts())(URL_OK, INIT())
    expect(r).toEqual({ status: 201, ok: true, text: '{"id":"x","y":1}' })
  })

  test('an HTTP error status is a response, not a throw', async () => {
    const s = fakeSpawn({ chunks: [{ stream: 'stdout', text: `{"error":{"message":"bad"}}${STATUS_MARK}401` }] })
    const r = await curlFetch(s.spawn, opts())(URL_OK, INIT())
    expect(r.status).toBe(401)
    expect(r.ok).toBe(false)
  })

  test('a body that itself contains the mark is cut at the last one', async () => {
    const s = fakeSpawn({ chunks: [{ stream: 'stdout', text: `a${STATUS_MARK}999 b${STATUS_MARK}200` }] })
    const r = await curlFetch(s.spawn, opts())(URL_OK, INIT())
    expect(r.text).toBe(`a${STATUS_MARK}999 b`)
    expect(r.status).toBe(200)
  })

  test('a missing status mark is an unreadable reply', async () => {
    const s = fakeSpawn({ chunks: [{ stream: 'stdout', text: '{"ok":true}' }] })
    let err: unknown
    try {
      await curlFetch(s.spawn, opts())(URL_OK, INIT())
    } catch (e) {
      err = e
    }
    expect(String(err).includes('unreadable reply')).toBe(true)
  })

  test('a mark with a non-numeric status is an unreadable reply', async () => {
    const s = fakeSpawn({ chunks: [{ stream: 'stdout', text: `{}${STATUS_MARK}abc` }] })
    let err: unknown
    try {
      await curlFetch(s.spawn, opts())(URL_OK, INIT())
    } catch (e) {
      err = e
    }
    expect(String(err).includes('unreadable reply')).toBe(true)
  })

  test('curl exiting non-zero throws its stderr, redacted', async () => {
    const s = fakeSpawn({
      chunks: [{ stream: 'stderr', text: `curl: (7) Failed to connect to api.example.test port 443 (auth Bearer ${FAKE_KEY}, ${FAKE_KEY})\n` }],
      end: { code: 7, signal: null },
    })
    let err: unknown
    try {
      await curlFetch(s.spawn, opts({ secrets: [FAKE_KEY] }))(URL_OK, INIT())
    } catch (e) {
      err = e
    }
    expect(String(err).includes('curl failed (exit 7)')).toBe(true)
    expect(String(err).includes('Failed to connect')).toBe(true)
    expect(String(err).includes(FAKE_KEY)).toBe(false)
  })

  test('the request header values are redacted from curl errors even without opts.secrets', async () => {
    const s = fakeSpawn({ chunks: [{ stream: 'stderr', text: `curl: (35) oops ${FAKE_KEY}` }], end: { code: 35, signal: null } })
    let err: unknown
    try {
      await curlFetch(s.spawn, opts())(URL_OK, INIT())
    } catch (e) {
      err = e
    }
    expect(String(err).includes(FAKE_KEY)).toBe(false)
  })

  test('a child ended by a signal is an error', async () => {
    const s = fakeSpawn({ chunks: [], end: { code: null, signal: 'SIGTERM' } })
    let err: unknown
    try {
      await curlFetch(s.spawn, opts())(URL_OK, INIT())
    } catch (e) {
      err = e
    }
    expect(String(err).includes('SIGTERM')).toBe(true)
  })

  test('a first pull that rejects with nothing read is a start failure', async () => {
    const s = fakeSpawn({ startError: new Error('spawn curl ENOENT') })
    let err: unknown
    try {
      await curlFetch(s.spawn, opts())(URL_OK, INIT())
    } catch (e) {
      err = e
    }
    expect(err instanceof CurlStartError).toBe(true)
  })

  test('a spawn that throws (a hook denied it) is a start failure; the timer is stopped', async () => {
    const t = timer()
    const throwing: Spawn = () => {
      throw new Error('denied by a hook')
    }
    let err: unknown
    try {
      await curlFetch(throwing, opts({ sleep: t.sleep }))(URL_OK, INIT())
    } catch (e) {
      err = e
    }
    expect(err instanceof CurlStartError).toBe(true)
    expect(t.calls[0]?.signal?.aborted).toBe(true)
  })

  test('a rejection after a piece was read is not a start failure', async () => {
    const s = fakeSpawn({ chunks: [{ stream: 'stdout', text: '{' }], failAfterChunks: new Error('host failure') })
    let err: unknown
    try {
      await curlFetch(s.spawn, opts())(URL_OK, INIT())
    } catch (e) {
      err = e
    }
    expect(err instanceof CurlStartError).toBe(false)
    expect(String(err).includes('host failure')).toBe(true)
  })
})

describe('curlFetch: the child is ended in one place', () => {
  test('timeout: the timer ends the loop with return() and the call rejects', async () => {
    const s = fakeSpawn({ chunks: [], hang: true })
    const t = timer()
    const p = curlFetch(s.spawn, opts({ sleep: t.sleep, timeoutMs: 15_000 }))(URL_OK, INIT())
    p.catch(() => undefined)
    await tick()
    expect(t.calls[0]?.ms).toBe(15_000)
    expect(s.state.returned).toBe(0)
    t.fire()
    let err: unknown
    try {
      await p
    } catch (e) {
      err = e
    }
    expect(s.state.returned).toBe(1)
    expect(String(err).includes('timed out')).toBe(true)
  })

  test('Esc: the signal aborting ends the loop with return()', async () => {
    const s = fakeSpawn({ chunks: [], hang: true })
    const ac = new AbortController()
    const t = timer()
    const p = curlFetch(s.spawn, opts({ signal: ac.signal, sleep: t.sleep }))(URL_OK, INIT())
    p.catch(() => undefined)
    await tick()
    ac.abort()
    let err: unknown
    try {
      await p
    } catch (e) {
      err = e
    }
    expect(s.state.returned).toBe(1)
    expect(String(err).includes('aborted')).toBe(true)
    // The timer was stopped with the call.
    expect(t.calls[0]?.signal?.aborted).toBe(true)
  })

  test('abandonment: a signal that aborts while a pull is pending ends the loop', async () => {
    // The dispatch abandoned (the enclosing hook settled, budget exhausted)
    // aborts the same signal; the pull pending on the silent child is cut.
    const s = fakeSpawn({ chunks: [{ stream: 'stdout', text: '{"partial":' }], hang: true })
    const ac = new AbortController()
    const p = curlFetch(s.spawn, opts({ signal: ac.signal }))(URL_OK, INIT())
    p.catch(() => undefined)
    await tick()
    expect(s.state.pulls).toBe(2)
    ac.abort()
    await p.catch(() => undefined)
    expect(s.state.returned).toBe(1)
  })

  test('a signal already aborted starts nothing', async () => {
    const s = fakeSpawn()
    const ac = new AbortController()
    ac.abort()
    let err: unknown
    try {
      await curlFetch(s.spawn, opts({ signal: ac.signal }))(URL_OK, INIT())
    } catch (e) {
      err = e
    }
    expect(String(err).includes('aborted')).toBe(true)
    expect(s.calls.length).toBe(0)
  })

  test('stdout overflow by UTF-8 bytes ends the loop: reply too large', async () => {
    // 2.2M two-byte characters: under the limit in characters, over it in bytes.
    const piece = 'é'.repeat(1_100_000)
    const s = fakeSpawn({ chunks: [{ stream: 'stdout', text: piece }, { stream: 'stdout', text: piece }, { stream: 'stdout', text: 'never read' }], hang: true })
    let err: unknown
    try {
      await curlFetch(s.spawn, opts())(URL_OK, INIT())
    } catch (e) {
      err = e
    }
    expect(String(err).includes('reply too large')).toBe(true)
    expect(s.state.returned).toBe(1)
    expect(s.state.pulls).toBe(2)
    expect(OUTPUT_LIMIT).toBe(4 * 1024 * 1024)
  })

  test('stderr overflow ends the loop too', async () => {
    const big = 'x'.repeat(OUTPUT_LIMIT + 1)
    const s = fakeSpawn({ chunks: [{ stream: 'stderr', text: big }], hang: true })
    let err: unknown
    try {
      await curlFetch(s.spawn, opts())(URL_OK, INIT())
    } catch (e) {
      err = e
    }
    expect(String(err).includes('reply too large')).toBe(true)
    expect(s.state.returned).toBe(1)
  })

  test('exactly the limit is accepted', async () => {
    const tail = `${STATUS_MARK}200`
    const s = fakeSpawn({ chunks: [{ stream: 'stdout', text: 'a'.repeat(OUTPUT_LIMIT - tail.length) + tail }] })
    const r = await curlFetch(s.spawn, opts())(URL_OK, INIT())
    expect(r.status).toBe(200)
    expect(s.state.returned).toBe(0)
  })

  test('the escaped data line over the config line limit is refused before curl starts', async () => {
    // Every `"` doubles under escaping: raw size below the limit, escaped above.
    const raw = '"'.repeat(Math.ceil(CONFIG_LINE_LIMIT / 2) + 10)
    expect(raw.length < CONFIG_LINE_LIMIT).toBe(true)
    const s = fakeSpawn()
    let err: unknown
    try {
      await curlFetch(s.spawn, opts())(URL_OK, { method: 'POST', headers: {}, body: raw })
    } catch (e) {
      err = e
    }
    expect(String(err).includes('request too large')).toBe(true)
    expect(s.calls.length).toBe(0)
    expect(CONFIG_LINE_LIMIT <= 10 * 1024 * 1024).toBe(true)
  })

  test('after a normal exit return() is not needed', async () => {
    const s = fakeSpawn()
    await curlFetch(s.spawn, opts())(URL_OK, INIT())
    expect(s.state.returned).toBe(0)
  })
})

describe('transport selection', () => {
  const versionOk = () => fakeSpawn({ chunks: [{ stream: 'stdout', text: 'curl 8.7.1 (x86_64-apple-darwin) libcurl/8.7.1\nProtocols: http https\n' }] })

  test('checkCurl: curl --version runs', async () => {
    const s = versionOk()
    expect(await checkCurl(s.spawn)).toBe('curl')
    expect([...s.calls[0]!.argv]).toEqual(['curl', '--disable', '--version'])
  })

  test('checkCurl: cannot start, non-zero exit or other output -> fetch', async () => {
    expect(await checkCurl(fakeSpawn({ startError: new Error('ENOENT') }).spawn)).toBe('fetch')
    expect(await checkCurl(fakeSpawn({ chunks: [], end: { code: 127, signal: null } }).spawn)).toBe('fetch')
    expect(await checkCurl(fakeSpawn({ chunks: [{ stream: 'stdout', text: 'not curl' }] }).spawn)).toBe('fetch')
    const throwing: Spawn = () => {
      throw new Error('denied')
    }
    expect(await checkCurl(throwing)).toBe('fetch')
  })

  test('checkCurl: a check cut by the signal is unknown (not cached)', async () => {
    const ac = new AbortController()
    ac.abort()
    expect(await checkCurl(versionOk().spawn, ac.signal)).toBe('unknown')
  })

  test('selectTransport checks once per cache (module load)', async () => {
    const cache: TransportCache = {}
    const s = versionOk()
    expect(await selectTransport(cache, () => checkCurl(s.spawn))).toBe('curl')
    expect(await selectTransport(cache, () => checkCurl(s.spawn))).toBe('curl')
    expect(s.calls.length).toBe(1)
    const failing: TransportCache = {}
    let n = 0
    const check = async () => {
      n++
      return 'fetch' as const
    }
    expect(await selectTransport(failing, check)).toBe('fetch')
    expect(await selectTransport(failing, check)).toBe('fetch')
    expect(n).toBe(1)
  })

  test('an unknown check is used as fetch for now and checked again next time', async () => {
    const cache: TransportCache = {}
    const answers: ('unknown' | 'curl')[] = ['unknown', 'curl']
    let n = 0
    const check = async () => answers[n++]!
    expect(await selectTransport(cache, check)).toBe('fetch')
    expect(await selectTransport(cache, check)).toBe('curl')
    expect(await selectTransport(cache, check)).toBe('curl')
    expect(n).toBe(2)
  })

  test('/providers line', () => {
    expect(transportLine('curl')).toBe('transport: curl')
    expect(transportLine('fetch')).toBe('transport: fetch (30 s limit)')
  })

  test('fallbackFetch: a confirmed start failure goes through $.http.fetch and switches the cache', async () => {
    const cache: TransportCache = { kind: 'curl' }
    const fetchCalls: string[] = []
    const httpFetch = async (url: string) => {
      fetchCalls.push(url)
      return { status: 200, ok: true, text: '{}' }
    }
    const curl = async () => {
      throw new CurlStartError('cannot start curl')
    }
    const r = await fallbackFetch(curl, httpFetch, cache)(URL_OK, INIT())
    expect(r.status).toBe(200)
    expect(fetchCalls).toEqual([URL_OK])
    expect(cache.kind).toBe('fetch')
  })

  test('fallbackFetch: any other curl failure is an error, never a retry through $.http.fetch', async () => {
    const cache: TransportCache = { kind: 'curl' }
    let fetched = 0
    const httpFetch = async () => {
      fetched++
      return { status: 200, ok: true, text: '{}' }
    }
    for (const e of [new Error('curl failed (exit 28): Operation timed out'), new Error('reply too large'), new Error('aborted')]) {
      const curl = async () => {
        throw e
      }
      let err: unknown
      try {
        await fallbackFetch(curl, httpFetch, cache)(URL_OK, INIT())
      } catch (x) {
        err = x
      }
      expect(err).toBe(e)
    }
    expect(fetched).toBe(0)
    expect(cache.kind).toBe('curl')
  })

  test('fallbackFetch: the fallback hitting the host 30 s limit says so', async () => {
    const curl = async () => {
      throw new CurlStartError('cannot start curl')
    }
    const httpFetch = async () => {
      throw new Error('HooksError: provider-router: $.http.fetch(...) aborted: no complete answer within 30000ms')
    }
    let err: unknown
    try {
      await fallbackFetch(curl, httpFetch, { kind: 'curl' })(URL_OK, INIT())
    } catch (x) {
      err = x
    }
    expect(String(err).includes('the reply took longer than 30 s, the limit without curl')).toBe(true)
  })

  test('hostLimitText', () => {
    expect(hostLimitText(new Error('x: no complete answer within 30000ms'))?.includes('the limit without curl')).toBe(true)
    expect(hostLimitText(new Error('other'))).toBe(undefined)
  })
})
