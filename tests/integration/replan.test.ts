import { describe, expect, it } from 'vitest';
import { buildTestApp, kindOf, route, scriptedLLM, tokenFor } from '../helpers.js';
import { decideNext } from '../../src/orchestration/replanner.js';
import type { AgentResult } from '../../src/types.js';

const chat = async (app: Awaited<ReturnType<typeof buildTestApp>>['app'], message: string) =>
  (await app.inject({ method: 'POST', url: '/chat', headers: { authorization: await tokenFor('cliente1988') }, payload: { message } })).json();

describe('replanning: observe the specialist result, then decide (feedback gap 5)', () => {
  it('adds Knowledge when Support finds an offline machine that the Router did not plan for', async () => {
    const llm = scriptedLLM({
      router: [route({ route: 'support', plan: ['support'] })],
      support: [{ toolCalls: [{ name: 'get_terminal_status', input: {} }] }, { text: 'Your Get Smart GS-1988-0001 is offline.' }],
      knowledge: [{ toolCalls: [{ name: 'search_knowledge_base', input: { query: 'maquininha sem conexão' } }] }, { text: 'Restart it and switch to the 4G chip.' }],
    });
    const { app } = await buildTestApp(llm);
    const body = await chat(app, 'Is my card machine ok?');
    expect(body.agents).toEqual(['router', 'support', 'knowledge']);
    expect(body.replans).toEqual([{ after: 'support', signal: 'terminal_offline', action: 'add_knowledge' }]);
    // Knowledge receives the account findings of the step it was added after.
    expect(String(llm.calls.find((c) => kindOf(c) === 'knowledge')!.messages[0]!.content)).toContain('<account_findings agent="support">');
  });

  it('gives Knowledge the offline-machine guide searched in code, whatever query the model would pick', async () => {
    const llm = scriptedLLM({
      router: [route({ route: 'support', plan: ['support'] })],
      support: [{ toolCalls: [{ name: 'get_terminal_status', input: {} }] }, { text: 'Your Get Smart GS-1988-0001 is offline.' }],
      knowledge: [{ text: 'It is offline: restart it, check the Wi-Fi router and switch to the 4G chip.' }],
    });
    const { app } = await buildTestApp(llm);
    const body = await chat(app, 'Is my card machine online right now?');
    const prompt = String(llm.calls.find((c) => kindOf(c) === 'knowledge')!.messages[0]!.content);
    expect(prompt).toContain('<knowledge_base_excerpts');
    expect(prompt).toContain('Reinicie a maquininha');
    expect(body.tools_used).toContain('search_knowledge_base');
    expect(body.sources.map((s: { url: string }) => s.url)).toContain('internal://knowledge/support-playbook.md');
    expect(body.handoff.required).toBe(false);
  });

  it('a "not found" from Knowledge does not erase what Support found: no gap handoff, no unrelated sources', async () => {
    const llm = scriptedLLM({
      router: [route({ route: 'support', plan: ['support', 'knowledge'], language: 'pt' })],
      support: [{ toolCalls: [{ name: 'get_terminal_status', input: {} }] }, { text: 'Sua Get Smart GS-1988-0001 está offline: o Wi-Fi está sem sinal e o chip 4G está ativo.' }],
      knowledge: [{ toolCalls: [{ name: 'search_knowledge_base', input: { query: 'link de pagamento' } }] }, { text: 'Não encontrei essa informação no conteúdo oficial da Getnet. <<NOT_FOUND>>' }],
    });
    const t = await buildTestApp(llm);
    const body = await chat(t.app, 'Minha maquininha está offline.');
    expect(body.agents).toEqual(['router', 'support', 'knowledge']);
    expect(body.answer).toBe('Sua Get Smart GS-1988-0001 está offline: o Wi-Fi está sem sinal e o chip 4G está ativo.');
    expect(body.handoff.required).toBe(false);
    expect(body.sources).toEqual([]);
    expect(t.deps.handoffs.list()).toHaveLength(0);
  });

  it('a "not found" with nothing from Support still goes to a person', async () => {
    const llm = scriptedLLM({
      router: [route({ route: 'knowledge' })],
      knowledge: [{ toolCalls: [{ name: 'search_knowledge_base', input: { query: 'crediário' } }] }, { text: "I couldn't find this in Getnet's official content. <<NOT_FOUND>>" }],
    });
    const body = await chat((await buildTestApp(llm)).app, 'Does Getnet offer insurance for my shop?');
    expect(body.handoff).toMatchObject({ required: true, reason: 'knowledge_gap', kind: 'assist' });
  });

  it('does not replan when the result needs nothing else', async () => {
    const llm = scriptedLLM({
      router: [route({ route: 'support' })],
      support: [{ toolCalls: [{ name: 'get_settlements', input: {} }] }, { text: 'Deposited today.' }],
    });
    const { app } = await buildTestApp(llm);
    const body = await chat(app, 'When do I get paid?');
    expect(body.agents).toEqual(['router', 'support']);
    expect(body.replans).toBeUndefined();
  });

  it('escalates to a person when a support tool crashed (the answer would rest on missing data)', async () => {
    const llm = scriptedLLM({
      router: [route({ route: 'support' })],
      support: [{ toolCalls: [{ name: 'get_settlements', input: {} }] }, { text: 'I could not check your deposits.' }],
    });
    const t = await buildTestApp(llm);
    t.repo.getSettlements = async () => {
      throw new Error('settlement service down');
    };
    const body = await chat(t.app, 'When do I get paid?');
    expect(body.replans).toEqual([{ after: 'support', signal: 'tool_error', action: 'escalate' }]);
    expect(body).toMatchObject({ route: 'escalation', handoff: { required: true, reason: 'tool_error', kind: 'assist', status: 'pending' } });
  });

  it('finishes without a person when live web data is unavailable', () => {
    const knowledge = (output: string, isError: boolean): AgentResult => ({
      agent: 'knowledge', answer: 'I cannot fetch live data right now.', sources: [], toolsUsed: ['web_search'], usage: { inputTokens: 0, outputTokens: 0, webSearches: 0 }, notFound: true,
      evidence: [{ name: 'web_search', input: { query: 'euro' }, output, isError }],
    });
    expect(decideNext(['knowledge'], knowledge('Web search failed: the search provider blocked this request (bot challenge); live web data is unavailable', true))).toEqual({ after: 'knowledge', signal: 'live_data_unavailable', action: 'finish' });
    expect(decideNext(['knowledge'], knowledge('[1] Euro — https://x', false))).toBeNull();
  });

  it('a live-data question with the search blocked ends without a human handoff or the "official sources" note', async () => {
    const t = await buildTestApp(scriptedLLM({ router: [route({ route: 'knowledge' })] }));
    t.deps.orchestrator.agents.knowledge.run = async () => ({
      agent: 'knowledge',
      answer: "I can't fetch live exchange rates right now.",
      sources: [],
      toolsUsed: ['web_search'],
      usage: { inputTokens: 0, outputTokens: 0, webSearches: 0 },
      evidence: [{ name: 'web_search', input: { query: 'euro' }, output: 'Web search failed: live web data is unavailable', isError: true }],
    });
    const body = await chat(t.app, "What's the euro exchange rate today?");
    expect(body.replans).toEqual([{ after: 'knowledge', signal: 'live_data_unavailable', action: 'finish' }]);
    expect(body.handoff.required).toBe(false);
    expect(body.answer).toBe("I can't fetch live exchange rates right now.");
    expect(t.deps.handoffs.list()).toHaveLength(0);
  });
});
