import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MockCustomerRepository } from '../../src/support/mockRepository.js';
import { createSupportTools } from '../../src/support/tools.js';
import { addBusinessDays, relativeDay } from '../../src/support/dates.js';

const data = JSON.parse(readFileSync('data/customers.json', 'utf8'));
// Friday 2026-10-23, 12:00 in São Paulo.
const now = () => new Date('2026-10-23T15:00:00Z');
const repo = () => new MockCustomerRepository(data, now);

const toolMap = (r: MockCustomerRepository, userId: string) =>
  Object.fromEntries(createSupportTools(r, userId, now).map((t) => [t.spec.name, t]));

describe('dates', () => {
  it('skips weekends when adding business days', () => {
    expect(addBusinessDays('2026-10-23', 1)).toBe('2026-10-26'); // Fri -> Mon
    expect(addBusinessDays('2026-10-22', 1)).toBe('2026-10-23'); // Thu -> Fri
    expect(addBusinessDays('2026-10-22', 0)).toBe('2026-10-22');
  });

  it('names a date relative to today', () => {
    expect(relativeDay('2026-10-23', '2026-10-23')).toBe('today');
    expect(relativeDay('2026-10-24', '2026-10-23')).toBe('tomorrow');
    expect(relativeDay('2026-10-22', '2026-10-23')).toBe('yesterday');
    expect(relativeDay('2026-10-26', '2026-10-23')).toBe('in 3 days');
    expect(relativeDay('2026-10-20', '2026-10-23')).toBe('3 days ago');
  });
});

describe('MockCustomerRepository', () => {
  it('materializes relative dates against the clock', async () => {
    const txs = await repo().getTransactions('cliente1988', { lastDays: 1 });
    expect(txs.every((t) => t.date === '2026-10-23' || t.date === '2026-10-22')).toBe(true);
  });

  it("groups yesterday's approved sales into settlements by payment method", async () => {
    const settlements = await repo().getSettlements('cliente1988', { saleDate: '2026-10-22' });
    const credit = settlements.find((s) => s.method === 'credit')!;
    expect(credit.grossAmount).toBe(438.9); // 128.90 + 310.00 (declined TX-1005 excluded)
    expect(credit.expectedDate).toBe('2026-10-23');
    expect(credit.status).toBe('scheduled');
    expect(settlements.find((s) => s.method === 'pix')!.status).toBe('paid');
  });

  it('returns null / empty for unknown customers', async () => {
    expect(await repo().getCustomer('ghost')).toBeNull();
    expect(await repo().getTransactions('ghost')).toEqual([]);
  });
});

