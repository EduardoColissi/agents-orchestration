import type { LLMClient, LLMMessage, ToolResultContent } from '../llm/client.js';
import type { Agent, AgentContext, AgentResult, ToolEvidence } from '../types.js';
import { emptyUsage } from '../types.js';
import type { CustomerRepository } from '../support/repository.js';
import { createSupportTools, findTerminal } from '../support/tools.js';
import { addDays, localDate, weekdayName } from '../support/dates.js';
import type { ApprovalResumer } from '../hitl/service.js';
import type { AuditLog } from '../store/audit.js';
import type { Handoff } from '../store/handoffs.js';
import { supportPrompt } from './prompts.js';
import { runToolLoop, type AgentTool, type ToolLoopInterrupt, type ToolLoopResult } from './toolLoop.js';
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

/**
 * The gated replacement tool is only offered when the merchant asks to replace a MACHINE: a replacement
 * verb plus a machine reference, and none of the other things merchants "trocam" (chip, paper roll,
 * password, bank account…). "Minha nova maquininha não liga" is a support question, not a request.
 */
const REPLACE_VERB = /(?<!\p{L})(trocar|troca|trocando|substitu\p{L}*|replac\p{L}*|exchang\p{L}*)(?!\p{L})/iu;
const MACHINE = /(?<!\p{L})(maquininha|m[aá]quina|terminal|machine|get (smart|mini|cl[aá]ssica|tap))(?!\p{L})|\b(GS|GC)-\d/iu;
const OTHER_OBJECT = /(?<!\p{L})(chip|bobina|papel|senha|password|conta|account|carregador|charger|cabo|cable)(?!\p{L})/iu;
export const wantsMachineReplacement = (text: string) => REPLACE_VERB.test(text) && MACHINE.test(text) && !OTHER_OBJECT.test(text);

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

/** Wording that would contradict an approval that already happened. */
const STILL_PENDING = /(aguard|pendente|pending|ser[áa] (analisad|avaliad|aprovad|verificad)|ir[áa] (verificar|aprovar|analisar|confirmar)|will (review|verify|approve|confirm)|wait for (approval|confirmation)|once (it is )?approved)/i;

const NOT_OWNED: Record<string, (serial: string) => string> = {
  pt: (s) => `Não encontrei a maquininha ${s} na sua conta, então não abri o pedido de troca. Confira o número de série no aplicativo Getnet e me diga de novo.`,
  es: (s) => `No encontré la terminal ${s} en tu cuenta, así que no abrí la solicitud de cambio. Revisa el número de serie en la app de Getnet y dímelo de nuevo.`,
  en: (s) => `I couldn't find card machine ${s} in your account, so I didn't open the replacement request. Please check the serial number in the Getnet app and tell me again.`,
};

