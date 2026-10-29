import type { Principal } from '../auth/jwt.js';
import type { ChatResponse, Orchestrator } from '../orchestrator.js';
import type { AuditLog } from '../store/audit.js';
import type { Conversation, ConversationStore } from '../store/conversations.js';
import { transaction, type Db } from '../store/db.js';
import { buildContextBlock } from '../memory/context.js';
import { compact } from '../memory/compaction.js';
import { HandoffAlreadyOpenError, type HandoffStore } from '../store/handoffs.js';
import type { SpanStore } from '../store/spans.js';

export class ConversationNotFoundError extends Error {}
export class ConversationBusyError extends Error {}

export interface ChatServiceDeps {
  db: Db;
  orchestrator: Orchestrator;
  conversations: ConversationStore;
  handoffs: HandoffStore;
  spans: SpanStore;
  audit: AuditLog;
  handoffTtlMinutes: number;
}

/**
 * One merchant turn: ownership check → orchestrator → the whole turn persisted in one
 * transaction. Conversations of other merchants answer "not found" (existence is not revealed).
 */
export class ChatService {
  /** Single instance: an in-process lock is enough to serialize turns of one conversation. */
  private readonly busy = new Set<string>();

  constructor(private readonly deps: ChatServiceDeps) {}

  async chat(principal: Principal, input: { message: string; conversationId?: string; traceId: string }): Promise<ChatResponse> {
    const conversation = input.conversationId ? this.getOwned(principal, input.conversationId) : this.deps.conversations.create(principal.sub);
    if (this.busy.has(conversation.id)) throw new ConversationBusyError();
    this.busy.add(conversation.id);
    try {
      const open = this.deps.handoffs.openFor(conversation.id);
      const openHandoff = open ? { id: open.id, kind: open.kind, status: open.status } : null;
      const context = buildContextBlock({ summary: conversation.summary, messages: this.deps.conversations.messages(conversation.id, { inContextOnly: true }), openHandoff });
      const turn = await this.deps.orchestrator.handle({ message: input.message, userId: principal.sub, traceId: input.traceId, context, openHandoff });
      transaction(this.deps.db, () => {
        const base = { conversationId: conversation.id, traceId: input.traceId, inContext: turn.inContext };
        this.deps.conversations.addMessage({ ...base, role: 'merchant', content: turn.maskedMessage });
        this.deps.conversations.addMessage({ ...base, role: 'assistant', content: turn.response.answer, route: turn.response.route, evidence: turn.evidence });
        const compacted = compact(conversation.summary, conversation.summarizedUpto, this.deps.conversations.messages(conversation.id, { inContextOnly: true }));
        if (compacted) this.deps.conversations.updateSummary(conversation.id, compacted.summary, compacted.summarizedUpto);
        this.deps.spans.record(input.traceId, conversation.id, [
          ...turn.spans,
          { stage: 'turn', name: 'chat', durationMs: turn.response.latency_ms, status: 'ok', attrs: { route: turn.response.route, handoff_required: turn.response.handoff.required } },
        ]);
        const h = turn.handoffRequest;
        if (h) {
          try {
            this.deps.handoffs.create({
              id: h.id, conversationId: conversation.id, ownerId: principal.sub, kind: h.kind, reason: h.reason, ttlMinutes: this.deps.handoffTtlMinutes,
              request: { message: turn.maskedMessage, language: h.language, ...(h.proposedAction ? { proposed_action: h.proposedAction } : {}) },
              ...(h.checkpoint !== undefined ? { checkpoint: h.checkpoint } : {}),
            });
            this.deps.audit.write({ actor: principal.sub, action: 'handoff.created', subject: h.id, details: { kind: h.kind, reason: h.reason } });
          } catch (err) {
            // A concurrent turn opened one first: the merchant already has a request in the queue.
            if (!(err instanceof HandoffAlreadyOpenError)) throw err;
          }
        }
      });
      const { trace_id, ...rest } = turn.response;
      return { trace_id, conversation_id: conversation.id, ...rest };
    } finally {
      this.busy.delete(conversation.id);
    }
  }

  /** The merchant's view of a conversation (no evidence: that is operator-only). */
  view(principal: Principal, conversationId: string) {
    const conversation = this.getOwned(principal, conversationId);
    return {
      id: conversation.id,
      created_at: conversation.createdAt,
      messages: this.deps.conversations.messages(conversation.id).map((m) => ({ role: m.role, content: m.content, created_at: m.createdAt, handoff_id: m.handoffId })),
      open_handoff: ((h) => (h ? { id: h.id, kind: h.kind, status: h.status } : null))(this.deps.handoffs.openFor(conversation.id)),
    };
  }

  getOwned(principal: Principal, conversationId: string): Conversation {
    const conversation = this.deps.conversations.get(conversationId);
    if (!conversation || conversation.ownerId !== principal.sub) {
      if (conversation) this.deps.audit.write({ actor: principal.sub, action: 'conversation.access_denied', subject: conversationId });
      throw new ConversationNotFoundError();
    }
    return conversation;
  }
}
