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
  /** Conversation context block (summary + recent messages), '' for a new conversation. */
  history: string;
  /** Self-contained question from the Router (follow-ups resolved); equals `message` otherwise. */
  query: string;
  /** Outputs of earlier steps in the same plan (FR2). */
  previous: AgentResult[];
  /** Agents that will run after this one in the same plan. */
  nextSteps: AgentName[];
}

/** One executed tool call, kept as evidence for operators and the evaluation judge. */
export interface ToolEvidence {
  name: string;
  input: unknown;
  output: string;
  isError: boolean;
  durationMs?: number;
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
  /** Tool calls executed by this agent, with their (masked) outputs. */
  evidence?: ToolEvidence[];
  /** Support agent: the run stopped before an approval-gated tool (HITL checkpoint). */
  approval?: { checkpoint: unknown; proposedAction: { tool: string; input: unknown } };
  /** Knowledge agent: true when it explicitly said the information was not found. */
  notFound?: boolean;
}

export interface Agent {
  readonly name: AgentName;
  run(ctx: AgentContext): Promise<AgentResult>;
}
