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

const MESSAGES: Record<string, (id: string) => string> = {
  pt: (id) => `Encaminhei seu pedido para um especialista humano da Getnet (protocolo ${id}). A resposta aparece aqui nesta conversa.`,
  es: (id) => `Derivé tu solicitud a un especialista humano de Getnet (protocolo ${id}). La respuesta aparecerá aquí, en esta conversación.`,
  en: (id) => `I've handed your request over to a Getnet human specialist (ticket ${id}). The answer will appear here, in this conversation.`,
};

const ALREADY_OPEN: Record<string, (id: string) => string> = {
  pt: (id) => `Seu pedido ${id} já está com um especialista humano. A resposta aparece aqui nesta conversa.`,
  es: (id) => `Tu solicitud ${id} ya está con un especialista humano. La respuesta aparecerá aquí, en esta conversación.`,
  en: (id) => `Your request ${id} is already with a human specialist. The answer will appear here, in this conversation.`,
};

/**
 * Human Escalation Agent. Deterministic on purpose: handoff must work even when the LLM is
 * unavailable. It does not resolve anything itself: it puts the request in the operator queue
 * (an `assist` handoff, persisted by the chat service) and tells the merchant the protocol.
 */
export class EscalationAgent {
  readonly name = 'escalation' as const;

  handoff(params: { language: string; reason: HandoffReason | string; handoffId: string; alreadyOpen: boolean }): AgentResult {
    const template = (params.alreadyOpen ? ALREADY_OPEN : MESSAGES)[params.language] ?? (params.alreadyOpen ? ALREADY_OPEN : MESSAGES).en!;
    return {
      agent: this.name,
      answer: template(params.handoffId),
      sources: [],
      toolsUsed: [],
      usage: emptyUsage(),
      handoff: { reason: params.reason },
    };
  }
}
