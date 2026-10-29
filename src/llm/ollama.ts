import type { LLMClient, LLMMessage, LLMRequest, LLMResponse, ToolCall, ToolResultContent, ToolSpec } from './client.js';

export interface OllamaOptions {
  /** Context window. Kept constant: a different value per request reloads the model. */
  numCtx?: number;
  /** How long the model stays loaded after a request (e.g. "30m"). */
  keepAlive?: string;
}

/**
 * Ollama adapter (local, free models such as llama3.1:8b) over the native `/api/chat`
 * endpoint. Lets the whole system run with no external API key (`LLM_PROVIDER=ollama`).
 *  - Forced tool choice uses `format` (JSON Schema, constrained decoding): the JSON content
 *    becomes the tool call, so small models cannot drift out of the schema.
 *  - Tool-call arguments are coerced against the tool schema (Llama sends `"[\"a\"]"` / `"0.9"`).
 *  - A tool call written as text (`{"name": …, "arguments": …}`) is accepted as a call.
 *  - No server-side web search: the Knowledge agent plugs in a local DuckDuckGo tool instead.
 */
export class OllamaClient implements LLMClient {
  readonly capabilities = { serverWebSearch: false, forcedToolChoice: true } as const;
  private idCounter = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly defaultModel: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: OllamaOptions = {},
  ) {}

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const specs = request.tools ?? [];
    const forced = request.forceTool ? specs.find((t) => t.name === request.forceTool) : undefined;
    const offeredTools = forced || request.toolChoice === 'none' ? [] : specs;
    const tools = offeredTools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

    const body = {
      model: request.model || this.defaultModel,
      stream: false,
      messages: [{ role: 'system', content: request.system }, ...request.messages.flatMap(toOllamaMessages)],
      ...(tools.length ? { tools } : {}),
      ...(forced ? { format: forced.inputSchema } : {}),
      ...(this.options.keepAlive ? { keep_alive: this.options.keepAlive } : {}),
      options: {
        temperature: request.temperature ?? (forced ? 0 : 0.2),
        num_predict: request.maxTokens ?? 1024,
        ...(this.options.numCtx ? { num_ctx: this.options.numCtx } : {}),
      },
    };

    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as OllamaChatResponse;

    const message = data.message ?? { role: 'assistant', content: '' };
    const byName = new Map(specs.map((t) => [t.name, t]));
    let toolCalls: ToolCall[] = (message.tool_calls ?? []).map((c) => ({
      id: `call_${++this.idCounter}`,
      name: c.function.name,
      input: coerceArgs(c.function.arguments ?? {}, byName.get(c.function.name)),
    }));
    let text = (message.content ?? '').trim();

    if (forced && toolCalls.length === 0) {
      const parsed = extractJsonObject(text);
      if (parsed) {
        toolCalls = [{ id: `call_${++this.idCounter}`, name: forced.name, input: coerceArgs(parsed, forced) }];
        text = '';
      }
    } else if (toolCalls.length === 0 && offeredTools.length > 0) {
      const written = parseWrittenToolCall(text, byName);
      if (written) {
        toolCalls = [{ id: `call_${++this.idCounter}`, ...written }];
        text = '';
      }
    }

    const echoed: OllamaMessage = toolCalls.length
      ? { role: 'assistant', content: '', tool_calls: toolCalls.map((c) => ({ function: { name: c.name, arguments: c.input as Record<string, unknown> } })) }
      : { role: 'assistant', content: text };
    return {
      text,
      toolCalls,
      webSources: [],
      stopReason: toolCalls.length ? 'tool_use' : 'end_turn',
      usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0, webSearches: 0 },
      // Plain JSON, echoed back verbatim by the tool loop (and storable in an HITL checkpoint).
      assistantContent: [{ type: 'ollama_message', message: echoed, toolCalls }],
    };
  }
}

interface OllamaToolCall {
  function: { name: string; arguments?: Record<string, unknown> };
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaChatResponse {
  message?: OllamaMessage;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface EchoedAssistant {
  type: 'ollama_message';
  message: OllamaMessage;
  toolCalls: ToolCall[];
}

/** Maps our provider-neutral messages to Ollama's chat format. */
function toOllamaMessages(m: LLMMessage): OllamaMessage[] {
  if (m.role === 'user') {
    if (typeof m.content === 'string') return [{ role: 'user', content: m.content }];
    return m.content.map((r: ToolResultContent) => ({ role: 'tool', content: r.content, tool_name: toolNameFor(r.tool_use_id) }));
  }
  if (typeof m.content === 'string') return [{ role: 'assistant', content: m.content }];
  const echoed = m.content.filter((b): b is EchoedAssistant => (b as EchoedAssistant)?.type === 'ollama_message');
  for (const e of echoed) for (const c of e.toolCalls) toolNames.set(c.id, c.name);
  return echoed.map((e) => e.message);
}

/** Ollama tool results carry the tool name, not an id; remember the mapping per call id. */
const toolNames = new Map<string, string>();
const toolNameFor = (id: string) => toolNames.get(id) ?? 'tool';

/** Parses string values that the schema says are not strings (`"[\"a\"]"` → `["a"]`, `"0.9"` → 0.9). */
export function coerceArgs(args: Record<string, unknown>, spec?: ToolSpec): Record<string, unknown> {
  const properties = (spec?.inputSchema.properties ?? {}) as Record<string, { type?: string | string[] }>;
  const out: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(args)) {
    const type = properties[key]?.type;
    if (typeof value !== 'string' || type === undefined || type === 'string' || (Array.isArray(type) && type.includes('string'))) continue;
    try {
      out[key] = JSON.parse(value);
    } catch {
      // Keep the original value: schema validation will report it.
    }
  }
  return out;
}

function parseWrittenToolCall(text: string, byName: Map<string, ToolSpec>): Omit<ToolCall, 'id'> | null {
  const parsed = extractJsonObject(text);
  const name = typeof parsed?.name === 'string' ? parsed.name : null;
  const spec = name ? byName.get(name) : undefined;
  if (!parsed || !spec) return null;
  const args = (parsed.arguments ?? parsed.parameters ?? {}) as Record<string, unknown>;
  return { name: spec.name, input: coerceArgs(typeof args === 'object' && args ? args : {}, spec) };
}

export function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(fenced.slice(start, end + 1)) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
