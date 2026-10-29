import { z } from 'zod';
import type { LLMClient } from '../llm/client.js';
import { emptyUsage, type TokenUsage } from '../types.js';
import { ROUTER_PROMPT } from './prompts.js';

export const RouteDecisionSchema = z.object({
  route: z.enum(['knowledge', 'support', 'escalation', 'blocked']),
  plan: z.array(z.enum(['knowledge', 'support'])).max(2),
  confidence: z.number().min(0).max(1),
  language: z.string().min(2).max(8),
  // Truncate instead of failing: a long explanation must not discard a valid route.
  reason: z.string().transform((r) => r.slice(0, 300)),
  /** The message rewritten as a self-contained question (follow-ups resolved from the context). */
  standalone_query: z.string().transform((q) => q.slice(0, 500)),
});

export type RouteDecision = z.infer<typeof RouteDecisionSchema>;

export interface RouterOutcome {
  decision: RouteDecision;
  usage: TokenUsage;
  /** True when the model output was missing/invalid and we fell back to escalation (FR1). */
  fallback: boolean;
  error?: string;
}

const { $schema: _s, ...ROUTE_DECISION_JSON_SCHEMA } = z.toJSONSchema(RouteDecisionSchema, { io: 'input' }) as Record<string, unknown>;

/** Router Agent: classifies the message into a route and an execution plan via forced tool use. */
export class RouterAgent {
  readonly name = 'router' as const;

  constructor(private readonly llm: LLMClient, private readonly model: string) {}

  async decide(message: string, fallbackLanguage: string, context = ''): Promise<RouterOutcome> {
    try {
      const response = await this.llm.complete({
        model: this.model,
        system: ROUTER_PROMPT,
        messages: [{ role: 'user', content: `${context ? `${context}\n` : ''}<merchant_message>\n${message}\n</merchant_message>` }],
        tools: [{ name: 'route_decision', description: 'Record the routing decision.', inputSchema: ROUTE_DECISION_JSON_SCHEMA }],
        forceTool: 'route_decision',
        maxTokens: 500,
      });
      const call = response.toolCalls.find((c) => c.name === 'route_decision');
      const parsed = RouteDecisionSchema.safeParse(call?.input);
      if (!parsed.success) {
        return this.fallback(fallbackLanguage, response.usage, call ? z.prettifyError(parsed.error) : 'no route_decision tool call');
      }
      return { decision: normalizePlan(parsed.data), usage: response.usage, fallback: false };
    } catch (err) {
      return this.fallback(fallbackLanguage, emptyUsage(), (err as Error).message);
    }
  }

  private fallback(language: string, usage: TokenUsage, error: string): RouterOutcome {
    return {
      decision: { route: 'escalation', plan: [], confidence: 0, language, reason: 'router_failure', standalone_query: '' },
      usage,
      fallback: true,
      error,
    };
  }
}

/**
 * Makes the plan consistent with the route instead of rejecting small inconsistencies.
 * A two-step plan is always support → knowledge (knowledge consumes the account findings).
 */
export function normalizePlan(d: RouteDecision): RouteDecision {
  if (d.route === 'escalation' || d.route === 'blocked') return { ...d, plan: [] };
  const steps = new Set([d.route, ...d.plan]);
  if (steps.has('support') && steps.has('knowledge')) return { ...d, route: 'support', plan: ['support', 'knowledge'] };
  return { ...d, plan: [d.route] };
}
