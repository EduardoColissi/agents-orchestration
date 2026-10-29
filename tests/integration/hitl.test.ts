import { describe, expect, it } from 'vitest';
import { buildTestApp, kindOf, route, scriptedLLM, tokenFor } from '../helpers.js';

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;

const chat = async (t: TestApp, message: string, conversationId?: string) =>
  (await t.app.inject({ method: 'POST', url: '/chat', headers: { authorization: await tokenFor('cliente1988') }, payload: { message, ...(conversationId ? { conversation_id: conversationId } : {}) } })).json();

const asOperator = async (t: TestApp, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
  t.app.inject({ method, url, headers: { authorization: await tokenFor('op.ana', 'operator') }, ...(payload ? { payload } : {}) });

const escalate = async (t: TestApp) => {
  const body = await chat(t, 'Quero falar com um atendente');
  return { conversationId: body.conversation_id as string, handoffId: body.handoff.handoff_id as string, body };
};

describe('HITL assist: interrupt → queue → operator → resume (FR17, FR19–FR21)', () => {
  it('queues the escalation, the operator replies, and the next agent turn sees the reply', async () => {
    const llm = scriptedLLM({ router: [route({ route: 'escalation', plan: [], language: 'pt' }), route({ route: 'knowledge', language: 'pt' })], knowledge: [{ text: 'Combinado!' }] });
    const t = await buildTestApp(llm);
    const { conversationId, handoffId, body } = await escalate(t);
    expect(body.handoff).toMatchObject({ required: true, kind: 'assist', status: 'pending' });

    const queue = (await asOperator(t, 'GET', '/operator/handoffs')).json().items;
    expect(queue).toMatchObject([{ id: handoffId, kind: 'assist', reason: 'user_requested', status: 'pending', version: 1, owner_id: 'cliente1988', conversation_id: conversationId }]);
    expect((await asOperator(t, 'GET', `/operator/handoffs/${handoffId}`)).json().context.messages[0]).toMatchObject({ role: 'merchant', content: 'Quero falar com um atendente' });

    const resolved = await asOperator(t, 'POST', `/operator/handoffs/${handoffId}/resolve`, { action: 'reply', message: 'Olá! Sou a Ana. Vou te ligar em 10 minutos.', expected_version: 1 });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ handoff: { status: 'completed', resolved_by: 'op.ana' }, message: { role: 'operator' } });

    const view = (await t.app.inject({ method: 'GET', url: `/conversations/${conversationId}`, headers: { authorization: await tokenFor('cliente1988') } })).json();
    expect(view.messages.at(-1)).toMatchObject({ role: 'operator', content: 'Olá! Sou a Ana. Vou te ligar em 10 minutos.', handoff_id: handoffId });
    expect(view.open_handoff).toBeNull();

    // Control is back with the agents: the next turn's prompt contains the operator's reply.
    await chat(t, 'Ok, obrigado', conversationId);
    const routerInput = String(llm.calls.filter((c) => kindOf(c) === 'router').at(-1)!.messages[0]!.content);
    expect(routerInput).toContain('operator: Olá! Sou a Ana.');
    expect(t.deps.audit.list({ subject: handoffId }).map((a) => a.action)).toEqual(['handoff.created', 'handoff.resolved', 'handoff.completed']);
  });

  it('a second or stale resolve gets 409 and the outcome is delivered once', async () => {
    const t = await buildTestApp(scriptedLLM({ router: [route({ route: 'escalation', plan: [] })] }));
    const { conversationId, handoffId } = await escalate(t);
    const first = await asOperator(t, 'POST', `/operator/handoffs/${handoffId}/resolve`, { action: 'reject', expected_version: 1 });
    const second = await asOperator(t, 'POST', `/operator/handoffs/${handoffId}/resolve`, { action: 'reply', message: 'late', expected_version: 1 });
    expect([first.statusCode, second.statusCode]).toEqual([200, 409]);
    expect(second.json()).toMatchObject({ error: 'handoff_not_pending', status: 'completed' });
    expect(t.deps.conversations.messages(conversationId).filter((m) => m.handoffId === handoffId)).toHaveLength(1);
  });

  it('keeps one open handoff per conversation and tells the merchant it is already queued', async () => {
    const t = await buildTestApp(scriptedLLM({ router: [route({ route: 'escalation', plan: [] }), route({ route: 'escalation', plan: [] })] }));
    const { conversationId, handoffId } = await escalate(t);
    const again = await chat(t, 'Cadê o atendente?', conversationId);
    expect(again.handoff).toMatchObject({ handoff_id: handoffId, status: 'pending' });
    expect(again.answer).toContain(handoffId);
    expect(t.deps.handoffs.list()).toHaveLength(1);
  });

  it('validates the action for the kind and the role of the caller', async () => {
    const t = await buildTestApp(scriptedLLM({ router: [route({ route: 'escalation', plan: [] })] }));
    const { handoffId } = await escalate(t);
    expect((await asOperator(t, 'POST', `/operator/handoffs/${handoffId}/resolve`, { action: 'approve', expected_version: 1 })).statusCode).toBe(400);
    expect((await asOperator(t, 'POST', `/operator/handoffs/${handoffId}/resolve`, { action: 'reply', expected_version: 1 })).statusCode).toBe(400);
    const merchant = await t.app.inject({ method: 'GET', url: '/operator/handoffs', headers: { authorization: await tokenFor('cliente1988') } });
    expect(merchant.statusCode).toBe(403);
    expect((await asOperator(t, 'GET', '/operator/handoffs/HND-00000000')).statusCode).toBe(404);
  });

  it('expires a pending handoff after the TTL with a message to the merchant', async () => {
    let now = new Date('2026-10-23T15:00:00Z');
    const t = await buildTestApp(scriptedLLM({ router: [route({ route: 'escalation', plan: [] })] }), { now: () => now });
    const { conversationId, handoffId } = await escalate(t);
    now = new Date(now.getTime() + 241 * 60_000);
    expect(t.deps.hitl.sweep()).toBe(1);
    expect(t.deps.handoffs.get(handoffId)!.status).toBe('expired');
    expect(t.deps.conversations.messages(conversationId).at(-1)!.content).toContain(handoffId);
    expect((await asOperator(t, 'POST', `/operator/handoffs/${handoffId}/resolve`, { action: 'reject', expected_version: 2 })).statusCode).toBe(409);
  });

  it('completes a resolution interrupted by a crash exactly once at boot', async () => {
    const t = await buildTestApp(scriptedLLM({ router: [route({ route: 'escalation', plan: [] })] }));
    const { conversationId, handoffId } = await escalate(t);
    // Crash after the CAS, before delivery.
    t.deps.handoffs.beginResume(handoffId, 1, { action: 'reply', message: 'Resolvido!' }, 'op.ana');
    expect(await t.deps.hitl.recover()).toBe(1);
    expect(await t.deps.hitl.recover()).toBe(0);
    expect(t.deps.conversations.messages(conversationId).filter((m) => m.handoffId === handoffId).map((m) => m.content)).toEqual(['Resolvido!']);
  });

  it('operators read the evidence of a conversation; the read is audited', async () => {
    const llm = scriptedLLM({ router: [route({ route: 'support' })], support: [{ toolCalls: [{ name: 'get_terminal_status', input: {} }] }, { text: 'Your machine is offline.' }] });
    const t = await buildTestApp(llm);
    const body = await chat(t, 'Is my machine ok?');
    const trace = (await asOperator(t, 'GET', `/operator/conversations/${body.conversation_id}`)).json();
    expect(trace.messages[1].evidence).toMatchObject({ route_decision: { route: 'support' }, steps: [{ agent: 'support', tools: [{ name: 'get_terminal_status' }] }] });
    expect(trace.messages[1].evidence.steps[0].tools[0].output).toContain('GS-1988-0001');
    expect(t.deps.audit.list({ action: 'conversation.trace_read' })).toHaveLength(1);
  });
});
