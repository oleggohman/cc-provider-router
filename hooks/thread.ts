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
// turn the engine recorded (the anchor a continue builds on). `base` is
// undefined once dropped (a step failed before its request was captured, or
// a subagent's turn ended): system and tools stay, so the conversation can be
// rebuilt from the session's history (see resolveThread).
export type ThreadState = { system: unknown; tools: any[] | undefined; base: any[] | undefined }

// Thread state per loop key (`loopKeyOf` in shadow.ts).
export type Threads = Map<string, ThreadState>

// Forgets a loop's conversation, keeping its system prompt and tools.
export function dropBase(threads: Threads, key: string): void {
  const s = threads.get(key)
  if (s) threads.set(key, { ...s, base: undefined })
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

// Tools other than the placeholder: a continue with none keeps the stored set.
function hasRealTools(tools: unknown): tools is any[] {
  return Array.isArray(tools) && tools.some(t => t?.name !== PLACEHOLDER_TOOL)
}

// The history's messages up to and including its last assistant turn.
function upToLastAssistant(history: any[]): any[] {
  for (let i = history.length - 1; i >= 0; i--) if (history[i]?.role === 'assistant') return history.slice(0, i + 1)
  return []
}

export type Resolved = { ok: true; body: any } | { ok: false; message: string }

// What a continue without a known conversation can be rebuilt from: the
// session's Messages API history of the loop, and a state to take the system
// prompt and tools from when the loop has none (an engine fork of the main
// loop).
export type Recovery = { history?: any[]; fallback?: ThreadState }

const LOST =
  'the conversation so far is not known to the router (it continues a thread started before this session of the mod, e.g. after a /config change, a model switch or an interrupted step); run /clear or /compact and try again'

// The full request for this step: a create (or a body without `thread`) as
// is; a continue rebuilt from the loop's state plus the new messages, or,
// when the state holds no conversation, from the session history.
export function resolveThread(body: any, state: ThreadState | undefined, recovery: Recovery = {}): Resolved {
  if (body?.thread?.type !== 'continue') return { ok: true, body }
  const known = state ?? recovery.fallback
  const system = systemIsEmpty(body.system) ? known?.system : body.system
  const tools = hasRealTools(body.tools) ? body.tools : (known?.tools ?? body.tools)
  let base = state?.base
  if (!base && recovery.history && system !== undefined) base = upToLastAssistant(recovery.history)
  if (!base) return { ok: false, message: LOST }
  const delta = Array.isArray(body.messages) ? body.messages : []
  return { ok: true, body: { ...body, system, tools, messages: [...base, ...delta] } }
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
  capBreakpoints(out)
  return out
}

// Cache breakpoints. The engine marks each step's newest message, so a
// conversation rebuilt from state carries one per earlier step, and Anthropic
// rejects more than 4. Only the last breakpoint in the messages is kept; then,
// if tools and system still bring the total over 4, the earliest go first
// (tools come before system in the prompt). Copies, never the inputs.
const MAX_BREAKPOINTS = 4

const hasCache = (b: any): boolean => !!b && typeof b === 'object' && b.cache_control !== undefined

function noCache(b: any): any {
  const { cache_control: _, ...rest } = b
  return rest
}

function capBreakpoints(out: any): void {
  let kept = false
  // Walk backwards; the first breakpoint met is the last one, and stays.
  const keepFirstMet = (b: any): any => {
    if (!hasCache(b)) return b
    if (!kept) {
      kept = true
      return b
    }
    return noCache(b)
  }
  for (let i = out.messages.length - 1; i >= 0; i--) {
    const m = out.messages[i]
    if (!Array.isArray(m?.content)) continue
    const content = [...m.content]
    for (let j = content.length - 1; j >= 0; j--) {
      // A block's own breakpoint ends it, after its inner content.
      let b = keepFirstMet(content[j])
      if (b?.type === 'tool_result' && Array.isArray(b.content)) {
        const inner = [...b.content]
        for (let k = inner.length - 1; k >= 0; k--) inner[k] = keepFirstMet(inner[k])
        b = { ...b, content: inner }
      }
      content[j] = b
    }
    out.messages[i] = { ...m, content }
  }
  const lists = [out.tools, out.system].filter(Array.isArray) as any[][]
  let excess = lists.reduce((n, l) => n + l.filter(hasCache).length, 0) + (kept ? 1 : 0) - MAX_BREAKPOINTS
  for (const l of lists) {
    for (let i = 0; i < l.length && excess > 0; i++) {
      if (hasCache(l[i])) {
        l[i] = noCache(l[i])
        excess--
      }
    }
  }
}
