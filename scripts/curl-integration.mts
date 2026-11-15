// Integration checks of hooks/transport.ts against a real `curl`, run by
// `npm test` after the unit tests (`node scripts/curl-integration.mts`).
// `claude plugin test` runs tests with no process or network access, so these
// run under Node with a Node stand-in for `$.process.spawn`. Every request
// goes to a listener this script starts on 127.0.0.1 (or a closed local
// port); no external network. Skipped when `curl` is absent. The key is an
// obvious fake.

import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CurlStartError, checkCurl, curlFetch, type Spawn, type SpawnChunk, type SpawnEnd } from '../hooks/transport.ts'

const FAKE_KEY = 'FAKEKEYintegration0123456789'

if (spawnSync('curl', ['--version']).error) {
  console.log('curl-integration: SKIP (curl not found)')
  process.exit(0)
}

// `$.process.spawn` as the host describes it: pieces as they come, then the
// exit; the loop is the child's life (return() kills it).
const pids: number[] = []
const spawn: Spawn = req => {
  const child = nodeSpawn(req.argv[0]!, req.argv.slice(1), { env: { ...process.env, ...(req.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] })
  if (child.pid) pids.push(child.pid)
  const queue: (IteratorResult<SpawnChunk, SpawnEnd> | { error: unknown })[] = []
  let waiting: ((r: any) => void) | undefined
  const push = (r: IteratorResult<SpawnChunk, SpawnEnd> | { error: unknown }) => {
    if (waiting) {
      const w = waiting
      waiting = undefined
      w(r)
    } else queue.push(r)
  }
  let outDone = false
  let errDone = false
  let exit: SpawnEnd | undefined
  const maybeEnd = () => {
    if (outDone && errDone && exit) push({ done: true, value: exit })
  }
  child.stdout.setEncoding('utf8').on('data', (text: string) => push({ done: false, value: { stream: 'stdout', text } }))
  child.stderr.setEncoding('utf8').on('data', (text: string) => push({ done: false, value: { stream: 'stderr', text } }))
  child.stdout.on('end', () => ((outDone = true), maybeEnd()))
  child.stderr.on('end', () => ((errDone = true), maybeEnd()))
  child.on('error', error => push({ error }))
  child.on('exit', (code, signal) => ((exit = { code, signal }), maybeEnd()))
  child.stdin.on('error', () => undefined)
  child.stdin.end(req.input ?? '')
  const it: AsyncIterator<SpawnChunk, SpawnEnd> & AsyncIterable<SpawnChunk> = {
    next: () => {
      const r = queue.shift() ?? new Promise<any>(resolve => (waiting = resolve))
      return Promise.resolve(r).then(x => ('error' in x ? Promise.reject(x.error) : x))
    },
    return: async () => {
      child.kill('SIGTERM')
      return { done: true, value: { code: null, signal: 'SIGTERM' } }
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
  return it
}

const sleep = (ms: number, o?: { signal?: AbortSignal }) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    o?.signal?.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))))
  })

type Seen = { method?: string; url?: string; headers: IncomingMessage['headers']; body: string; closedEarly: boolean }
const seen: Seen[] = []

function listen(handler: (req: IncomingMessage, res: ServerResponse, s: Seen) => void): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const s: Seen = { method: req.method, url: req.url, headers: req.headers, body: '', closedEarly: false }
    seen.push(s)
    req.setEncoding('utf8')
    req.on('data', (d: string) => (s.body += d))
    res.on('close', () => {
      if (!res.writableFinished) s.closedEarly = true
    })
    req.on('end', () => handler(req, res, s))
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })))
}

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < ms) await sleep(20)
  return cond()
}

let failures = 0
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`(pass) ${name}`)
  } catch (err) {
    failures++
    console.log(`(fail) ${name}: ${String(err)}`)
  }
}
function assert(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(what)
}

