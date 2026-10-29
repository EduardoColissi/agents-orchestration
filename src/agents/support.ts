import type { LLMClient, LLMMessage, ToolResultContent } from '../llm/client.js';
import type { Agent, AgentContext, AgentResult } from '../types.js';
import { emptyUsage } from '../types.js';
import type { CustomerRepository } from '../support/repository.js';
import { createSupportTools } from '../support/tools.js';
import { addDays, localDate, weekdayName } from '../support/dates.js';
import type { ApprovalResumer } from '../hitl/service.js';
import type { AuditLog } from '../store/audit.js';
import type { Handoff } from '../store/handoffs.js';
import { supportPrompt } from './prompts.js';
import { runToolLoop, type AgentTool } from './toolLoop.js';
import { withConversation } from './knowledge.js';

export interface SupportAgentOptions {
  model: string;
  maxIterations: number;
  /** Recorded in approval checkpoints: a checkpoint is only resumed by the same provider/model. */
  provider?: string;
  now?: () => Date;
}

/** Everything needed to continue the agent run after an operator decision (JSON). */
export interface ApprovalCheckpoint {
  agent: 'support';
  provider: string;
  model: string;
  system: string;
  language: string;
  messages: LLMMessage[];
  pendingCall: { id: string; name: string; input: unknown };
  siblingResults: ToolResultContent[];
}

const NOT_FOUND_MESSAGES: Record<string, string> = {
  pt: 'Não encontrei uma conta Getnet vinculada a este usuário, então não consigo consultar vendas, recebimentos ou maquininhas. Confira se você está logado com o usuário certo ou, se preferir, posso te encaminhar para um atendente humano.',
  es: 'No encontré una cuenta Getnet vinculada a este usuario, así que no puedo consultar ventas, depósitos ni terminales. Verifica que hayas iniciado sesión con el usuario correcto o, si prefieres, puedo derivarte a un agente humano.',
  en: "I couldn't find a Getnet account linked to this user, so I can't check sales, deposits or card machines. Please check you're signed in with the right user, or I can hand you over to a human agent.",
};

const APPROVED_FALLBACK: Record<string, (ticket: string) => string> = {
  pt: (t) => `A troca da sua maquininha foi aprovada por um especialista. Abrimos o chamado ${t} para o envio da nova máquina.`,
  es: (t) => `Un especialista aprobó el cambio de tu terminal. Abrimos el ticket ${t} para el envío de la nueva máquina.`,
  en: (t) => `A specialist approved the replacement of your card machine. We opened ticket ${t} to ship the new one.`,
};

const REJECTED_FALLBACK: Record<string, (note: string) => string> = {
  pt: (n) => `Um especialista analisou o pedido de troca e ele não foi aprovado${n ? `: ${n}` : '.'}`,
  es: (n) => `Un especialista revisó la solicitud de cambio y no fue aprobada${n ? `: ${n}` : '.'}`,
  en: (n) => `A specialist reviewed the replacement request and it was not approved${n ? `: ${n}` : '.'}`,
};

/** Customer Support Agent: resolves account-specific requests with tools bound to the requesting user. */
export class SupportAgent implements Agent, ApprovalResumer {
  readonly name = 'support' as const;
  private audit: AuditLog | null = null;

  constructor(
    private readonly llm: LLMClient,
    private readonly repo: CustomerRepository,
    private readonly options: SupportAgentOptions,
  ) {}

  /** Wired by the container once the audit log exists. */
  useAudit(audit: AuditLog): void {
    this.audit = audit;
  }

