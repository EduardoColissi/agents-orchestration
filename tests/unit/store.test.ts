import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb, transaction } from '../../src/store/db.js';
import { AuditLog } from '../../src/store/audit.js';
import { TicketStore } from '../../src/store/tickets.js';

const dir = mkdtempSync(join(tmpdir(), 'store-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('SQLite store', () => {
  it('migrates once and keeps data when the file is reopened (restart)', () => {
    const path = join(dir, 'app.db');
    const first = openDb(path);
    new TicketStore(first).create({ userId: 'cliente1988', category: 'other', summary: 'persist me' }, '2026-10-29T12:00:00Z');
    first.close();

    const reopened = openDb(path);
    expect((reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    expect(new TicketStore(reopened).list('cliente1988').map((t) => t.summary)).toEqual(['persist me']);
    reopened.close();
  });

  it('keeps the audit log append-only', () => {
    const db = openDb(':memory:');
    const audit = new AuditLog(db);
    audit.write({ actor: 'system', action: 'handoff.created', subject: 'HND-1', details: { kind: 'assist' } });
    expect(() => db.exec("UPDATE audit_log SET actor = 'x'")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM audit_log')).toThrow(/append-only/);
    expect(audit.list({ subject: 'HND-1' })).toMatchObject([{ actor: 'system', action: 'handoff.created', details: { kind: 'assist' } }]);
  });

  it('creates a ticket with an explicit id exactly once', () => {
    const tickets = new TicketStore(openDb(':memory:'));
    const a = tickets.create({ id: 'TCK-ABC12345', userId: 'cliente1988', category: 'terminal_replacement', summary: 'first' }, 't1');
    const b = tickets.create({ id: 'TCK-ABC12345', userId: 'cliente1988', category: 'terminal_replacement', summary: 'second' }, 't2');
    expect(b).toEqual(a);
    expect(tickets.list()).toHaveLength(1);
  });

  it('rolls back a failed transaction', () => {
    const db = openDb(':memory:');
    expect(() =>
      transaction(db, () => {
        new AuditLog(db).write({ actor: 'system', action: 'handoff.created' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(new AuditLog(db).list()).toEqual([]);
  });
});
