import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { addBusinessDays, addDays, localDate } from './dates.js';
import type {
  Customer,
  CustomerRepository,
  NewTicket,
  Settlement,
  SettlementFilter,
  Terminal,
  Ticket,
  Transaction,
  TransactionFilter,
} from './repository.js';

const RawTransaction = z.object({
  id: z.string(),
  days_ago: z.number().int().min(0),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  amount: z.number().positive(),
  method: z.enum(['debit', 'credit', 'pix']),
  brand: z.string(),
  installments: z.number().int().min(1),
  status: z.enum(['approved', 'declined']),
  decline_code: z.string().optional(),
});

const RawCustomer = z.object({
  user_id: z.string(),
  business_name: z.string(),
  document: z.string(),
  segment: z.string(),
  city: z.string(),
  plan: z.string(),
  settlement_policy: z.object({
    debit_business_days: z.number().int().min(0),
    credit_business_days: z.number().int().min(0),
    pix_business_days: z.number().int().min(0),
  }),
  bank_account: z.string(),
  terminals: z.array(
    z.object({
      serial: z.string(),
      model: z.string(),
      status: z.enum(['online', 'offline']),
      last_seen_hours_ago: z.number().min(0),
      firmware: z.string(),
      battery_pct: z.number().min(0).max(100),
      connectivity: z.object({ wifi: z.string(), chip_4g: z.string(), last_error: z.string().nullable() }),
    }),
  ),
  transactions: z.array(RawTransaction),
});

const RawFile = z.object({ customers: z.array(RawCustomer) });
type RawCustomer = z.infer<typeof RawCustomer>;

/**
 * JSON-backed repository. Relative dates (days_ago) are materialized against an injectable
 * clock, so "yesterday's sales" always exist (spec A3). Tickets are kept in memory.
 */
export class MockCustomerRepository implements CustomerRepository {
  private readonly customers: Map<string, RawCustomer>;
  private readonly tickets: Ticket[] = [];

  constructor(data: unknown, private readonly now: () => Date = () => new Date()) {
    const parsed = RawFile.parse(data);
    this.customers = new Map(parsed.customers.map((c) => [c.user_id, c]));
  }

  static fromFile(path: string, now?: () => Date): MockCustomerRepository {
    return new MockCustomerRepository(JSON.parse(readFileSync(path, 'utf8')), now);
  }

  private today(): string {
    return localDate(this.now());
  }

  async getCustomer(userId: string): Promise<Customer | null> {
    const c = this.customers.get(userId);
    if (!c) return null;
    return {
      userId: c.user_id,
      businessName: c.business_name,
      document: c.document,
      segment: c.segment,
      city: c.city,
      plan: c.plan,
      bankAccount: c.bank_account,
      settlementPolicy: {
        debitBusinessDays: c.settlement_policy.debit_business_days,
        creditBusinessDays: c.settlement_policy.credit_business_days,
        pixBusinessDays: c.settlement_policy.pix_business_days,
      },
    };
  }

  async getTransactions(userId: string, filter: TransactionFilter = {}): Promise<Transaction[]> {
    const c = this.customers.get(userId);
    if (!c) return [];
    const today = this.today();
    return c.transactions
      .filter((t) => (filter.status ? t.status === filter.status : true))
      .filter((t) => (filter.lastDays !== undefined ? t.days_ago <= filter.lastDays : true))
      .map((t) => {
        const date = addDays(today, -t.days_ago);
        return {
          id: t.id,
          date,
          dateTime: `${date}T${t.time}:00`,
          amount: t.amount,
          method: t.method,
          brand: t.brand,
          installments: t.installments,
          status: t.status,
          ...(t.decline_code ? { declineCode: t.decline_code } : {}),
        };
      })
      .sort((a, b) => b.dateTime.localeCompare(a.dateTime));
  }

  async getSettlements(userId: string, filter: SettlementFilter = {}): Promise<Settlement[]> {
    const c = this.customers.get(userId);
    if (!c) return [];
    const today = this.today();
    const approved = await this.getTransactions(userId, { status: 'approved' });
    const daysFor = { debit: c.settlement_policy.debit_business_days, credit: c.settlement_policy.credit_business_days, pix: c.settlement_policy.pix_business_days };

    const groups = new Map<string, Settlement>();
    for (const t of approved) {
      if (filter.saleDate && t.date !== filter.saleDate) continue;
      const key = `${t.date}|${t.method}`;
      const expectedDate = addBusinessDays(t.date, daysFor[t.method]);
      const existing = groups.get(key);
      if (existing) {
        existing.grossAmount = round2(existing.grossAmount + t.amount);
        existing.transactionIds.push(t.id);
      } else {
        groups.set(key, {
          saleDate: t.date,
          expectedDate,
          method: t.method,
          grossAmount: t.amount,
          transactionIds: [t.id],
          status: expectedDate < today ? 'paid' : 'scheduled',
          bankAccount: c.bank_account,
        });
      }
    }
    return [...groups.values()]
      .filter((s) => (filter.upcomingOnly ? s.status === 'scheduled' : true))
      .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));
  }

  async getTerminals(userId: string): Promise<Terminal[]> {
    const c = this.customers.get(userId);
    if (!c) return [];
    const now = this.now().getTime();
    return c.terminals.map((t) => ({
      serial: t.serial,
      model: t.model,
      status: t.status,
      lastSeen: new Date(now - t.last_seen_hours_ago * 3_600_000).toISOString(),
      firmware: t.firmware,
      batteryPct: t.battery_pct,
      connectivity: { wifi: t.connectivity.wifi, chip4g: t.connectivity.chip_4g, lastError: t.connectivity.last_error },
    }));
  }

  async createTicket(input: NewTicket): Promise<Ticket> {
    const ticket: Ticket = {
      id: `TCK-${randomUUID().slice(0, 8).toUpperCase()}`,
      userId: input.userId,
      category: input.category,
      summary: input.summary.slice(0, 500),
      createdAt: this.now().toISOString(),
      status: 'open',
    };
    this.tickets.push(ticket);
    return ticket;
  }

  /** Test/inspection helper. */
  listTickets(userId?: string): Ticket[] {
    return this.tickets.filter((t) => (userId ? t.userId === userId : true));
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
