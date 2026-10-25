/** Shared domain types used across agents, orchestrator and API. */

export type AgentName = 'router' | 'knowledge' | 'support' | 'escalation' | 'personality';
export type Route = 'knowledge' | 'support' | 'escalation' | 'blocked';

export interface Source {
  title: string;
  url: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
}

export const emptyUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, webSearches: 0 });

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    webSearches: a.webSearches + b.webSearches,
  };
}

/** Everything an agent needs to do its job. Built by the orchestrator and passed down. */
export interface AgentContext {
  traceId: string;
  userId: string;
  /** User message after PII masking. */
  message: string;
  /** ISO 639-1 code detected by the Router (e.g. "en", "pt"). */
  language: string;
  /** Outputs of earlier steps in the same plan (FR2). */
  previous: AgentResult[];
  /** Agents that will run after this one in the same plan. */
  nextSteps: AgentName[];
}

export interface HandoffRequest {
  reason: string;
  ticketId?: string;
}

export interface AgentResult {
  agent: AgentName;
  answer: string;
  sources: Source[];
  toolsUsed: string[];
  usage: TokenUsage;
  /** Set when the agent could not resolve the request and a human should take over. */
  handoff?: HandoffRequest;
  /** Knowledge agent: true when it explicitly said the information was not found. */
  notFound?: boolean;
}

export interface Agent {
  readonly name: AgentName;
  run(ctx: AgentContext): Promise<AgentResult>;
}
