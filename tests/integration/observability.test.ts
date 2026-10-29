import { describe, expect, it } from 'vitest';
import { buildTestApp, route, scriptedLLM, tokenFor } from '../helpers.js';

describe('persistent traces and metrics (feedback gap 7)', () => {
  it('stores router, agent, tool and RAG spans per turn and aggregates them for operators', async () => {
    const llm = scriptedLLM({
      router: [route({ route: 'support', plan: ['support', 'knowledge'] }), route({ route: 'escalation', plan: [] })],
      support: [{ toolCalls: [{ name: 'get_terminal_status', input: {} }] }, { text: 'Offline.' }],
      knowledge: [{ toolCalls: [{ name: 'search_knowledge_base', input: { query: 'maquininha sem internet' } }] }, { text: 'Restart it.' }],
    });
    const t = await buildTestApp(llm);
    const merchant = { authorization: await tokenFor('cliente1988') };
    const first = (await t.app.inject({ method: 'POST', url: '/chat', headers: merchant, payload: { message: 'My machine has no internet' } })).json();
    await t.app.inject({ method: 'POST', url: '/chat', headers: merchant, payload: { message: 'I want a human' } });

    const spans = t.deps.spans.forTrace(first.trace_id);
    // Two RAG spans: the offline-machine guide searched in code, then the agent's own search.
    expect(spans.map((s) => `${s.stage}:${s.name}`)).toEqual(['router:router', 'agent:support', 'tool:get_terminal_status', 'agent:knowledge', 'rag:search_knowledge_base', 'rag:search_knowledge_base', 'turn:chat']);
    expect(spans[0]).toMatchObject({ inputTokens: 10, outputTokens: 5, status: 'ok' });

    const metrics = await t.app.inject({ method: 'GET', url: '/operator/metrics', headers: { authorization: await tokenFor('op.ana', 'operator') } });
    expect(metrics.json()).toMatchObject({ turns: 2, escalation_rate: 0.5, turn_latency_ms: { p50: expect.any(Number), p95: expect.any(Number), p99: expect.any(Number) } });
    expect(metrics.json().stages.map((s: { key: string }) => s.key)).toContain('rag:search_knowledge_base');
    expect((await t.app.inject({ method: 'GET', url: '/operator/metrics', headers: merchant })).statusCode).toBe(403);
  });
});
