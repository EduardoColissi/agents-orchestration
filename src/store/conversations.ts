import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';

export type MessageRole = 'merchant' | 'assistant' | 'operator';

export interface Conversation {
  id: string;
  ownerId: string;
  summary: string;
  summarizedUpto: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: number;
  conversationId: string;
  role: MessageRole;
  content: string;
  route: string | null;
  traceId: string | null;
  inContext: boolean;
  handoffId: string | null;
  evidence: unknown;
  createdAt: string;
}

export interface NewMessage {
  conversationId: string;
  role: MessageRole;
  content: string;
  route?: string | null;
  traceId?: string | null;
  inContext?: boolean;
  handoffId?: string | null;
  evidence?: unknown;
}

/** Conversations and their (PII-masked) messages. */
export class ConversationStore {
  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  create(ownerId: string): Conversation {
    const at = this.now().toISOString();
    const id = randomUUID();
    this.db.prepare('INSERT INTO conversations (id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, ownerId, at, at);
    return this.get(id)!;
  }

  get(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    return row ? { id: row.id, ownerId: row.owner_id, summary: row.summary, summarizedUpto: row.summarized_upto, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  /**
   * Appends a message. With a `handoffId` the insert is idempotent: the second delivery of the
   * same handoff outcome is ignored (exactly-once). Returns false when it was a duplicate.
   */
  addMessage(m: NewMessage): boolean {
    const at = this.now().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO messages (conversation_id, role, content, route, trace_id, in_context, handoff_id, evidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(handoff_id) DO NOTHING`,
      )
      .run(m.conversationId, m.role, m.content, m.route ?? null, m.traceId ?? null, m.inContext === false ? 0 : 1, m.handoffId ?? null, m.evidence === undefined ? null : JSON.stringify(m.evidence), at);
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(at, m.conversationId);
    return result.changes > 0;
  }

  messages(conversationId: string, opts: { inContextOnly?: boolean; afterId?: number; withEvidence?: boolean } = {}): StoredMessage[] {
    const columns = opts.withEvidence === false ? 'id, conversation_id, role, content, route, trace_id, in_context, handoff_id, NULL AS evidence, created_at' : '*';
    const rows = this.db
      .prepare(`SELECT ${columns} FROM messages WHERE conversation_id = ? AND (? = 0 OR in_context = 1) AND id > ? ORDER BY id`)
      .all(conversationId, opts.inContextOnly ? 1 : 0, opts.afterId ?? 0) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  updateSummary(conversationId: string, summary: string, summarizedUpto: number): void {
    this.db.prepare('UPDATE conversations SET summary = ?, summarized_upto = ? WHERE id = ?').run(summary, summarizedUpto, conversationId);
  }
}

interface ConversationRow {
  id: string;
  owner_id: string;
  summary: string;
  summarized_upto: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  conversation_id: string;
  role: MessageRole;
  content: string;
  route: string | null;
  trace_id: string | null;
  in_context: number;
  handoff_id: string | null;
  evidence: string | null;
  created_at: string;
}

const toMessage = (r: MessageRow): StoredMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  content: r.content,
  route: r.route,
  traceId: r.trace_id,
  inContext: r.in_context === 1,
  handoffId: r.handoff_id,
  evidence: r.evidence ? JSON.parse(r.evidence) : null,
  createdAt: r.created_at,
});
