import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicClient } from '../../src/llm/anthropic.js';

/** Captures the params sent to the SDK and returns scripted responses. */
function sdkStub(responses: Array<Partial<Anthropic.Messages.Message>>) {
  const sent: Anthropic.Messages.MessageCreateParams[] = [];
  const client = {
    messages: {
      create: async (params: Anthropic.Messages.MessageCreateParams) => {
        sent.push(structuredClone(params));
        const r = responses.shift()!;
        return { stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 }, content: [], ...r };
      },
    },
  } as unknown as Anthropic;
  return { client, sent };
}

describe('AnthropicClient', () => {
  it('maps tools, forced tool choice and the web search server tool', async () => {
    const { client, sent } = sdkStub([{ content: [{ type: 'tool_use', id: 't1', name: 'route_decision', input: { route: 'knowledge' } }] as never }]);
    const llm = new AnthropicClient('k', client);
    const res = await llm.complete({
      model: 'claude-haiku-5-5',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'route_decision', description: 'd', inputSchema: { type: 'object', properties: {} } }],
      forceTool: 'route_decision',
      webSearch: { maxUses: 2 },
    });
    expect(sent[0]).toMatchObject({
      model: 'claude-haiku-5-5',
      system: 'sys',
      tool_choice: { type: 'tool', name: 'route_decision' },
      tools: [
        { name: 'route_decision', input_schema: { type: 'object' } },
        { type: 'web_search_20250305', name: 'web_search', max_uses: 2 },
      ],
    });
    expect(res.toolCalls).toEqual([{ id: 't1', name: 'route_decision', input: { route: 'knowledge' } }]);
  });

  it('continues pause_turn responses and extracts cited web sources', async () => {
    const { client, sent } = sdkStub([
      {
        stop_reason: 'pause_turn',
        content: [{ type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://a', title: 'A' }] }] as never,
        usage: { input_tokens: 5, output_tokens: 3, server_tool_use: { web_search_requests: 1 } } as never,
      },
      { content: [{ type: 'text', text: 'Rate is 6.2', citations: [{ type: 'web_search_result_location', url: 'https://b', title: 'B', cited_text: 'x', encrypted_index: 'e' }] }] as never },
    ]);
    const res = await new AnthropicClient('k', client).complete({ model: 'm', system: 's', messages: [{ role: 'user', content: 'euro?' }], webSearch: { maxUses: 2 } });

    expect(sent).toHaveLength(2);
    expect(sent[1]!.messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect(res.text).toBe('Rate is 6.2');
    expect(res.webSources).toEqual([{ title: 'B', url: 'https://b' }]);
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 6, webSearches: 1 });
    expect(res.assistantContent).toHaveLength(2);
  });
});