  async run(ctx: AgentContext): Promise<AgentResult> {
    // FR5: unknown customer → deterministic answer + handoff, no LLM call.
    const customer = await this.repo.getCustomer(ctx.userId);
    if (!customer) {
      return {
        agent: this.name,
        answer: NOT_FOUND_MESSAGES[ctx.language] ?? NOT_FOUND_MESSAGES.en!,
        sources: [],
        toolsUsed: [],
        usage: emptyUsage(),
        handoff: { reason: 'customer_not_found' },
      };
    }

    let ticketId: string | undefined;
    const tools = createSupportTools(this.repo, ctx.userId).map((tool): AgentTool =>
      tool.spec.name !== 'create_support_ticket'
        ? tool
        : {
            spec: tool.spec,
            execute: async (input) => {
              const out = await tool.execute(input);
              if (!out.isError) ticketId = (JSON.parse(out.content) as { ticket_id: string }).ticket_id;
              return out;
            },
          },
    );

    const today = localDate(this.options.now?.() ?? new Date());
    const yesterday = addDays(today, -1);
    const system = supportPrompt({ today, yesterday, weekday: weekdayName(today), language: ctx.language, customerName: customer.businessName, hasNextStep: ctx.nextSteps.length > 0 });
    const result = await runToolLoop({
      llm: this.llm,
      model: this.options.model,
      system,
      userMessage: withConversation(ctx),
      tools,
      maxIterations: this.options.maxIterations,
      maxTokens: 1000,
    });

    const base = { agent: this.name, sources: [], toolsUsed: result.toolsUsed, usage: result.usage, evidence: result.evidence };
    if (result.interrupt) {
      // FR18: the gated tool did NOT run. The checkpoint goes to the operator queue.
      const checkpoint: ApprovalCheckpoint = {
        agent: 'support', provider: this.options.provider ?? 'unknown', model: this.options.model, system, language: ctx.language,
        messages: result.interrupt.messages, pendingCall: result.interrupt.pendingCall, siblingResults: result.interrupt.siblingResults,
      };
      return { ...base, answer: '', approval: { checkpoint, proposedAction: { tool: checkpoint.pendingCall.name, input: checkpoint.pendingCall.input } } };
    }
    return {
      ...base,
      answer: result.text,
      ...(ticketId ? { handoff: { reason: 'support_ticket_opened', ticketId } } : {}),
      ...(!ticketId && (result.hitIterationLimit || !result.text) ? { handoff: { reason: 'support_agent_incomplete' } } : {}),
    };
  }

  /**
   * After the operator decides: run the approved action once (idempotent by handoff id), then
   * continue the SAME agent run from the checkpoint with the tool result — the earlier tool calls
   * are not repeated. Tools are bound to the conversation owner, never to the operator.
   */
  async resume(handoff: Handoff, decision: { approved: boolean; note?: string }): Promise<string> {
    const checkpoint = handoff.checkpoint as ApprovalCheckpoint;
    const tools = createSupportTools(this.repo, handoff.ownerId);
    const language = checkpoint.language;
    const note = decision.note ?? '';

    let gatedResult: ToolResultContent;
    let ticketId = '';
    if (decision.approved) {
      const tool = tools.find((t) => t.spec.name === checkpoint.pendingCall.name)!;
      const out = await tool.execute(checkpoint.pendingCall.input, { idempotencyKey: handoff.id });
      if (!out.isError) ticketId = (JSON.parse(out.content) as { ticket_id: string }).ticket_id;
      this.audit?.write({ actor: 'system', action: 'approval.executed', subject: handoff.id, details: { tool: checkpoint.pendingCall.name, ticket_id: ticketId || null, error: out.isError ?? false } });
      gatedResult = { type: 'tool_result', tool_use_id: checkpoint.pendingCall.id, content: `approved_by_operator${note ? ` (${note})` : ''}: ${out.content}`, ...(out.isError ? { is_error: true } : {}) };
    } else {
      gatedResult = { type: 'tool_result', tool_use_id: checkpoint.pendingCall.id, content: `rejected_by_operator: ${note || 'no reason given'}`, is_error: true };
    }

    const fallback = decision.approved ? (APPROVED_FALLBACK[language] ?? APPROVED_FALLBACK.en!)(ticketId) : (REJECTED_FALLBACK[language] ?? REJECTED_FALLBACK.en!)(note);
    // A checkpoint is only valid for the provider and model that produced it.
    if (checkpoint.provider !== (this.options.provider ?? 'unknown') || checkpoint.model !== this.options.model) return fallback;
    try {
      const result = await runToolLoop({
        llm: this.llm,
        model: this.options.model,
        system: checkpoint.system,
        userMessage: '',
        initialMessages: [...checkpoint.messages, { role: 'user', content: [...checkpoint.siblingResults, gatedResult] }],
        tools: tools.filter((t) => !t.requiresApproval),
        maxIterations: this.options.maxIterations,
        maxTokens: 1000,
      });
      const text = result.text.trim();
      if (!text) return fallback;
      // The protocol of the side effect is a fact the merchant must get, whatever the model wrote.
      return decision.approved && ticketId && !text.includes(ticketId) ? `${text}

${fallback}` : text;
    } catch {
      return fallback;
    }
  }
}
