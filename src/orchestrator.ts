import { randomUUID } from 'node:crypto';
import type { Logger } from './observability/logger.js';
import { timed } from './observability/logger.js';
import type { RouterAgent, RouteDecision } from './agents/router.js';
import type { EscalationAgent, HandoffReason } from './agents/escalation.js';
import type { PersonalityStage } from './agents/personality.js';
import { BLOCKED_MESSAGES, checkInput } from './guardrails/input.js';
import { checkOutput } from './guardrails/output.js';
import { detectLanguage } from './guardrails/language.js';
import { maskPII } from './guardrails/pii.js';
import { addUsage, emptyUsage, type Agent, type AgentName, type AgentResult, type Route, type Source, type TokenUsage, type ToolEvidence } from './types.js';
import { dedupeSources } from './agents/toolLoop.js';
import { newHandoffId, type HandoffKind } from './store/handoffs.js';

export interface ChatRequest {
  message: string;
  userId: string;
  /** Conversation context block (memory), '' or absent for a new conversation. */
  context?: string;
  /** The conversation's open handoff: no second one is opened while it is pending. */
  openHandoff?: { id: string; kind: HandoffKind; status: string } | null;
  /** Propagated from the HTTP layer so logs and errors share the same id. */
  traceId?: string;
}

export interface ChatResponse {
  trace_id: string;
  conversation_id?: string;
  answer: string;
  route: Route;
  agents: AgentName[];
  sources: Source[];
  tools_used: string[];
  handoff: { required: boolean; reason: string | null; ticket_id: string | null; handoff_id?: string | null; kind?: HandoffKind | null; status?: string | null };
  latency_ms: number;
}

/** What the turn left behind: persisted by the chat service, read by operators and the judge. */
export interface TurnEvidence {
  route_decision: RouteDecision | null;
  standalone_query: string | null;
  steps: Array<{ agent: AgentName; tools: ToolEvidence[] }>;
  sources: Source[];
}

export interface OrchestratorTurn {
  response: ChatResponse;
  /** The merchant message after PII masking (what gets persisted). */
  maskedMessage: string;
  /** false for blocked turns: stored for audit, never sent back to an LLM. */
  inContext: boolean;
  evidence: TurnEvidence;
  /** A new handoff to put in the operator queue (persisted with the turn). */
  handoffRequest: HandoffRequestSpec | null;
}

export interface HandoffRequestSpec {
  id: string;
  kind: HandoffKind;
  reason: string;
  language: string;
  checkpoint?: unknown;
  proposedAction?: { tool: string; input: unknown };
}

interface TurnState {
  message: string;
  decision: RouteDecision | null;
  standaloneQuery: string | null;
  results: AgentResult[];
  openHandoff: ChatRequest['openHandoff'];
  handoffRequest: HandoffRequestSpec | null;
}

export interface OrchestratorDeps {
  router: RouterAgent;
  agents: Record<'knowledge' | 'support', Agent>;
  escalation: EscalationAgent;
  personality: PersonalityStage;
  logger: Logger;
  confidenceThreshold: number;
}

const UNGROUNDED_NOTE: Record<string, string> = {
  pt: '\n\n_Não encontrei fontes oficiais que confirmem esta resposta; confirme com a central Getnet._',
  es: '\n\n_No encontré fuentes oficiales que confirmen esta respuesta; confírmalo con la central de Getnet._',
  en: "\n\n_I couldn't find official sources confirming this answer; please confirm with Getnet customer service._",
};

/**
 * Orchestrates one request: input guardrail → Router → plan execution (agents called in
 * sequence with a shared context) → output guardrail → optional human handoff.
 * Communication between agents is direct async function calls through this class.
 */
