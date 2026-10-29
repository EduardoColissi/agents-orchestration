import type { Principal } from '../auth/jwt.js';
import { maskPII } from '../guardrails/pii.js';
import type { Logger } from '../observability/logger.js';
import type { AuditLog } from '../store/audit.js';
import type { ConversationStore, MessageRole } from '../store/conversations.js';
import { transaction, type Db } from '../store/db.js';
import type { Handoff, HandoffAction, HandoffStatus, HandoffStore } from '../store/handoffs.js';

export class HandoffNotFoundError extends Error {}
export class InvalidHandoffActionError extends Error {}
/** 409: the handoff is no longer pending, or another operator resolved it first. */
export class HandoffConflictError extends Error {
  constructor(readonly code: 'handoff_not_pending' | 'version_conflict', readonly handoff: Handoff) {
    super(code);
  }
}

/** Runs an approved/rejected action and lets the agent finish from its checkpoint (FR19). */
export interface ApprovalResumer {
  resume(handoff: Handoff, decision: { approved: boolean; note?: string }): Promise<string>;
}

export interface HitlServiceDeps {
  db: Db;
  handoffs: HandoffStore;
  conversations: ConversationStore;
  audit: AuditLog;
  logger: Logger;
  approvals?: ApprovalResumer;
}

const ACTIONS: Record<Handoff['kind'], HandoffAction[]> = { assist: ['reply', 'reject'], approval: ['approve', 'reject'] };

const REJECTED: Record<string, (id: string) => string> = {
  pt: (id) => `Um especialista analisou seu pedido ${id} e não pôde atendê-lo por aqui. Se precisar, fale com a central de atendimento Getnet informando o protocolo.`,
  es: (id) => `Un especialista revisó tu solicitud ${id} y no pudo atenderla por aquí. Si lo necesitas, contacta a la central de Getnet con el protocolo.`,
  en: (id) => `A specialist reviewed your request ${id} and could not handle it here. If you need to, contact Getnet customer service with the ticket.`,
};

const EXPIRED: Record<string, (id: string) => string> = {
  pt: (id) => `Não houve resposta do especialista a tempo para o pedido ${id}. Se ainda precisar, é só pedir de novo.`,
  es: (id) => `El especialista no respondió a tiempo a la solicitud ${id}. Si aún lo necesitas, pídelo de nuevo.`,
  en: (id) => `No specialist answered request ${id} in time. If you still need it, just ask again.`,
};

const pick = (templates: Record<string, (id: string) => string>, h: Handoff) => (templates[h.request.language] ?? templates.en!)(h.id);

/**
 * Human-in-the-loop. Operators resolve with compare-and-set on the version; the outcome is
 * delivered to the conversation exactly once (unique handoff_id), then control is back with the
 * agents. Expired handoffs are closed by the sweeper; a crash mid-resume is completed at boot.
 */
export class HitlService {
  constructor(private readonly deps: HitlServiceDeps) {}

  queue(status: HandoffStatus = 'pending') {
    return this.deps.handoffs.list(status).map(publicView);
  }

  detail(id: string) {
    const handoff = this.mustGet(id);
    const conversation = this.deps.conversations.get(handoff.conversationId)!;
    const messages = this.deps.conversations.messages(handoff.conversationId, { inContextOnly: true }).slice(-6);
    return { ...publicView(handoff), context: { summary: conversation.summary, messages: messages.map((m) => ({ role: m.role, content: m.content, created_at: m.createdAt })) } };
  }

  /** Operator-only: every message with its evidence (tool outputs, retrieved excerpts, route). Audited. */
  conversationTrace(operator: Principal, conversationId: string) {
    const conversation = this.deps.conversations.get(conversationId);
    if (!conversation) throw new HandoffNotFoundError();
    this.deps.audit.write({ actor: operator.sub, action: 'conversation.trace_read', subject: conversationId });
    return {
      id: conversation.id,
      owner_id: conversation.ownerId,
      summary: conversation.summary,
      messages: this.deps.conversations.messages(conversationId).map((m) => ({
        role: m.role, content: m.content, route: m.route, trace_id: m.traceId, in_context: m.inContext, handoff_id: m.handoffId, evidence: m.evidence, created_at: m.createdAt,
      })),
    };
  }

