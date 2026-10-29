import { describe, expect, it } from 'vitest';
import { FakeLLM } from '../../src/llm/fake.js';
import { runToolLoop, type AgentTool } from '../../src/agents/toolLoop.js';

const echoTool: AgentTool = {
  spec: { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { v: { type: 'string' } } } },
  execute: async (input) => ({ content: JSON.stringify(input), sources: [{ title: 'Doc', url: 'https://x/doc' }] }),
};

describe('runToolLoop', () => {
  it('executes a tool call and feeds the result back to the model', async () => {
    const llm = new FakeLLM([
      { toolCalls: [{ name: 'echo', input: { v: 'hi' } }] },
      { text: 'done' },
    ]);
    const result = await runToolLoop({ llm, model: 'm', system: 's', userMessage: 'q', tools: [echoTool], maxIterations: 3 });

    expect(result.text).toBe('done');
    expect(result.toolsUsed).toEqual(['echo']);
    expect(result.sources).toEqual([{ title: 'Doc', url: 'https://x/doc' }]);
    // Second call must contain the assistant tool_use + the user tool_result.
    const second = llm.calls[1]!;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[2]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', content: '{"v":"hi"}' }] });
  });

  it('reports unknown tools as errors instead of crashing', async () => {
    const llm = new FakeLLM([{ toolCalls: [{ name: 'nope', input: {} }] }, { text: 'ok' }]);
    const result = await runToolLoop({ llm, model: 'm', system: 's', userMessage: 'q', tools: [], maxIterations: 3 });
    expect(result.text).toBe('ok');
    expect(llm.calls[1]!.messages[2]).toMatchObject({ content: [{ is_error: true }] });
  });

  it('enforces the web search budget across iterations, not per API call', async () => {
    const llm = new FakeLLM([
      { toolCalls: [{ name: 'echo', input: {} }], webSearches: 2 },
      { text: 'done' },
    ]);
    await runToolLoop({ llm, model: 'm', system: 's', userMessage: 'q', tools: [echoTool], webSearch: { maxUses: 2 }, maxIterations: 3 });
    expect(llm.calls[0]!.webSearch).toEqual({ maxUses: 2 });
    // Budget spent: declared with max 1 only so earlier search blocks can be replayed.
    expect(llm.calls[1]!.webSearch).toEqual({ maxUses: 1 });
  });

  it('stops at the iteration limit', async () => {
    const llm = new FakeLLM(() => ({ toolCalls: [{ name: 'echo', input: {} }] }));
    const result = await runToolLoop({ llm, model: 'm', system: 's', userMessage: 'q', tools: [echoTool], maxIterations: 2 });
    expect(result.hitIterationLimit).toBe(true);
    expect(llm.calls).toHaveLength(2);
  });
});
