import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';

export type HandoffKind = 'assist' | 'approval';
export type HandoffStatus = 'pending' | 'resuming' | 'completed' | 'expired';
export type HandoffAction = 'reply' | 'approve' | 'reject';

export interface HandoffRequestData {
  message: string;
  language: string;
  proposed_action?: { tool: string; input: unknown };
}

export interface HandoffResolution {
  action: HandoffAction;
  message?: string;
}

export interface Handoff {
  id: string;
  conversationId: string;
  ownerId: string;
  kind: HandoffKind;
  reason: string;
  status: HandoffStatus;
  version: number;
  request: HandoffRequestData;
  checkpoint: unknown;
  resolution: HandoffResolution | null;
  resolvedBy: string | null;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
}

export interface NewHandoff {
  id?: string;
  conversationId: string;
  ownerId: string;
  kind: HandoffKind;
  reason: string;
  request: HandoffRequestData;
  checkpoint?: unknown;
  ttlMinutes: number;
}

/** A second open handoff on the same conversation (partial unique index). */
export class HandoffAlreadyOpenError extends Error {}

export const newHandoffId = () => `HND-${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;

/**
 * Persistent human queue. Every transition is a compare-and-set on `version` + `status`, so two
 * operators (or a retry, or the sweeper) can never both win the same transition.
 *   pending ─resolve→ resuming ─deliver→ completed;  pending ─TTL→ expired
 */
export class HandoffStore {
  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  create(h: NewHandoff): Handoff {
    const at = this.now();
    const id = h.id ?? newHandoffId();
    try {
      this.db
        .prepare(
          `INSERT INTO handoffs (id, conversation_id, owner_id, kind, reason, status, version, request, checkpoint, created_at, expires_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?)`,
        )
        .run(id, h.conversationId, h.ownerId, h.kind, h.reason, JSON.stringify(h.request), h.checkpoint === undefined ? null : JSON.stringify(h.checkpoint), at.toISOString(), new Date(at.getTime() + h.ttlMinutes * 60_000).toISOString(), at.toISOString());
    } catch (err) {
      if (/UNIQUE constraint failed: handoffs\.conversation_id/.test((err as Error).message)) throw new HandoffAlreadyOpenError();
      throw err;
    }
    return this.get(id)!;
  }

  get(id: string): Handoff | null {
    const row = this.db.prepare('SELECT * FROM handoffs WHERE id = ?').get(id) as HandoffRow | undefined;
    return row ? toHandoff(row) : null;
  }

  openFor(conversationId: string): Handoff | null {
    const row = this.db.prepare("SELECT * FROM handoffs WHERE conversation_id = ? AND status IN ('pending','resuming')").get(conversationId) as HandoffRow | undefined;
    return row ? toHandoff(row) : null;
  }

  /** FIFO queue. */
  list(status: HandoffStatus = 'pending'): Handoff[] {
    return (this.db.prepare('SELECT * FROM handoffs WHERE status = ? ORDER BY created_at, id').all(status) as unknown as HandoffRow[]).map(toHandoff);
  }

  /** pending → resuming, only if nobody moved it since `expectedVersion`. Null = lost the race. */
  beginResume(id: string, expectedVersion: number, resolution: HandoffResolution, operatorId: string): Handoff | null {
    const result = this.db
      .prepare("UPDATE handoffs SET status = 'resuming', version = version + 1, resolution = ?, resolved_by = ?, updated_at = ? WHERE id = ? AND version = ? AND status = 'pending'")
      .run(JSON.stringify(resolution), operatorId, this.now().toISOString(), id, expectedVersion);
    return result.changes === 1 ? this.get(id) : null;
  }

  /** resuming → completed. False when it was already completed (idempotent recovery). */
  complete(id: string): boolean {
    const result = this.db.prepare("UPDATE handoffs SET status = 'completed', version = version + 1, updated_at = ? WHERE id = ? AND status = 'resuming'").run(this.now().toISOString(), id);
    return result.changes === 1;
  }

  /** pending past `expires_at` → expired. Returns the handoffs this call expired. */
  expireDue(): Handoff[] {
    const at = this.now().toISOString();
    const due = (this.db.prepare("SELECT * FROM handoffs WHERE status = 'pending' AND expires_at < ?").all(at) as unknown as HandoffRow[]).map(toHandoff);
    const update = this.db.prepare("UPDATE handoffs SET status = 'expired', version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'pending'");
    return due.filter((h) => update.run(at, h.id, h.version).changes === 1).map((h) => this.get(h.id)!);
  }

  /** Resolutions interrupted by a crash, to be completed at boot. */
  findResuming(): Handoff[] {
    return this.list('resuming');
  }
}

interface HandoffRow {
  id: string;
  conversation_id: string;
  owner_id: string;
  kind: HandoffKind;
  reason: string;
  status: HandoffStatus;
  version: number;
  request: string;
  checkpoint: string | null;
  resolution: string | null;
  resolved_by: string | null;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

const toHandoff = (r: HandoffRow): Handoff => ({
  id: r.id,
  conversationId: r.conversation_id,
  ownerId: r.owner_id,
  kind: r.kind,
  reason: r.reason,
  status: r.status,
  version: r.version,
  request: JSON.parse(r.request),
  checkpoint: r.checkpoint ? JSON.parse(r.checkpoint) : null,
  resolution: r.resolution ? JSON.parse(r.resolution) : null,
  resolvedBy: r.resolved_by,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  updatedAt: r.updated_at,
});