const opts = (over: Record<string, unknown> = {}) => ({ signal: new AbortController().signal, timeoutMs: 30_000, sleep, secrets: [FAKE_KEY], ...over })
const init = (body: string) => ({ method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${FAKE_KEY}` }, body })

const echo = await listen((_req, res, s) => {
  if (s.url?.startsWith('/slow')) return // never answers: the client must give up
  if (s.url?.startsWith('/big')) {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('x'.repeat(5 * 1024 * 1024))
    return
  }
  res.writeHead(s.url?.startsWith('/err') ? 401 : 200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ body: s.body, auth: s.headers.authorization === `Bearer ${FAKE_KEY}` }))
})

await check('checkCurl finds curl', async () => {
  assert((await checkCurl(spawn)) === 'curl', 'checkCurl did not answer curl')
})

await check('a POST round-trips: body bytes, the key header, the status', async () => {
  const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'héllo ✓ "quoted" \\ back\nslash\ttab' }] })
  const r = await curlFetch(spawn, opts())(`${echo.base}/v1/chat/completions?a=[1]&b={2}`, init(body))
  assert(r.status === 200 && r.ok, `status ${r.status}`)
  const j = JSON.parse(r.text)
  assert(j.body === body, 'body changed on the way')
  assert(j.auth === true, 'auth header did not arrive')
  assert(seen.at(-1)?.url === '/v1/chat/completions?a=[1]&b={2}', `globoff: url was ${seen.at(-1)?.url}`)
})

await check('an HTTP error status comes back as a response', async () => {
  const r = await curlFetch(spawn, opts())(`${echo.base}/err`, init('{}'))
  assert(r.status === 401 && !r.ok, `status ${r.status}`)
})

await check('directive-injection payloads in the body arrive verbatim and add no request', async () => {
  const payloads = ['"\nurl = "http://127.0.0.1:9/evil"', '"\noutput = "/tmp/provider-router-pwned"', 'ends in a backslash \\', '\\"\nheader = "x-evil: 1', '\r\nproxy = "http://127.0.0.1:9"']
  for (const p of payloads) {
    const before = seen.length
    const r = await curlFetch(spawn, opts())(`${echo.base}/v1/x`, init(p))
    assert(r.status === 200, `status ${r.status}`)
    assert(JSON.parse(r.text).body === p, `payload changed: ${JSON.stringify(p)}`)
    assert(seen.length === before + 1, 'more than one request')
    assert(seen.at(-1)?.headers['x-evil'] === undefined, 'injected header arrived')
  }
  assert(!existsSync('/tmp/provider-router-pwned'), 'output file written')
})

await check('header and URL injection is refused before curl starts', async () => {
  const before = pids.length
  for (const [url, headers] of [
    [`${echo.base}/v1/x`, { authorization: `Bearer ${FAKE_KEY}\r\nx-evil: 1` }],
    [`${echo.base}/v1/x\nurl = "http://127.0.0.1:9"`, {}],
    [`${echo.base}/v1/x`, { 'bad name': 'v' }],
  ] as const) {
    let err: unknown
    try {
      await curlFetch(spawn, opts())(url, { method: 'POST', headers: headers as Record<string, string>, body: '{}' })
    } catch (e) {
      err = e
    }
    assert(err, 'not refused')
    assert(!String(err).includes(FAKE_KEY), 'key in error text')
  }
  assert(pids.length === before, 'curl was started')
})

await check('a hostile .curlrc is not read (no trace file, no dead proxy)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pr-curlrc-'))
  try {
    const trace = join(home, 'trace.txt')
    writeFileSync(join(home, '.curlrc'), `trace-ascii = "${trace}"\nproxy = "http://127.0.0.1:9"\n`)
    // Control: a curl without --disable reads that .curlrc (no key involved).
    // (Async: a blocking spawn would stall this process's own listener.)
    await new Promise(resolve =>
      nodeSpawn('curl', ['-s', '-m', '5', '-o', '/dev/null', `${echo.base}/v1/control`], { env: { ...process.env, HOME: home, CURL_HOME: home }, stdio: 'ignore' }).on('exit', resolve),
    )
    assert(existsSync(trace), 'control: plain curl did not read the .curlrc')
    rmSync(trace)
    const r = await curlFetch(spawn, opts({ env: { HOME: home, CURL_HOME: home } }))(`${echo.base}/v1/x`, init('{"a":1}'))
    assert(r.status === 200 && JSON.parse(r.text).auth === true, `status ${r.status}`)
    assert(!existsSync(trace), 'trace file written')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await check('the child argv holds no key, URL or body while it runs; Esc kills it (connection drop)', async () => {
  const ac = new AbortController()
  const before = seen.length
  const p = curlFetch(spawn, opts({ signal: ac.signal }))(`${echo.base}/slow`, init('{"secret-body":1}'))
  p.catch(() => undefined)
  assert(await until(() => seen.length > before), 'request never arrived')
  const pid = pids.at(-1)!
  const args = spawnSync('ps', ['-o', 'args=', '-p', String(pid)]).stdout.toString()
  assert(args.includes('curl --disable --config -'), `argv was ${args}`)
  for (const s of [FAKE_KEY, '/slow', 'secret-body', '127.0.0.1']) assert(!args.includes(s), `argv holds ${s}`)
  ac.abort()
  let err: unknown
  try {
    await p
  } catch (e) {
    err = e
  }
  assert(String(err).includes('aborted'), `error was ${String(err)}`)
  assert(await until(() => seen.at(-1)!.closedEarly), 'the listener saw no connection drop')
})

await check('timeout kills the child (connection drop)', async () => {
  const before = seen.length
  let err: unknown
  try {
    await curlFetch(spawn, opts({ timeoutMs: 700 }))(`${echo.base}/slow`, init('{}'))
  } catch (e) {
    err = e
  }
  assert(String(err).includes('timed out'), `error was ${String(err)}`)
  assert(seen.length === before + 1, 'no request')
  assert(await until(() => seen.at(-1)!.closedEarly), 'the listener saw no connection drop')
})

await check('a reply over 4 MiB ends the call: reply too large', async () => {
  let err: unknown
  try {
    await curlFetch(spawn, opts())(`${echo.base}/big`, init('{}'))
  } catch (e) {
    err = e
  }
  assert(String(err).includes('reply too large'), `error was ${String(err)}`)
})

await check('a connection error throws curl stderr, without the key', async () => {
  const closed = await listen(() => undefined)
  const port = (closed.server.address() as AddressInfo).port
  await new Promise(r => closed.server.close(r))
  let err: unknown
  try {
    await curlFetch(spawn, opts())(`http://127.0.0.1:${port}/v1/x`, init('{}'))
  } catch (e) {
    err = e
  }
  assert(String(err).includes('curl failed (exit 7)'), `error was ${String(err)}`)
  assert(!(err instanceof CurlStartError), 'a sent request counted as a start failure')
  assert(!String(err).includes(FAKE_KEY), 'key in error text')
})

await check('a missing executable is a start failure', async () => {
  const missing: Spawn = req => spawn({ ...req, argv: ['provider-router-no-such-curl', ...req.argv.slice(1)] })
  let err: unknown
  try {
    await curlFetch(missing, opts())(`${echo.base}/v1/x`, init('{}'))
  } catch (e) {
    err = e
  }
  assert(err instanceof CurlStartError, `error was ${String(err)}`)
})

echo.server.closeAllConnections()
echo.server.close()
console.log(failures ? `curl-integration: ${failures} failed` : 'curl-integration: all passed')
process.exit(failures ? 1 : 0)
