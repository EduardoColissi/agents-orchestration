import type { Principal } from '../auth/jwt.js';
import type { ChatResponse, Orchestrator } from '../orchestrator.js';
import type { AuditLog } from '../store/audit.js';
import type { Conversation, ConversationStore } from '../store/conversations.js';
import { transaction, type Db } from '../store/db.js';

export class ConversationNotFoundError extends Error {}
export class ConversationBusyError extends Error {}

export interface ChatServiceDeps {
  db: Db;
  orchestrator: Orchestrator;
  conversations: ConversationStore;
  audit: AuditLog;
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
      const turn = await this.deps.orchestrator.handle({ message: input.message, userId: principal.sub, traceId: input.traceId });
      transaction(this.deps.db, () => {
        const base = { conversationId: conversation.id, traceId: input.traceId, inContext: turn.inContext };
        this.deps.conversations.addMessage({ ...base, role: 'merchant', content: turn.maskedMessage });
        this.deps.conversations.addMessage({ ...base, role: 'assistant', content: turn.response.answer, route: turn.response.route, evidence: turn.evidence });
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
