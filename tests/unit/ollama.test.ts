import { describe, expect, it } from 'vitest';
import { OllamaClient, extractJsonObject } from '../../src/llm/ollama.js';
import { runToolLoop, type AgentTool } from '../../src/agents/toolLoop.js';
import { parseDuckDuckGo, createWebSearchTool } from '../../src/agents/webSearchTool.js';

function fetchStub(responses: unknown[]) {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const next = responses.shift();
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, sent };
}

describe('OllamaClient', () => {
  it('maps tools and messages to /api/chat and reads native tool calls', async () => {
    const { impl, sent } = fetchStub([
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_settlements', arguments: { sale_date: '2026-10-22' } } }] }, prompt_eval_count: 50, eval_count: 10 },
    ]);
    const llm = new OllamaClient('http://ollama:11434/', 'qwen2.5:7b', impl);
    const res = await llm.complete({
      model: '',
      system: 'sys',
      messages: [{ role: 'user', content: 'when?' }],
      tools: [{ name: 'get_settlements', description: 'd', inputSchema: { type: 'object', properties: {} } }],
    });
    expect(sent[0]!.url).toBe('http://ollama:11434/api/chat');
    expect(sent[0]!.body).toMatchObject({ model: 'qwen2.5:7b', stream: false, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'when?' }] });
    expect((sent[0]!.body.tools as unknown[])[0]).toMatchObject({ type: 'function', function: { name: 'get_settlements' } });
    expect(res.toolCalls).toEqual([{ id: expect.any(String), name: 'get_settlements', input: { sale_date: '2026-10-22' } }]);
    expect(res.usage).toEqual({ inputTokens: 50, outputTokens: 10, webSearches: 0 });
    expect(llm.capabilities).toEqual({ serverWebSearch: false, forcedToolChoice: false });
  });

  it('emulates forced tool choice by accepting a JSON answer written as text', async () => {
    const { impl, sent } = fetchStub([{ message: { role: 'assistant', content: 'Here you go:\n```json\n{"route":"support","plan":["support"],"confidence":0.9,"language":"en","reason":"r"}\n```' } }]);
    const llm = new OllamaClient('http://ollama:11434', 'm', impl);
    const res = await llm.complete({ model: 'm', system: 'sys', messages: [{ role: 'user', content: 'q' }], tools: [{ name: 'route_decision', description: '', inputSchema: {} }], forceTool: 'route_decision' });
    expect(String((sent[0]!.body.messages as Array<{ content: string }>)[0]!.content)).toContain('MUST answer by calling the tool "route_decision"');
    expect(res.toolCalls[0]).toMatchObject({ name: 'route_decision', input: { route: 'support' } });
    expect(res.text).toBe('');
  });

  it('echoes assistant tool calls and tool results in Ollama format across a tool loop', async () => {
    const { impl, sent } = fetchStub([
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'echo', arguments: { v: 1 } } }] } },
      { message: { role: 'assistant', content: 'done' } },
    ]);
    const echo: AgentTool = { spec: { name: 'echo', description: '', inputSchema: {} }, execute: async (i) => ({ content: JSON.stringify(i) }) };
    const result = await runToolLoop({ llm: new OllamaClient('http://o', 'm', impl), model: 'm', system: 's', userMessage: 'q', tools: [echo], maxIterations: 3 });
    expect(result.text).toBe('done');
    const second = sent[1]!.body.messages as Array<Record<string, unknown>>;
    expect(second[2]).toMatchObject({ role: 'assistant', tool_calls: [{ function: { name: 'echo' } }] });
    expect(second[3]).toMatchObject({ role: 'tool', content: '{"v":1}', tool_name: 'echo' });
  });

  it('extracts JSON objects from plain or fenced text', () => {
    expect(extractJsonObject('x {"a":1} y')).toEqual({ a: 1 });
    expect(extractJsonObject('```json\n{"a":[1]}\n```')).toEqual({ a: [1] });
    expect(extractJsonObject('no json')).toBeNull();
  });
});

describe('local web search tool', () => {
  const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fcambio&rut=1">Cotação do euro hoje</a><a class="result__snippet">Euro a R$ 6,20</a></div>
  <div class="result"><a class="result__a" href="https://b.com/">B</a><div class="result__snippet">snippet b</div></div>`;

  it('parses DuckDuckGo results and decodes redirect links', () => {
    expect(parseDuckDuckGo(html)).toEqual([
      { url: 'https://example.com/cambio', title: 'Cotação do euro hoje', snippet: 'Euro a R$ 6,20' },
      { url: 'https://b.com/', title: 'B', snippet: 'snippet b' },
    ]);
  });

  it('returns numbered results with sources and enforces the budget', async () => {
    const tool = createWebSearchTool(async () => parseDuckDuckGo(html), 1);
    const out = await tool.execute({ query: 'euro hoje' });
    expect(out.content).toContain('[1] Cotação do euro hoje — https://example.com/cambio');
    expect(out.sources?.[0]).toEqual({ title: 'Cotação do euro hoje', url: 'https://example.com/cambio' });
    expect((await tool.execute({ query: 'again' })).isError).toBe(true);
  });
});
