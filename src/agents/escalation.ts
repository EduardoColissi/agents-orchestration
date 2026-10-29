import type { CustomerRepository } from '../support/repository.js';
import { emptyUsage, type AgentResult } from '../types.js';

export type HandoffReason =
  | 'user_requested'
  | 'low_confidence'
  | 'router_failure'
  | 'knowledge_gap'
  | 'ungrounded_answer'
  | 'customer_not_found'
  | 'agent_error'
  | 'knowledge_agent_incomplete'
  | 'support_agent_incomplete';

const MESSAGES: Record<string, (ticket: string) => string> = {
  pt: (t) => `Encaminhei seu atendimento para um especialista humano da Getnet (protocolo ${t}). Você receberá retorno pelos canais cadastrados; se for urgente, ligue para a central de atendimento Getnet informando o protocolo.`,
  es: (t) => `Derivé tu solicitud a un especialista humano de Getnet (protocolo ${t}). Te contactarán por los canales registrados; si es urgente, llama a la central de atención de Getnet con el protocolo.`,
  en: (t) => `I've handed your request over to a Getnet human specialist (ticket ${t}). They will contact you through your registered channels; if it's urgent, call Getnet customer service and mention the ticket.`,
};

/**
 * Human Escalation Agent (bonus). Deterministic on purpose: handoff must work even when the
 * LLM is unavailable, and its behaviour should be 100% predictable and testable.
 */
export class EscalationAgent {
  readonly name = 'escalation' as const;

  constructor(private readonly repo: CustomerRepository) {}

  async handoff(params: { userId: string; language: string; reason: HandoffReason | string; message: string; existingTicketId?: string }): Promise<AgentResult> {
    const ticketId =
      params.existingTicketId ??
      (await this.repo.createTicket({ userId: params.userId, category: 'human_handoff', summary: `[${params.reason}] ${params.message}` })).id;
    const template = MESSAGES[params.language] ?? MESSAGES.en!;
    return {
      agent: this.name,
      answer: template(ticketId),
      sources: [],
      toolsUsed: params.existingTicketId ? [] : ['create_handoff_ticket'],
      usage: emptyUsage(),
      handoff: { reason: params.reason, ticketId },
    };
  }
}
