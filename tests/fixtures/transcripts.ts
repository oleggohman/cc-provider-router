// Captured-request fixtures: the shape of the engine's /v1/messages body for
// typical transcripts (trimmed). Used by request and adapter tests.

const firstParty = {
  metadata: { user_id: 'user_x' },
  thinking: { type: 'adaptive', display: 'omitted' },
  context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
  safeguards: {},
  output_config: { effort: 'high' },
  thread: {},
  diagnostics: {},
  stream: true,
}

const system = [{ type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } }]

const mainTools = [
  { name: 'Bash', description: 'Run a command', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
]

export const textOnly = {
  model: 'provider-router-shadow',
  max_tokens: 32000,
  system,
  tools: mainTools,
  messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>r</system-reminder>' }, { type: 'text', text: 'hello' }] }],
  ...firstParty,
}

export const toolRoundTrip = {
  ...textOnly,
  messages: [
    { role: 'user', content: 'list files' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt', is_error: false }] },
  ],
}

export const images = {
  ...textOnly,
  messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }, { type: 'text', text: 'what is this?' }] }],
}

export const documents = {
  ...textOnly,
  messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'doc body' } }, { type: 'text', text: 'summarise' }] }],
}

export const thinkingBlocks = {
  ...textOnly,
  messages: [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }, { type: 'text', text: 'a' }] },
    { role: 'user', content: 'q2' },
  ],
}

export const subagent = {
  ...textOnly,
  system: [{ type: 'text', text: 'You are the echo agent.' }],
  tools: [mainTools[1], { name: 'SubagentHandback', description: 'Hand back', input_schema: { type: 'object', properties: { message: { type: 'string' } } } }],
  messages: [{ role: 'user', content: 'do the task' }],
}

// Tool search: one deferred tool loaded by a `tool_reference`, one not.
export const deferredTools = {
  ...textOnly,
  tools: [
    ...mainTools,
    { name: 'ToolSearch', description: 'Find tools', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'WebFetch', description: 'Fetch', input_schema: { type: 'object', properties: { url: { type: 'string' } } }, defer_loading: true },
    { name: 'NotebookEdit', description: 'Edit notebook', input_schema: { type: 'object' }, defer_loading: true },
  ],
  messages: [
    { role: 'user', content: 'fetch example.com' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_s', name: 'ToolSearch', input: { query: 'select:WebFetch' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s', content: [{ type: 'tool_reference', tool_name: 'WebFetch' }] }] },
  ],
}
