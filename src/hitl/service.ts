import type { Principal } from '../auth/jwt.js';
import type { ToolEvidence } from '../types.js';
import { maskPII } from '../guardrails/pii.js';
import type { Logger } from '../observability/logger.js';
import type { AuditLog } from '../store/audit.js';
import type { ConversationStore, MessageRole } from '../store/conversations.js';
import { transaction, type Db } from '../store/db.js';
import type { Handoff, HandoffAction, HandoffStatus, HandoffStore } from '../store/handoffs.js';

export class HandoffNotFoundError extends Error {}
export class InvalidHandoffActionError extends Error {}
/** The decision is recorded but its outcome could not be delivered yet; the periodic tick retries it. */
export class HandoffDeliveryError extends Error {}
/** 409: the handoff is no longer pending, or another operator resolved it first. */
export class HandoffConflictError extends Error {
  constructor(readonly code: 'handoff_not_pending' | 'handoff_expired' | 'version_conflict', readonly handoff: Handoff) {
    super(code);
  }
}

/** Runs an approved/rejected action and lets the agent finish from its checkpoint (FR19). */
export interface ApprovalResumer {
  resume(handoff: Handoff, decision: { approved: boolean; note?: string }): Promise<{ content: string; evidence: ToolEvidence[] }>;
}

export interface HitlServiceDeps {
  db: Db;
  handoffs: HandoffStore;
  conversations: ConversationStore;
  audit: AuditLog;
  logger: Logger;
  approvals?: ApprovalResumer;
  now?: () => Date;
}

const MAX_DELIVERY_ATTEMPTS = 5;

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
  /** Single instance: handoffs being delivered right now, so the tick never runs one twice in parallel. */
  private readonly delivering = new Set<string>();
  private readonly failures = new Map<string, number>();
  private ticking = false;

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
    if (handoff.expiresAt < (this.deps.now ?? (() => new Date()))().toISOString()) {
      this.sweep();
      throw new HandoffConflictError('handoff_expired', this.mustGet(id));
    }

    const resolution = { action: input.action, ...(input.message?.trim() ? { message: input.message.trim() } : {}) };
    const resuming = this.deps.handoffs.beginResume(id, input.expectedVersion, resolution, operator.sub);
    if (!resuming) {
      this.deps.audit.write({ actor: operator.sub, action: 'handoff.conflict', subject: id, details: { expected_version: input.expectedVersion } });
      throw new HandoffConflictError('version_conflict', this.mustGet(id));
    }
    this.deps.audit.write({ actor: operator.sub, action: 'handoff.resolved', subject: id, details: { action: input.action, kind: handoff.kind } });
    try {
      const message = await this.deliver(resuming);
      return { handoff: publicView(this.mustGet(id)), message };
    } catch (err) {
      this.deps.logger.error({ handoff_id: id, err }, 'handoff delivery failed; it will be retried');
      throw new HandoffDeliveryError();
    }
  }

  /**
   * Computes the outcome and writes it to the conversation exactly once. Safe to repeat
   * (boot recovery): the side effect is idempotent and the message is unique per handoff.
   */
  async deliver(handoff: Handoff): Promise<{ role: MessageRole; content: string }> {
    if (this.delivering.has(handoff.id)) throw new Error(`handoff ${handoff.id} is already being delivered`);
    this.delivering.add(handoff.id);
    try {
      return await this.deliverOnce(handoff);
    } finally {
      this.delivering.delete(handoff.id);
    }
  }

  private async deliverOnce(handoff: Handoff): Promise<{ role: MessageRole; content: string }> {
    const resolution = handoff.resolution!;
    let outcome: { role: MessageRole; content: string; evidence?: unknown };
    if (handoff.kind === 'assist' && resolution.action === 'reply') {
      outcome = { role: 'operator', content: maskPII(resolution.message!).text };
    } else if (handoff.kind === 'approval' && this.deps.approvals) {
      const resumed = await this.deps.approvals.resume(handoff, { approved: resolution.action === 'approve', ...(resolution.message ? { note: resolution.message } : {}) });
      // The resumed run's tool calls are kept as evidence, like any other turn (operators and the judge read them).
      outcome = { role: 'assistant', content: maskPII(resumed.content).text, evidence: { route_decision: null, standalone_query: null, resumed_from: handoff.id, steps: [{ agent: 'support', tools: resumed.evidence }], sources: [] } };
    } else {
      outcome = { role: 'assistant', content: pick(REJECTED, handoff) };
    }
    transaction(this.deps.db, () => {
      this.deps.conversations.addMessage({ conversationId: handoff.conversationId, role: outcome.role, content: outcome.content, handoffId: handoff.id, ...(outcome.evidence ? { evidence: outcome.evidence } : {}) });
      if (this.deps.handoffs.complete(handoff.id)) this.deps.audit.write({ actor: 'system', action: 'handoff.completed', subject: handoff.id });
    });
    return { role: outcome.role, content: outcome.content };
  }

  /** Pending past the TTL → expired, with a message to the merchant. An expired approval never runs. */
  sweep(): number {
    let expired = 0;
    for (const h of this.deps.handoffs.dueForExpiry()) {
      // Status, merchant message and audit in one transaction: never expired without a notice.
      transaction(this.deps.db, () => {
        if (!this.deps.handoffs.expire(h)) return;
        this.deps.conversations.addMessage({ conversationId: h.conversationId, role: 'assistant', content: pick(EXPIRED, h), handoffId: h.id });
        this.deps.audit.write({ actor: 'system', action: 'handoff.expired', subject: h.id });
        expired++;
      });
    }
    return expired;
  }

  /** Periodic work: expire stale handoffs and retry deliveries stuck in `resuming`. Never throws. */
  async tick(stuckAfterMs = 60_000): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.sweep();
      await this.recover(stuckAfterMs);
    } catch (err) {
      this.deps.logger.error({ err }, 'handoff maintenance failed');
    } finally {
      this.ticking = false;
    }
  }

  /** Boot: finish resolutions interrupted by a crash, once each. */
  async recover(olderThanMs = 0): Promise<number> {
    let recovered = 0;
    for (const h of this.deps.handoffs.findResuming(olderThanMs)) {
      // In flight in this process, or given up after repeated failures (needs an operator/engineer).
      if (this.delivering.has(h.id) || (this.failures.get(h.id) ?? 0) >= MAX_DELIVERY_ATTEMPTS) continue;
      try {
        await this.deliver(h);
        this.failures.delete(h.id);
        this.deps.audit.write({ actor: 'system', action: 'handoff.recovered', subject: h.id });
        this.deps.logger.warn({ handoff_id: h.id }, 'recovered an interrupted handoff resolution');
        recovered++;
      } catch (err) {
        // One broken handoff must not stop the others, nor the boot.
        const attempts = (this.failures.get(h.id) ?? 0) + 1;
        this.failures.set(h.id, attempts);
        this.deps.logger.error({ handoff_id: h.id, attempts, err }, attempts >= MAX_DELIVERY_ATTEMPTS ? 'handoff delivery abandoned after repeated failures' : 'handoff recovery failed; will retry');
      }
    }
    return recovered;
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
