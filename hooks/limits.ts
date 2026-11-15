// Built-in per-model limits for routed models: context window (for
// compaction, context.ts) and max output tokens (request.ts). One table,
// matched by prefix on the prefixed model id; the first matching row wins, so
// specific rows come before general ones. `custom:` models have no row: their
// window comes from the contextWindows option, their output limit is the
// default.

type Limits = { window: number; maxOutput: number }

const MODEL_LIMITS: [string, Limits][] = [
  ['openai:gpt-5-chat', { window: 128000, maxOutput: 16384 }],
  ['openai:gpt-5', { window: 400000, maxOutput: 128000 }],
  ['openai:gpt-4.1', { window: 1047576, maxOutput: 32768 }],
  ['openai:gpt-4o', { window: 128000, maxOutput: 16384 }],
  ['openai:o1-mini', { window: 128000, maxOutput: 65536 }],
  ['openai:o1', { window: 200000, maxOutput: 100000 }],
  ['openai:o3', { window: 200000, maxOutput: 100000 }],
  ['openai:o4-mini', { window: 200000, maxOutput: 100000 }],
  ['anthropic:claude-opus', { window: 200000, maxOutput: 32000 }],
  ['anthropic:claude-sonnet', { window: 200000, maxOutput: 64000 }],
  ['anthropic:claude-haiku', { window: 200000, maxOutput: 64000 }],
  ['zai:glm-4.5', { window: 128000, maxOutput: 32768 }],
  ['zai:glm', { window: 200000, maxOutput: 32768 }],
]

// Output limit for ids without a row (every custom: model): small enough for
// servers that reject a max_tokens above their model's limit.
export const DEFAULT_MAX_TOKENS = 8192

function limitsOf(model: string): Limits | undefined {
  for (const [p, l] of MODEL_LIMITS) if (model.startsWith(p)) return l
  return undefined
}

export function maxOutputTokens(model: string): number {
  return limitsOf(model)?.maxOutput ?? DEFAULT_MAX_TOKENS
}

// The context window of a prefixed model id: a contextWindows entry (exact
// id) first, then the built-in table; undefined when unknown.
export function windowFor(model: string, configured: ReadonlyMap<string, number>): number | undefined {
  return configured.get(model) ?? limitsOf(model)?.window
}