  async resolve(operator: Principal, id: string, input: { action: HandoffAction; message?: string; expectedVersion: number }) {
    const handoff = this.mustGet(id);
    if (!ACTIONS[handoff.kind].includes(input.action)) throw new InvalidHandoffActionError(`${input.action} is not valid for ${handoff.kind}`);
    if (input.action === 'reply' && !input.message?.trim()) throw new InvalidHandoffActionError('reply needs a message');
    if (handoff.status !== 'pending') throw new HandoffConflictError('handoff_not_pending', handoff);

    const resolution = { action: input.action, ...(input.message?.trim() ? { message: input.message.trim() } : {}) };
    const resuming = this.deps.handoffs.beginResume(id, input.expectedVersion, resolution, operator.sub);
    if (!resuming) {
      this.deps.audit.write({ actor: operator.sub, action: 'handoff.conflict', subject: id, details: { expected_version: input.expectedVersion } });
      throw new HandoffConflictError('version_conflict', this.mustGet(id));
    }
    this.deps.audit.write({ actor: operator.sub, action: 'handoff.resolved', subject: id, details: { action: input.action, kind: handoff.kind } });
    const message = await this.deliver(resuming);
    return { handoff: publicView(this.mustGet(id)), message };
  }

  /**
   * Computes the outcome and writes it to the conversation exactly once. Safe to repeat
   * (boot recovery): the side effect is idempotent and the message is unique per handoff.
   */
  async deliver(handoff: Handoff): Promise<{ role: MessageRole; content: string }> {
    const resolution = handoff.resolution!;
    let outcome: { role: MessageRole; content: string };
    if (handoff.kind === 'assist' && resolution.action === 'reply') {
      outcome = { role: 'operator', content: maskPII(resolution.message!).text };
    } else if (handoff.kind === 'approval' && this.deps.approvals) {
      const content = await this.deps.approvals.resume(handoff, { approved: resolution.action === 'approve', ...(resolution.message ? { note: resolution.message } : {}) });
      outcome = { role: 'assistant', content: maskPII(content).text };
    } else {
      outcome = { role: 'assistant', content: pick(REJECTED, handoff) };
    }
    transaction(this.deps.db, () => {
      this.deps.conversations.addMessage({ conversationId: handoff.conversationId, role: outcome.role, content: outcome.content, handoffId: handoff.id });
      if (this.deps.handoffs.complete(handoff.id)) this.deps.audit.write({ actor: 'system', action: 'handoff.completed', subject: handoff.id });
    });
    return outcome;
  }

  /** Pending past the TTL → expired, with a message to the merchant. An expired approval never runs. */
  sweep(): number {
    const expired = this.deps.handoffs.expireDue();
    for (const h of expired) {
      transaction(this.deps.db, () => {
        this.deps.conversations.addMessage({ conversationId: h.conversationId, role: 'assistant', content: pick(EXPIRED, h), handoffId: h.id });
        this.deps.audit.write({ actor: 'system', action: 'handoff.expired', subject: h.id });
      });
    }
    return expired.length;
  }

  /** Boot: finish resolutions interrupted by a crash, once each. */
  async recover(): Promise<number> {
    const stuck = this.deps.handoffs.findResuming();
    for (const h of stuck) {
      await this.deliver(h);
      this.deps.audit.write({ actor: 'system', action: 'handoff.recovered', subject: h.id });
      this.deps.logger.warn({ handoff_id: h.id }, 'recovered an interrupted handoff resolution');
    }
    return stuck.length;
  }

  private mustGet(id: string): Handoff {
    const handoff = this.deps.handoffs.get(id);
    if (!handoff) throw new HandoffNotFoundError();
    return handoff;
  }
}

export function publicView(h: Handoff) {
  return {
    id: h.id, kind: h.kind, reason: h.reason, status: h.status, version: h.version, conversation_id: h.conversationId, owner_id: h.ownerId,
    request: h.request, resolution: h.resolution, resolved_by: h.resolvedBy, created_at: h.createdAt, expires_at: h.expiresAt,
  };
}
