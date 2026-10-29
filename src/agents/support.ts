import type { LLMClient } from '../llm/client.js';
import type { Agent, AgentContext, AgentResult } from '../types.js';
import { emptyUsage } from '../types.js';
import type { CustomerRepository } from '../support/repository.js';
import { createSupportTools } from '../support/tools.js';
import { addDays, localDate, weekdayName } from '../support/dates.js';
import { supportPrompt } from './prompts.js';
import { runToolLoop, type AgentTool } from './toolLoop.js';
import { withConversation } from './knowledge.js';

export interface SupportAgentOptions {
  model: string;
  maxIterations: number;
  now?: () => Date;
}

const NOT_FOUND_MESSAGES: Record<string, string> = {
  pt: 'Não encontrei uma conta Getnet vinculada a este usuário, então não consigo consultar vendas, recebimentos ou maquininhas. Confira se você está logado com o usuário certo ou, se preferir, posso te encaminhar para um atendente humano.',
  es: 'No encontré una cuenta Getnet vinculada a este usuario, así que no puedo consultar ventas, depósitos ni terminales. Verifica que hayas iniciado sesión con el usuario correcto o, si prefieres, puedo derivarte a un agente humano.',
  en: "I couldn't find a Getnet account linked to this user, so I can't check sales, deposits or card machines. Please check you're signed in with the right user, or I can hand you over to a human agent.",
};

/** Customer Support Agent: resolves account-specific requests with tools bound to the requesting user. */
export class SupportAgent implements Agent {
  readonly name = 'support' as const;

  constructor(
    private readonly llm: LLMClient,
    private readonly repo: CustomerRepository,
    private readonly options: SupportAgentOptions,
  ) {}

  async run(ctx: AgentContext): Promise<AgentResult> {
    // FR7: unknown customer → deterministic answer + handoff, no LLM call.
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
    const result = await runToolLoop({
      llm: this.llm,
      model: this.options.model,
      system: supportPrompt({ today, yesterday, weekday: weekdayName(today), language: ctx.language, customerName: customer.businessName, hasNextStep: ctx.nextSteps.length > 0 }),
      userMessage: withConversation(ctx),
      tools,
      maxIterations: this.options.maxIterations,
      maxTokens: 1000,
    });

    return {
      agent: this.name,
      answer: result.text,
      sources: [],
      toolsUsed: result.toolsUsed,
      usage: result.usage,
      evidence: result.evidence,
      ...(ticketId ? { handoff: { reason: 'support_ticket_opened', ticketId } } : {}),
      ...(!ticketId && (result.hitIterationLimit || !result.text) ? { handoff: { reason: 'support_agent_incomplete' } } : {}),
    };
  }
}
