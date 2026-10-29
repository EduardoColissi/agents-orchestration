import type { Db } from './db.js';

export type AuditAction =
  | 'auth.token_issued'
  | 'auth.login_failed'
  | 'auth.user_mismatch'
  | 'conversation.access_denied'
  | 'conversation.trace_read'
  | 'handoff.created'
  | 'handoff.resolved'
  | 'handoff.conflict'
  | 'handoff.completed'
  | 'handoff.expired'
  | 'handoff.recovered'
  | 'approval.executed';

export interface AuditEntry {
  actor: string;
  action: AuditAction;
  subject?: string;
  details?: Record<string, unknown>;
}

/** Append-only audit trail (UPDATE/DELETE are rejected by triggers). */
export class AuditLog {
  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  write(entry: AuditEntry): void {
    this.db
      .prepare('INSERT INTO audit_log (at, actor, action, subject, details) VALUES (?, ?, ?, ?, ?)')
      .run(this.now().toISOString(), entry.actor, entry.action, entry.subject ?? null, entry.details ? JSON.stringify(entry.details) : null);
  }

  list(filter: { action?: AuditAction; subject?: string } = {}): Array<AuditEntry & { at: string }> {
    const rows = this.db
      .prepare('SELECT at, actor, action, subject, details FROM audit_log WHERE (?1 IS NULL OR action = ?1) AND (?2 IS NULL OR subject = ?2) ORDER BY id')
      .all(filter.action ?? null, filter.subject ?? null) as Array<{ at: string; actor: string; action: AuditAction; subject: string | null; details: string | null }>;
    return rows.map((r) => ({ at: r.at, actor: r.actor, action: r.action, ...(r.subject ? { subject: r.subject } : {}), ...(r.details ? { details: JSON.parse(r.details) } : {}) }));
  }
}
