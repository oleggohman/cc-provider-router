// Message threads: the engine's first request of a loop is a `thread: create`
// carrying everything; later requests are `thread: continue` carrying only the
// new messages, no tools, and a system prompt reduced to the billing header,
// because the first-party API keeps the rest server-side. Other providers keep
// nothing, so the router keeps each loop's conversation itself and rebuilds
// the full request on a continue.
//
// The engine's request also uses first-party message forms other providers
// reject: `role: "system"` messages, `tool_addition` / `tool_removal` blocks,
// a placeholder tool, a billing-header system block and cache_control
// `scope`. normalizeBody turns them into a plain Messages API request.

const BILLING_PREFIX = 'x-anthropic-billing-header:'
const PLACEHOLDER_TOOL = 'DeferredToolPlaceholder'

// A loop's conversation as the provider last saw it: the system prompt and
// tools in force, and the messages up to and including the last assistant
// turn the engine recorded (the anchor a continue builds on).
export type ThreadState = { system: unknown; tools: any[] | undefined; base: any[] }

export type Threads = {
  get(key: string): ThreadState | undefined
  set(key: string, s: ThreadState): void
  delete(key: string): void
}

export function createThreads(): Threads {
  const m = new Map<string, ThreadState>()
  return { get: k => m.get(k), set: (k, s) => void m.set(k, s), delete: k => void m.delete(k) }
}

export function loopKeyOf(agentId: string | undefined): string {
  return agentId || 'main'
}

function isBilling(b: any): boolean {
  return b?.type === 'text' && typeof b.text === 'string' && b.text.startsWith(BILLING_PREFIX)
}

function stripBilling(system: unknown): unknown {
  if (Array.isArray(system)) return system.filter(b => !isBilling(b))
  if (typeof system === 'string' && system.startsWith(BILLING_PREFIX)) return undefined
  return system
}

function systemIsEmpty(system: unknown): boolean {
  const s = stripBilling(system)
  return s === undefined || s === '' || (Array.isArray(s) && s.length === 0)
}

export type Resolved = { ok: true; body: any } | { ok: false; message: string }

// The full request for this step: a create (or a body without `thread`) as
// is; a continue rebuilt from the loop's state plus the new messages.
export function resolveThread(body: any, state: ThreadState | undefined): Resolved {
  if (body?.thread?.type !== 'continue') return { ok: true, body }
  if (!state) {
    return {
      ok: false,
      message:
        'the conversation so far is not known to the router (it continues a thread started before this session of the mod, e.g. after a /config change or an interrupted step); run /clear or /compact and try again',
    }
  }
  const delta = Array.isArray(body.messages) ? body.messages : []
  return {
    ok: true,
    body: {
      ...body,
      system: systemIsEmpty(body.system) ? state.system : body.system,
      tools: Array.isArray(body.tools) ? body.tools : state.tools,
      messages: [...state.base, ...delta],
    },
  }
}

// Records the step: the messages sent plus the assistant turn the engine now
// holds (the reply, or the error text the step yielded).
export function recordStep(threads: Threads, key: string, body: any, assistant: any[] | undefined): void {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const base = assistant && assistant.length ? [...messages, { role: 'assistant', content: assistant }] : [...messages]
  threads.set(key, { system: body?.system, tools: Array.isArray(body?.tools) ? body.tools : undefined, base })
}

// cache_control without `scope` (a first-party field).
function cleanCache(v: any): any {
  if (!v || typeof v !== 'object' || !v.cache_control || typeof v.cache_control !== 'object') return v
  const { scope: _, ...cc } = v.cache_control
  return { ...v, cache_control: cc }
}

function cleanTool(t: any): any {
  if (!t || typeof t !== 'object') return t
  const { eager_input_streaming: _, ...rest } = t
  return cleanCache(rest)
}

function blocksOf(content: unknown): any[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? content : []
}

function cleanBlock(b: any): any {
  const c = cleanCache(b)
  if (c?.type === 'tool_result' && Array.isArray(c.content)) return { ...c, content: c.content.map(cleanCache) }
  return c
}

// A plain Messages API request: system messages folded into user text, tool
// additions/removals applied to `tools`, consecutive same-role messages
// merged (tool_result blocks first), first-party leftovers dropped.
export function normalizeBody(body: any): any {
  const tools: any[] = (Array.isArray(body?.tools) ? body.tools : []).filter((t: any) => t?.name !== PLACEHOLDER_TOOL)
  const setTool = (def: any) => {
    const i = tools.findIndex(t => t?.name === def?.name)
    if (i >= 0) tools[i] = def
    else tools.push(def)
  }

  const plain: any[] = []
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (m?.role !== 'system') {
      plain.push(m)
      continue
    }
    const text: any[] = []
    for (const b of blocksOf(m.content)) {
      if (b?.type === 'text') text.push(b)
      else if (b?.type === 'tool_addition' && b.tool?.type === 'tool_definition' && b.tool.definition?.name) setTool(b.tool.definition)
      else if (b?.type === 'tool_addition' && b.tool?.type === 'tool_reference') {
        const i = tools.findIndex(t => t?.name === b.tool.name)
        if (i >= 0 && tools[i] && 'defer_loading' in tools[i]) {
          const { defer_loading: _, ...rest } = tools[i]
          tools[i] = rest
        }
      } else if (b?.type === 'tool_removal' && b.tool?.name) {
        const i = tools.findIndex(t => t?.name === b.tool.name)
        if (i >= 0) tools.splice(i, 1)
      }
    }
    if (text.length) plain.push({ role: 'user', content: text })
  }

  const merged: any[] = []
  for (const m of plain) {
    const last = merged[merged.length - 1]
    if (last && last.role === m.role) {
      const all = [...blocksOf(last.content), ...blocksOf(m.content)]
      const results = all.filter(b => b?.type === 'tool_result')
      last.content = [...results, ...all.filter(b => b?.type !== 'tool_result')]
    } else {
      merged.push({ ...m })
    }
  }
  const messages = merged.map(m => (Array.isArray(m.content) ? { ...m, content: m.content.map(cleanBlock) } : m))

  const out: any = { ...body, messages }
  delete out.thread
  const system = stripBilling(body?.system)
  if (system === undefined) delete out.system
  else out.system = Array.isArray(system) ? system.map(cleanCache) : system
  if (tools.length) out.tools = tools.map(cleanTool)
  else delete out.tools
  return out
}
