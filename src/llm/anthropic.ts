import Anthropic from '@anthropic-ai/sdk';
import type { LLMClient, LLMRequest, LLMResponse, ToolCall } from './client.js';
import type { Source } from '../types.js';

const MAX_PAUSE_CONTINUATIONS = 3;

/** Claude implementation of {@link LLMClient}, including the server-side web search tool. */
export class AnthropicClient implements LLMClient {
  private readonly client: Anthropic;

  constructor(apiKey: string, client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const tools: Anthropic.Messages.ToolUnion[] = (request.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
    }));
    if (request.webSearch && request.webSearch.maxUses > 0) {
      tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: request.webSearch.maxUses });
    }

    const baseMessages = request.messages as Anthropic.Messages.MessageParam[];
    let messages = baseMessages;
    const assistantContent: Anthropic.Messages.ContentBlock[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let webSearches = 0;
    let stopReason = 'end_turn';

    // Server tools (web search) may return `pause_turn`; we continue the same turn until done.
    for (let i = 0; i <= MAX_PAUSE_CONTINUATIONS; i++) {
      const response = await this.client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens ?? 1024,
        system: request.system,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        ...(request.forceTool ? { tool_choice: { type: 'tool', name: request.forceTool } } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      });

      assistantContent.push(...response.content);
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      webSearches += response.usage.server_tool_use?.web_search_requests ?? 0;
      stopReason = response.stop_reason ?? 'end_turn';

      if (stopReason !== 'pause_turn') break;
      // Continue the same assistant turn: one assistant message with everything produced so far.
      messages = [...baseMessages, { role: 'assistant', content: [...assistantContent] }];
      const webTool = tools.find((t): t is Anthropic.Messages.WebSearchTool20250305 => 'type' in t && t.type === 'web_search_20250305');
      if (webTool && request.webSearch) webTool.max_uses = Math.max(1, request.webSearch.maxUses - webSearches);
    }

    return {
      text: assistantContent
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim(),
      toolCalls: assistantContent
        .filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use')
        .map((b): ToolCall => ({ id: b.id, name: b.name, input: b.input })),
      webSources: extractWebSources(assistantContent),
      stopReason,
      usage: { inputTokens, outputTokens, webSearches },
      assistantContent,
    };
  }
}

/** Prefer pages the answer actually cites; fall back to the top search results. */
function extractWebSources(content: Anthropic.Messages.ContentBlock[]): Source[] {
  const cited: Source[] = [];
  const results: Source[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      for (const c of block.citations ?? []) {
        if (c.type === 'web_search_result_location') cited.push({ title: c.title ?? c.url, url: c.url });
      }
    } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) results.push({ title: r.title, url: r.url });
    }
  }
  const pool = cited.length > 0 ? cited : results.slice(0, 3);
  const seen = new Set<string>();
  return pool.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
}