const APPROVED_BUT_FAILED: Record<string, (id: string) => string> = {
  pt: (id) => `A troca foi aprovada, mas não consegui registrar o envio agora. Um especialista vai concluir pelo protocolo ${id}.`,
  es: (id) => `El cambio fue aprobado, pero no pude registrar el envío ahora. Un especialista lo completará con el protocolo ${id}.`,
  en: (id) => `The replacement was approved, but I couldn't register the shipment right now. A specialist will complete it with ticket ${id}.`,
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
    const wantsReplacement = wantsMachineReplacement(`${ctx.message} ${ctx.query}`);
    const tools = createSupportTools(this.repo, ctx.userId, this.options.now).filter((t) => wantsReplacement || !t.requiresApproval).map((tool): AgentTool =>
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
    let result = await runToolLoop({
      llm: this.llm,
      model: this.options.model,
      system,
      userMessage: withConversation(ctx),
      tools,
      maxIterations: this.options.maxIterations,
      maxTokens: 1000,
    });

    // The merchant explicitly asked for a new machine but the model answered without proposing it
    // (llama3.1:8b does this often): one schema-constrained call proposes it, still gated by an operator.
    // (Also when the model tried the tool with invalid input and then gave up.)
    if (!result.interrupt && wantsReplacement) {
      const forced = await this.proposeReplacement(system, result, tools);
      if (forced) result = { ...result, interrupt: forced, toolsUsed: [...new Set([...result.toolsUsed, forced.pendingCall.name])] };
    }

    const base = { agent: this.name, sources: [], toolsUsed: result.toolsUsed, usage: result.usage, evidence: result.evidence };
    // Never queue an approval for a machine this merchant does not have (typo, another merchant's serial).
    const proposedSerial = String((result.interrupt?.pendingCall.input as { serial?: unknown } | undefined)?.serial ?? '');
    if (result.interrupt && !findTerminal(await this.repo.getTerminals(ctx.userId), proposedSerial)) {
      return { ...base, answer: (NOT_OWNED[ctx.language] ?? NOT_OWNED.en!)(proposedSerial) };
    }
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

  private async proposeReplacement(system: string, result: ToolLoopResult, tools: AgentTool[]): Promise<ToolLoopInterrupt | null> {
    const gated = tools.find((t) => t.requiresApproval);
    if (!gated) return null;
    const messages = [
      ...result.messages,
      { role: 'assistant' as const, content: result.text || '(no answer)' },
      { role: 'user' as const, content: 'The merchant explicitly asked for a replacement machine. Request it now with request_terminal_replacement, using the serial returned by get_terminal_status.' },
    ];
    try {
      const response = await this.llm.complete({ model: this.options.model, system, messages, tools: [gated.spec], forceTool: gated.spec.name, maxTokens: 300 });
      const call = response.toolCalls.find((c) => c.name === gated.spec.name);
      if (!call || gated.validate?.(call.input)) return null;
      return { pendingCall: { id: call.id, name: call.name, input: call.input }, siblingResults: [], messages: [...messages, { role: 'assistant', content: response.assistantContent }] };
    } catch {
      return null;
    }
  }

  /**
   * After the operator decides: run the approved action once (idempotent by handoff id), then
   * continue the SAME agent run from the checkpoint with the tool result — the earlier tool calls
   * are not repeated. Tools are bound to the conversation owner, never to the operator.
   */
  async resume(handoff: Handoff, decision: { approved: boolean; note?: string }): Promise<{ content: string; evidence: ToolEvidence[] }> {
    const checkpoint = handoff.checkpoint as ApprovalCheckpoint;
    const tools = createSupportTools(this.repo, handoff.ownerId, this.options.now);
    const language = checkpoint.language;
    const note = decision.note ?? '';

    let gatedResult: ToolResultContent;
    let ticketId = '';
    if (decision.approved) {
      const tool = tools.find((t) => t.spec.name === checkpoint.pendingCall.name)!;
      const out = await tool.execute(checkpoint.pendingCall.input, { idempotencyKey: handoff.id });
      if (!out.isError) ticketId = (JSON.parse(out.content) as { ticket_id: string }).ticket_id;
      this.audit?.write({ actor: 'system', action: 'approval.executed', subject: handoff.id, details: { tool: checkpoint.pendingCall.name, ticket_id: ticketId || null, error: out.isError ?? false } });
      const outcome = out.isError
        ? 'the operator APPROVED it, but running it failed; apologize and say a specialist will finish it with the protocol'
        : 'the operator APPROVED it and it is DONE (not pending): tell the merchant it was approved and quote the ticket id';
      gatedResult = { type: 'tool_result', tool_use_id: checkpoint.pendingCall.id, content: `approved_by_operator — ${outcome}${note ? `. Operator note: ${note}` : ''}. Result: ${out.content}`, ...(out.isError ? { is_error: true } : {}) };
    } else {
      gatedResult = { type: 'tool_result', tool_use_id: checkpoint.pendingCall.id, content: `rejected_by_operator — the operator did NOT approve it; tell the merchant it was not approved and why. Reason: ${note || 'no reason given'}`, is_error: true };
    }
    const evidence: ToolEvidence[] = [{ name: checkpoint.pendingCall.name, input: checkpoint.pendingCall.input, output: gatedResult.content, isError: gatedResult.is_error === true }];

    const fallback = !decision.approved
      ? (REJECTED_FALLBACK[language] ?? REJECTED_FALLBACK.en!)(note)
      : ticketId
        ? (APPROVED_FALLBACK[language] ?? APPROVED_FALLBACK.en!)(ticketId)
        : (APPROVED_BUT_FAILED[language] ?? APPROVED_BUT_FAILED.en!)(handoff.id);
    // A checkpoint is only valid for the provider and model that produced it.
    if (checkpoint.provider !== (this.options.provider ?? 'unknown') || checkpoint.model !== this.options.model) return { content: fallback, evidence };
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
      evidence.push(...result.evidence);
      const text = result.text.trim();
      // The decision and the protocol are facts the merchant must get exactly: a resumed answer that
      // is empty or contradicts an approval ("it will be reviewed") is replaced by the template.
      if (!text || (decision.approved && STILL_PENDING.test(text))) return { content: fallback, evidence };
      return { content: decision.approved && ticketId && !text.includes(ticketId) ? `${fallback}\n\n${text}` : text, evidence };
    } catch {
      return { content: fallback, evidence };
    }
  }
}
