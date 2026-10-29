import { randomUUID } from 'node:crypto';
import type { NewTicket, Ticket } from '../support/repository.js';
import type { Db } from './db.js';

/** Persistent tickets. A caller-provided id makes creation idempotent (INSERT OR IGNORE). */
export class TicketStore {
  constructor(private readonly db: Db) {}

  create(input: NewTicket, createdAt: string): Ticket {
    const id = input.id ?? `TCK-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
    this.db
      .prepare("INSERT OR IGNORE INTO tickets (id, user_id, category, summary, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)")
      .run(id, input.userId, input.category, input.summary.slice(0, 500), createdAt);
    return this.get(id)!;
  }

  get(id: string): Ticket | null {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as TicketRow | undefined;
    return row ? toTicket(row) : null;
  }

  list(userId?: string): Ticket[] {
    const rows = this.db.prepare('SELECT * FROM tickets WHERE (?1 IS NULL OR user_id = ?1) ORDER BY created_at, id').all(userId ?? null) as unknown as TicketRow[];
    return rows.map(toTicket);
  }
}

interface TicketRow {
  id: string;
  user_id: string;
  category: Ticket['category'];
  summary: string;
  status: 'open';
  created_at: string;
}

const toTicket = (r: TicketRow): Ticket => ({ id: r.id, userId: r.user_id, category: r.category, summary: r.summary, createdAt: r.created_at, status: r.status });
