import type { AgentResult, Route } from '../types.js';
import { maskPII } from './pii.js';

export interface OutputCheck {
  answer: string;
  /** Set when the answer should be complemented by a human handoff. */
  handoffReason?: 'knowledge_gap' | 'ungrounded_answer';
}

/**
 * Output guardrail: a knowledge answer must be grounded (retrieved or web sources) unless the
 * agent explicitly said it could not find the information. Also masks any PII echoed back.
 */
export function checkOutput(route: Route, final: AgentResult, allSourcesCount: number): OutputCheck {
  const answer = maskPII(final.answer).text;
  if (final.agent !== 'knowledge' || route === 'blocked') return { answer };
  if (final.notFound) return { answer, handoffReason: 'knowledge_gap' };
  if (allSourcesCount === 0) return { answer, handoffReason: 'ungrounded_answer' };
  return { answer };
}
