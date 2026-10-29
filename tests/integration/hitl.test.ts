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
    const llm = scriptedLLM({ router: [route({ route: 'support' })], support: [{ toolCalls: [{ name: 'get_terminal_status', input: {} }] }, { text: 'Your machine is offline.' }], knowledge: [{ text: 'Restart it.' }] });
    const t = await buildTestApp(llm);
    const body = await chat(t, 'Is my machine ok?');
    const trace = (await asOperator(t, 'GET', `/operator/conversations/${body.conversation_id}`)).json();
    expect(trace.messages[1].evidence).toMatchObject({ route_decision: { route: 'support' } });
    expect(trace.messages[1].evidence.steps[0]).toMatchObject({ agent: 'support', tools: [{ name: 'get_terminal_status' }] });
    expect(trace.messages[1].evidence.steps[0].tools[0].output).toContain('GS-1988-0001');
    expect(t.deps.audit.list({ action: 'conversation.trace_read' })).toHaveLength(1);
  });
});

describe('HITL approval: gated action → checkpoint → operator → resume (FR18–FR20)', () => {
  const replacementScript = (afterDecision: string) =>
    scriptedLLM({
      router: [route({ route: 'support', language: 'pt' })],
      support: [
        { toolCalls: [{ name: 'get_terminal_status', input: {} }] },
        { toolCalls: [{ name: 'request_terminal_replacement', input: { serial: 'GS-1988-0001', reason: 'offline for days' } }] },
        { text: afterDecision },
      ],
    });
  const requestReplacement = async (t: TestApp) => {
    const body = await chat(t, 'Minha Get Smart GS-1988-0001 está offline faz dias, quero trocar por uma nova');
    return { body, conversationId: body.conversation_id as string, handoffId: body.handoff.handoff_id as string };
  };

  it('stops before the gated tool: an approval handoff, and no ticket yet', async () => {
    const t = await buildTestApp(replacementScript('unused'));
    const { body, handoffId } = await requestReplacement(t);
    expect(body.handoff).toMatchObject({ required: true, reason: 'approval_required', kind: 'approval', status: 'pending' });
    expect(body.answer).toContain('GS-1988-0001');
    expect(body.answer).toContain(handoffId);
    expect(t.repo.listTickets()).toHaveLength(0);
    const queued = (await asOperator(t, 'GET', `/operator/handoffs/${handoffId}`)).json();
    expect(queued.request.proposed_action).toEqual({ tool: 'request_terminal_replacement', input: { serial: 'GS-1988-0001', reason: 'offline for days' } });
  });

  it('approve: the action runs once and the agent continues from the checkpoint', async () => {
    const t = await buildTestApp(replacementScript('Pronto! A troca foi aprovada e a nova maquininha será enviada.'));
    const { conversationId, handoffId } = await requestReplacement(t);
    const res = await asOperator(t, 'POST', `/operator/handoffs/${handoffId}/resolve`, { action: 'approve', message: 'Troca aprovada.', expected_version: 1 });
    expect(res.statusCode).toBe(200);

    const tickets = t.repo.listTickets('cliente1988');
    expect(tickets).toMatchObject([{ category: 'terminal_replacement' }]);
    const final = t.deps.conversations.messages(conversationId).at(-1)!;
    expect(final).toMatchObject({ role: 'assistant', handoffId });
    expect(final.content).toContain('Pronto! A troca foi aprovada');
    expect(final.content).toContain(tickets[0]!.id);

    // Resumed from the checkpoint: the earlier tool call is replayed as history, not executed again.
    const resumeCall = t.llm.calls.filter((c) => kindOf(c) === 'support').at(-1)!;
    expect(resumeCall.messages).toHaveLength(5);
    expect(JSON.stringify(resumeCall.messages.at(-1))).toContain('approved_by_operator');
    expect(resumeCall.tools!.map((x) => x.name)).not.toContain('request_terminal_replacement');
    expect(t.deps.audit.list({ action: 'approval.executed' })).toHaveLength(1);

    // Exactly once: a second resolve is refused and a repeated delivery changes nothing.
    expect((await asOperator(t, 'POST', `/operator/handoffs/${handoffId}/resolve`, { action: 'approve', expected_version: 2 })).statusCode).toBe(409);
    await t.deps.hitl.deliver(t.deps.handoffs.get(handoffId)!);
    expect(t.repo.listTickets()).toHaveLength(1);
    expect(t.deps.conversations.messages(conversationId).filter((m) => m.handoffId === handoffId)).toHaveLength(1);
  });

  it('reject: nothing is executed and the agent explains the refusal', async () => {
    const t = await buildTestApp(replacementScript('Entendi: a troca não foi aprovada porque a máquina voltou a se comunicar.'));
    const { conversationId, handoffId } = await requestReplacement(t);
    await asOperator(t, 'POST', `/operator/handoffs/${handoffId}/resolve`, { action: 'reject', message: 'A máquina voltou a se comunicar.', expected_version: 1 });
    expect(t.repo.listTickets()).toHaveLength(0);
    expect(JSON.stringify(t.llm.calls.at(-1)!.messages.at(-1))).toContain('Reason: A máquina voltou a se comunicar.');
    expect(t.deps.conversations.messages(conversationId).at(-1)!.content).toContain('não foi aprovada');
  });

  it('a checkpoint from another provider/model is not replayed: deterministic answer, action still once', async () => {
    const t = await buildTestApp(replacementScript('unused'));
    const { conversationId, handoffId } = await requestReplacement(t);
    t.deps.db.prepare("UPDATE handoffs SET checkpoint = json_set(checkpoint, '$.provider', 'anthropic') WHERE id = ?").run(handoffId);
    const callsBefore = t.llm.calls.length;
    await asOperator(t, 'POST', `/operator/handoffs/${handoffId}/resolve`, { action: 'approve', expected_version: 1 });
    expect(t.llm.calls.length).toBe(callsBefore);
    const ticket = t.repo.listTickets()[0]!;
    expect(t.deps.conversations.messages(conversationId).at(-1)!.content).toContain(ticket.id);
  });

  it('an expired approval never executes', async () => {
    let now = new Date('2026-10-23T15:00:00Z');
    const t = await buildTestApp(replacementScript('unused'), { now: () => now });
    const { handoffId } = await requestReplacement(t);
    now = new Date(now.getTime() + 241 * 60_000);
    t.deps.hitl.sweep();
    expect((await asOperator(t, 'POST', `/operator/handoffs/${handoffId}/resolve`, { action: 'approve', expected_version: 2 })).statusCode).toBe(409);
    expect(t.repo.listTickets()).toHaveLength(0);
  });

describe('approval guard rails', () => {
  it('the replacement tool is not offered when the merchant did not ask for a new machine', async () => {
    const llm = scriptedLLM({ router: [route({ route: 'support', plan: ['support', 'knowledge'] })], support: [{ text: 'Offline.' }], knowledge: [{ text: 'Restart it.' }] });
    const t = await buildTestApp(llm);
    await chat(t, 'My card machine will not connect to the internet');
    expect(llm.calls.find((c) => kindOf(c) === 'support')!.tools!.map((x) => x.name)).not.toContain('request_terminal_replacement');
  });

  it('answers in the language of the message even if the Router says otherwise', async () => {
    const t = await buildTestApp(scriptedLLM({ router: [route({ route: 'escalation', plan: [], language: 'pt' })] }));
    const body = await chat(t, 'I would like to talk to a person please');
    expect(body.answer).toContain("I've handed your request");
  });
});

  it('explicit replacement request: when the model only answers, a constrained call proposes the gated action', async () => {
    const llm = scriptedLLM({
      router: [route({ route: 'support', plan: ['support'], language: 'pt' })],
      support: [
        { toolCalls: [{ name: 'get_terminal_status', input: {} }] },
        { text: 'Sua máquina está offline. Tente reiniciar.' },
        { toolCalls: [{ name: 'request_terminal_replacement', input: { serial: 'GS-1988-0001', reason: 'offline for days' } }] },
      ],
    });
    const t = await buildTestApp(llm);
    const body = await chat(t, 'Minha Get Smart GS-1988-0001 está offline faz dias, quero trocar por uma nova');
    expect(body.handoff).toMatchObject({ kind: 'approval', status: 'pending' });
    expect(llm.calls.at(-1)!.forceTool).toBe('request_terminal_replacement');
    expect(t.repo.listTickets()).toHaveLength(0);
  });

describe('HITL robustness (post-clock review)', () => {
  it('an overdue approval cannot be approved before the sweeper runs (409 handoff_expired, nothing executed)', async () => {
    let now = new Date('2026-10-23T15:00:00Z');
    const llm = scriptedLLM({
      router: [route({ route: 'support', language: 'pt' })],
      support: [{ toolCalls: [{ name: 'request_terminal_replacement', input: { serial: 'GS-1988-0001', reason: 'offline for days' } }] }],
    });
    const t = await buildTestApp(llm, { now: () => now });
    const body = await chat(t, 'Quero trocar minha maquininha GS-1988-0001 por uma nova');
    now = new Date(now.getTime() + 241 * 60_000);
    const res = await asOperator(t, 'POST', `/operator/handoffs/${body.handoff.handoff_id}/resolve`, { action: 'approve', expected_version: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'handoff_expired', status: 'expired' });
    expect(t.repo.listTickets()).toHaveLength(0);
  });

  it('a delivery that fails keeps the decision and is retried by the periodic tick', async () => {
    const t = await buildTestApp(scriptedLLM({ router: [route({ route: 'escalation', plan: [] })] }));
    const { conversationId, handoffId } = await escalate(t);
    const original = t.deps.conversations.addMessage.bind(t.deps.conversations);
    let fail = true;
    t.deps.conversations.addMessage = (m) => {
      if (fail && m.handoffId) throw new Error('disk full');
      return original(m);
    };
    const res = await asOperator(t, 'POST', `/operator/handoffs/${handoffId}/resolve`, { action: 'reply', message: 'Oi!', expected_version: 1 });
    expect(res.statusCode).toBe(503);
    expect(t.deps.handoffs.get(handoffId)!.status).toBe('resuming');
    fail = false;
    await t.deps.hitl.tick(0);
    expect(t.deps.handoffs.get(handoffId)!.status).toBe('completed');
    expect(t.deps.conversations.messages(conversationId).at(-1)!.content).toBe('Oi!');
  });

  it('a merchant token cannot resolve handoffs nor read conversation evidence', async () => {
    const t = await buildTestApp(scriptedLLM({ router: [route({ route: 'escalation', plan: [] })] }));
    const { conversationId, handoffId } = await escalate(t);
    const merchant = { authorization: await tokenFor('cliente1988') };
    expect((await t.app.inject({ method: 'POST', url: `/operator/handoffs/${handoffId}/resolve`, headers: merchant, payload: { action: 'reject', expected_version: 1 } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: `/operator/conversations/${conversationId}`, headers: merchant })).statusCode).toBe(403);
  });
});

describe('approval proposals are checked against the merchant data', () => {
  it("a proposal for a serial the merchant does not have is not queued", async () => {
    const llm = scriptedLLM({
      router: [route({ route: 'support', language: 'pt' })],
      support: [{ toolCalls: [{ name: 'request_terminal_replacement', input: { serial: 'GC-2000-0001', reason: 'offline for days' } }] }],
    });
    const t = await buildTestApp(llm);
    const body = await chat(t, 'Quero trocar minha maquininha GC-2000-0001 por uma nova');
    expect(body.handoff.required).toBe(false);
    expect(body.answer).toContain('Não encontrei a maquininha GC-2000-0001');
    expect(t.deps.handoffs.list()).toHaveLength(0);
  });
});

describe('replacement proposal after a failed attempt', () => {
  it('still proposes the replacement when the model first called the tool with invalid input and gave up', async () => {
    const llm = scriptedLLM({
      router: [route({ route: 'support', plan: ['support'], language: 'pt' })],
      support: [
        { toolCalls: [{ name: 'request_terminal_replacement', input: { terminal_id: 'GS-1988-0001' } }] },
        { text: 'Não consegui pedir a troca.' },
        { toolCalls: [{ name: 'request_terminal_replacement', input: { serial: 'GS-1988-0001', reason: 'offline for days' } }] },
      ],
    });
    const t = await buildTestApp(llm);
    const body = await chat(t, 'Minha Get Smart GS-1988-0001 está offline faz dias, quero trocar por uma nova');
    expect(body.handoff).toMatchObject({ kind: 'approval', status: 'pending' });
  });
});

describe('slow resumes', () => {
  it('the periodic tick never starts a second delivery while a slow resume is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const llm = scriptedLLM({
      router: [route({ route: 'support', language: 'pt' })],
      support: [
        { toolCalls: [{ name: 'request_terminal_replacement', input: { serial: 'GS-1988-0001', reason: 'offline for days' } }] },
        { text: 'Troca aprovada!' },
      ],
    });
    const t = await buildTestApp(llm);
    const body = await chat(t, 'Quero trocar minha maquininha GS-1988-0001 por uma nova');
    const original = llm.complete.bind(llm);
    llm.complete = async (req) => (await gate, original(req));
    const resolving = asOperator(t, 'POST', `/operator/handoffs/${body.handoff.handoff_id}/resolve`, { action: 'approve', expected_version: 1 });
    await new Promise((r) => setTimeout(r, 20));
    await Promise.all([t.deps.hitl.tick(0), t.deps.hitl.tick(0)]);
    release();
    expect((await resolving).statusCode).toBe(200);
    expect(t.deps.audit.list({ action: 'approval.executed' })).toHaveLength(1);
    expect(t.repo.listTickets()).toHaveLength(1);
  });
});

