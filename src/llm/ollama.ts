import type { LLMClient, LLMMessage, LLMRequest, LLMResponse, ToolCall, ToolResultContent } from './client.js';

/**
 * Ollama adapter (local, free models such as qwen2.5:7b or llama3.1:8b) over the native
 * `/api/chat` endpoint with tool calling. Lets the whole system run with no external API
 * key (`LLM_PROVIDER=ollama`). No server-side web search and no forced tool choice, so:
 *  - the Knowledge agent plugs in a local DuckDuckGo tool instead (see agents/webSearchTool.ts);
 *  - `forceTool` is emulated: the tool is required in the prompt, and a JSON answer written
 *    as text is accepted as the tool call.
 */
export class OllamaClient implements LLMClient {
  readonly capabilities = { serverWebSearch: false, forcedToolChoice: false } as const;
  private idCounter = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly defaultModel: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const tools = (request.tools ?? []).map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    const system = request.forceTool
      ? `${request.system}\n\nYou MUST answer by calling the tool "${request.forceTool}" exactly once. Never answer with plain text.`
      : request.system;

    const body = {
      model: request.model || this.defaultModel,
      stream: false,
      messages: [{ role: 'system', content: system }, ...request.messages.flatMap(toOllamaMessages)],
      ...(tools.length ? { tools } : {}),
      options: { temperature: request.temperature ?? 0.2, num_predict: request.maxTokens ?? 1024 },
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
    let toolCalls: ToolCall[] = (message.tool_calls ?? []).map((c) => ({
      id: `call_${++this.idCounter}`,
      name: c.function.name,
      input: c.function.arguments ?? {},
    }));
    let text = (message.content ?? '').trim();

    // Emulated forced tool choice: accept a JSON object written as text.
    if (request.forceTool && toolCalls.length === 0) {
      const parsed = extractJsonObject(text);
      if (parsed) {
        toolCalls = [{ id: `call_${++this.idCounter}`, name: request.forceTool, input: parsed }];
        text = '';
      }
    }

    return {
      text,
      toolCalls,
      webSources: [],
      stopReason: toolCalls.length ? 'tool_use' : 'end_turn',
      usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0, webSearches: 0 },
      // Echoed back verbatim by the tool loop (see toOllamaMessages).
      assistantContent: [{ type: 'ollama_message', message: { ...message, tool_calls: message.tool_calls ?? [] }, toolCalls }],
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