describe('support tools', () => {
  it('exposes the support tools, with the replacement gated behind approval (FR4, FR18)', () => {
    expect(Object.keys(toolMap(repo(), 'cliente1988')).sort()).toEqual(
      ['create_support_ticket', 'get_customer_profile', 'get_settlements', 'get_terminal_status', 'get_transactions', 'request_terminal_replacement'],
    );
    expect(Object.values(toolMap(repo(), 'cliente1988')).filter((t) => t.requiresApproval).map((t) => t.spec.name)).toEqual(['request_terminal_replacement']);
  });

  it('enriches declined transactions with code meaning and action', async () => {
    const out = await toolMap(repo(), 'cliente1988').get_transactions!.execute({ status: 'declined' });
    const body = JSON.parse(out.content);
    expect(body.count).toBe(2);
    expect(body.transactions[0].decline.meaning).toMatch(/issuer/i);
  });

  it('reports terminal diagnostics', async () => {
    const out = await toolMap(repo(), 'cliente1988').get_terminal_status!.execute({});
    expect(JSON.parse(out.content).terminals[0]).toMatchObject({ status: 'offline', model: 'Get Smart' });
  });

  it('is bound to the request user and cannot read another customer (FR6)', async () => {
    const tools = toolMap(repo(), 'cliente1988');
    // Even if the model tries to pass another user id, the schema ignores it and the bound id is used.
    const out = await tools.get_customer_profile!.execute({ user_id: 'cliente2000' });
    expect(JSON.parse(out.content).userId).toBe('cliente1988');
  });

  it('labels settlement days relative to today in code, so the model does not swap today and tomorrow', async () => {
    const out = await toolMap(repo(), 'cliente1988').get_settlements!.execute({ sale_date: '2026-10-22' });
    const days = Object.fromEntries(JSON.parse(out.content).settlements.map((s: { method: string; expectedDay: string }) => [s.method, s.expectedDay]));
    expect(days).toEqual({ debit: 'Friday 2026-10-23, today', credit: 'Friday 2026-10-23, today', pix: 'Thursday 2026-10-22, yesterday' });
    expect(JSON.parse(out.content).summary).toEqual(expect.arrayContaining([
      'pix 27.00: already deposited on Thursday 2026-10-22, yesterday',
      'credit 438.90: to be deposited on Friday 2026-10-23, today',
    ]));
  });

  it('rejects invalid input instead of throwing', async () => {
    const out = await toolMap(repo(), 'cliente1988').get_settlements!.execute({ sale_date: 'yesterday' });
    expect(out.isError).toBe(true);
  });

  it('creates tickets for the bound user', async () => {
    const r = repo();
    const out = await toolMap(r, 'cliente1988').create_support_ticket!.execute({ category: 'connectivity', summary: 'Machine offline after restart' });
    expect(JSON.parse(out.content).ticket_id).toMatch(/^TCK-/);
    expect(r.listTickets('cliente1988')).toHaveLength(1);
  });

  it('request_terminal_replacement accepts a wrapped serial of the bound merchant only, and is idempotent by key', async () => {
    const r = repo();
    const own = toolMap(r, 'cliente1988').request_terminal_replacement!;
    const first = JSON.parse((await own.execute({ serial: 'Get Smart GS-1988-0001', reason: 'offline for days' }, { idempotencyKey: 'HND-1' })).content);
    const again = JSON.parse((await own.execute({ serial: 'GS-1988-0001', reason: 'offline for days' }, { idempotencyKey: 'HND-1' })).content);
    expect(first).toMatchObject({ serial: 'GS-1988-0001', ticket_id: expect.stringMatching(/^TCK-/) });
    expect(again.ticket_id).toBe(first.ticket_id);
    expect(r.listTickets()).toHaveLength(1);
    const other = await toolMap(r, 'cliente2000').request_terminal_replacement!.execute({ serial: 'GS-1988-0001', reason: 'not mine at all' });
    expect(other.isError).toBe(true);
  });

  it('detects a request for a new machine, not for other things merchants replace', async () => {
    const { wantsMachineReplacement } = await import('../../src/agents/support.js');
    expect(wantsMachineReplacement('Minha Get Smart GS-1988-0001 está offline faz dias, quero trocar por uma nova')).toBe(true);
    expect(wantsMachineReplacement('I want to replace my card machine')).toBe(true);
    expect(wantsMachineReplacement('Quero trocar a conta de depósito')).toBe(false);
    expect(wantsMachineReplacement('Como troco a bobina da maquininha?')).toBe(false);
    expect(wantsMachineReplacement('Preciso trocar o chip da maquininha')).toBe(false);
    expect(wantsMachineReplacement('My card machine will not connect')).toBe(false);
    expect(wantsMachineReplacement('Minha nova maquininha não liga')).toBe(false);
    expect(wantsMachineReplacement('Recebi a nova máquina, como ativo?')).toBe(false);
    expect(wantsMachineReplacement('Quero trocar a maquininha porque a bateria não carrega e a tela acabou')).toBe(true);
    expect(wantsMachineReplacement('Não encontro onde trocar a maquininha')).toBe(true);
    expect(wantsMachineReplacement('Quero saber como configurar minha nova maquininha')).toBe(false);
    expect(wantsMachineReplacement('I need help setting up my new machine')).toBe(false);
    expect(wantsMachineReplacement('A maquininha dá troco?')).toBe(false);
  });
});
