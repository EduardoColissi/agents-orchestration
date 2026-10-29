import { describe, expect, it } from 'vitest';
import { buildTestApp, kindOf, route, scriptedLLM, tokenFor } from '../helpers.js';

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
});