describe('approval outcome', () => {
  const approve = async (resumedText: string) => {
    const llm = scriptedLLM({
      router: [route({ route: 'support', language: 'pt' })],
      support: [{ toolCalls: [{ name: 'request_terminal_replacement', input: { serial: 'GS-1988-0001', reason: 'offline for days' } }] }, { text: resumedText }],
    });
    const t = await buildTestApp(llm);
    const body = await chat(t, 'Quero trocar minha maquininha GS-1988-0001 por uma nova');
    await asOperator(t, 'POST', `/operator/handoffs/${body.handoff.handoff_id}/resolve`, { action: 'approve', expected_version: 1 });
    const trace = (await asOperator(t, 'GET', `/operator/conversations/${body.conversation_id}`)).json();
    return { t, final: trace.messages.at(-1), ticket: t.repo.listTickets()[0]! };
  };

  it('a resumed answer that contradicts the approval is replaced by the decision and the ticket', async () => {
    const { final, ticket } = await approve('Seu pedido de troca será analisado e aprovado pela nossa equipe em breve.');
    expect(final.content).toContain('aprovada');
    expect(final.content).toContain(ticket.id);
    expect(final.content).not.toContain('será analisado');
  });

  it('the resumed run is stored as evidence of the outcome message', async () => {
    const { final } = await approve('Troca aprovada! Já abrimos o chamado.');
    expect(final.evidence).toMatchObject({ resumed_from: expect.stringMatching(/^HND-/), steps: [{ agent: 'support', tools: [{ name: 'request_terminal_replacement', isError: false }] }] });
    expect(final.evidence.steps[0].tools[0].output).toContain('approved_by_operator');
  });
});
});