export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async handle(request: ChatRequest): Promise<OrchestratorTurn> {
    const turn: TurnState = { message: request.message, decision: null, standaloneQuery: null, results: [], openHandoff: request.openHandoff ?? null, handoffRequest: null };
    const response = await this.run(request, turn);
    response.handoff = { handoff_id: null, kind: null, status: null, ...response.handoff };
    return {
      response,
      handoffRequest: turn.handoffRequest,
      maskedMessage: turn.message,
      inContext: response.route !== 'blocked',
      evidence: {
        route_decision: turn.decision,
        standalone_query: turn.standaloneQuery,
        steps: turn.results.map((r) => ({ agent: r.agent, tools: r.evidence ?? [] })),
        sources: response.sources,
      },
    };
  }

  private async run(request: ChatRequest, turn: TurnState): Promise<ChatResponse> {
    const started = performance.now();
    const traceId = request.traceId ?? randomUUID();
    const log = this.deps.logger.child({ trace_id: traceId, user_id: request.userId });
    const { text: message, found: piiFound } = maskPII(request.message);
    turn.message = message;
    const guessedLanguage = detectLanguage(message);
    const executed: AgentName[] = [];
    let usage: TokenUsage = emptyUsage();

    log.info({ stage: 'request', message, pii_masked: piiFound }, 'request received');

    // 1. Input guardrail — no LLM cost for obvious attacks.
    const input = checkInput(message, request.userId);
    if (!input.allowed) {
      log.warn({ stage: 'guardrail_input', category: input.category, reason: input.reason }, 'request blocked');
      return this.finish(turn, log, started, traceId, usage, {
        answer: BLOCKED_MESSAGES[guessedLanguage] ?? BLOCKED_MESSAGES.en!,
        route: 'blocked',
        agents: executed,
        results: [],
        handoff: { required: false, reason: input.category ?? 'blocked', ticket_id: null },
        language: guessedLanguage,
      });
    }

    // 2. Router.
    const routed = await timed(() => this.deps.router.decide(message, guessedLanguage, request.context ?? ''));
    const { decision, fallback, error } = routed.value;
    usage = addUsage(usage, routed.value.usage);
    turn.decision = fallback ? null : decision;
    // Follow-ups are rewritten by the Router; the rewrite goes through the input guardrail too.
    const query = decision.standalone_query?.trim() || message;
    turn.standaloneQuery = query === message ? null : query;
    if (query !== message && !checkInput(query, request.userId).allowed) {
      log.warn({ stage: 'guardrail_input', standalone_query: query }, 'rewritten query blocked');
      return this.finish(turn, log, started, traceId, usage, {
        answer: BLOCKED_MESSAGES[guessedLanguage] ?? BLOCKED_MESSAGES.en!, route: 'blocked', agents: executed, results: [],
        handoff: { required: false, reason: 'prompt_injection', ticket_id: null }, language: guessedLanguage,
      });
    }
    executed.push('router');
    log.info({ stage: 'router', agent: 'router', latency_ms: routed.ms, ...routeLog(decision), fallback, error, tokens: routed.value.usage }, 'routing decision');

    const language = normalizeLanguage(decision.language) ?? guessedLanguage;

    if (decision.route === 'blocked') {
      return this.finish(turn, log, started, traceId, usage, {
        answer: BLOCKED_MESSAGES[language] ?? BLOCKED_MESSAGES.en!,
        route: 'blocked',
        agents: executed,
        results: [],
        handoff: { required: false, reason: 'router_blocked', ticket_id: null },
        language,
      });
    }

    const escalationReason: HandoffReason | null = fallback
      ? 'router_failure'
      : decision.route === 'escalation'
        ? 'user_requested'
        : decision.confidence < this.deps.confidenceThreshold
          ? 'low_confidence'
          : null;
    if (escalationReason) {
      return this.escalate(turn, log, started, traceId, usage, executed, { userId: request.userId, language, reason: escalationReason, message, results: [] });
    }

    // 3. Execute the plan, passing earlier results forward (FR2).
    const results: AgentResult[] = [];
    for (const [index, step] of decision.plan.entries()) {
      const agent = this.deps.agents[step];
      try {
        const run = await timed(() =>
          agent.run({ traceId, userId: request.userId, message, history: request.context ?? '', query, language, previous: [...results], nextSteps: decision.plan.slice(index + 1) }),
        );
        results.push(run.value);
        executed.push(step);
        usage = addUsage(usage, run.value.usage);
        log.info(
          { stage: 'agent', agent: step, latency_ms: run.ms, tools: run.value.toolsUsed, sources: run.value.sources.length, tokens: run.value.usage, handoff: run.value.handoff?.reason },
          'agent finished',
        );
        // An agent that cannot continue (e.g. unknown customer) stops the plan.
        if (run.value.handoff && run.value.handoff.reason !== 'support_ticket_opened') break;
      } catch (err) {
        log.error({ stage: 'agent', agent: step, err }, 'agent failed');
        return this.escalate(turn, log, started, traceId, usage, executed, { userId: request.userId, language, reason: 'agent_error', message, results });
      }
    }

    const final = results.at(-1)!;
    const allSources = dedupeSources(results.flatMap((r) => r.sources));

    // 4. Output guardrail.
    const output = checkOutput(decision.route, final, allSources.length);
    let answer = output.answer;
    const agentHandoff = results.find((r) => r.handoff)?.handoff;
    log.info({ stage: 'guardrail_output', handoff_reason: output.handoffReason ?? null }, 'output checked');

    if (output.handoffReason === 'ungrounded_answer') {
      answer += UNGROUNDED_NOTE[language] ?? UNGROUNDED_NOTE.en!;
      return this.finish(turn, log, started, traceId, usage, {
        answer, route: decision.route, agents: executed, results,
        handoff: { required: true, reason: 'ungrounded_answer', ticket_id: null }, language,
      });
    }

    // 5. Human handoff when an agent or the output check asks for it.
    const handoffReason = output.handoffReason ?? (agentHandoff && agentHandoff.reason !== 'support_ticket_opened' ? agentHandoff.reason : null);
    if (handoffReason === 'customer_not_found') {
      // Offer a handoff instead of opening a ticket for an account that does not exist (FR7).
      return this.finish(turn, log, started, traceId, usage, {
        answer, route: decision.route, agents: executed, results,
        handoff: { required: true, reason: handoffReason, ticket_id: null }, language,
      });
    }
    if (handoffReason) {
      const existingTicketId = results.find((r) => r.handoff?.ticketId)?.handoff?.ticketId ?? null;
      const { result: escalation, handoff } = this.openAssist(turn, language, handoffReason);
      executed.push('escalation');
      return this.finish(turn, log, started, traceId, usage, {
        answer: `${answer}\n\n${escalation.answer}`, route: decision.route, agents: executed, results: [...results, escalation],
        handoff: { ...handoff, ticket_id: existingTicketId }, language,
      });
    }

    return this.finish(turn, log, started, traceId, usage, {
      answer, route: decision.route, agents: executed, results,
      handoff: { required: false, reason: agentHandoff?.reason ?? null, ticket_id: agentHandoff?.ticketId ?? null }, language,
    });
  }

  private async escalate(
    turn: TurnState,
    log: Logger, started: number, traceId: string, usage: TokenUsage, executed: AgentName[],
    p: { userId: string; language: string; reason: HandoffReason; message: string; results: AgentResult[] },
  ): Promise<ChatResponse> {
    const { result, handoff } = this.openAssist(turn, p.language, p.reason);
    executed.push('escalation');
    log.info({ stage: 'agent', agent: 'escalation', reason: p.reason, handoff_id: handoff.handoff_id }, 'escalated to human');
    return this.finish(turn, log, started, traceId, usage, {
      answer: result.answer, route: 'escalation', agents: executed, results: [...p.results, result], handoff, language: p.language,
    });
  }

  /** Queues an `assist` handoff, or points to the conversation's open one (one at a time, FR23). */
  private openAssist(turn: TurnState, language: string, reason: string): { result: AgentResult; handoff: ChatResponse['handoff'] } {
    const open = turn.openHandoff;
    const id = open?.id ?? newHandoffId();
    if (!open) turn.handoffRequest = { id, kind: 'assist', reason, language };
    const result = this.deps.escalation.handoff({ language, reason, handoffId: id, alreadyOpen: !!open });
    return { result, handoff: { required: true, reason, ticket_id: null, handoff_id: id, kind: open?.kind ?? 'assist', status: open?.status ?? 'pending' } };
  }

  private async finish(
    turn: TurnState,
    log: Logger, started: number, traceId: string, usage: TokenUsage,
    r: { answer: string; route: Route; agents: AgentName[]; results: AgentResult[]; handoff: ChatResponse['handoff']; language: string },
  ): Promise<ChatResponse> {
    turn.results = r.results;
    // Personality stage: one brand voice for every answer, facts guaranteed unchanged.
    const styled = await timed(() => this.deps.personality.apply(r.answer, r.language));
    usage = addUsage(usage, styled.value.usage);
    if (styled.value.applied) r.agents.push('personality');
    log.info({ stage: 'personality', agent: 'personality', latency_ms: styled.ms, applied: styled.value.applied, reason: styled.value.reason, tokens: styled.value.usage }, 'personality applied');

    const response: ChatResponse = {
      trace_id: traceId,
      answer: styled.value.answer,
      route: r.route,
      agents: r.agents,
      sources: dedupeSources(r.results.flatMap((x) => x.sources)),
      tools_used: [...new Set(r.results.flatMap((x) => x.toolsUsed))],
      handoff: r.handoff,
      latency_ms: Math.round(performance.now() - started),
    };
    log.info(
      { stage: 'response', route: response.route, agents: response.agents, tools: response.tools_used, sources: response.sources.length, handoff: response.handoff, latency_ms: response.latency_ms, tokens: usage },
      'request completed',
    );
    return response;
  }
}

const routeLog = (d: RouteDecision) => ({ route: d.route, plan: d.plan, confidence: d.confidence, language: d.language, reason: d.reason });

/** "pt-BR" / "PT" → "pt"; anything that is not a 2-letter code is ignored. */
export function normalizeLanguage(code: string | undefined): string | null {
  const base = code?.trim().toLowerCase().split(/[-_]/)[0];
  return base && /^[a-z]{2}$/.test(base) ? base : null;
}
