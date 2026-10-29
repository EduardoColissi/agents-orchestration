import type { AgentResult } from '../types.js';

export type PlanStep = 'knowledge' | 'support';

export interface Replan {
  after: PlanStep;
  signal: string;
  /** add_knowledge: run Knowledge next · escalate: hand over to a person · finish: answer without a person. */
  action: 'add_knowledge' | 'escalate' | 'finish';
}

/** Hard cap on specialists per request, whatever the replanner decides. */
export const MAX_PLAN_STEPS = 3;

/**
 * Replanning (observe → decide). Deterministic on purpose: it reacts to structured signals in the
 * tool results, not to another LLM opinion, so it is cheap, testable and cannot loop.
 *  - Support's tool crashed → the answer rests on missing data: escalate to a person.
 *  - Support found an offline machine the Router did not plan troubleshooting for → add Knowledge.
 *  - Knowledge could not reach live web data → finish: a person cannot fetch the weather either,
 *    so the "not found" answer is final instead of becoming a queue item.
 */
export function decideNext(plan: PlanStep[], last: AgentResult): Replan | null {
  const evidence = last.evidence ?? [];
  if (last.agent === 'support') {
    if (evidence.some((e) => e.isError && e.output.startsWith('Tool failed'))) return { after: 'support', signal: 'tool_error', action: 'escalate' };
    const offline = evidence.some((e) => e.name === 'get_terminal_status' && /"status":\s*"offline"/.test(e.output));
    if (offline && !plan.includes('knowledge') && plan.length < MAX_PLAN_STEPS) return { after: 'support', signal: 'terminal_offline', action: 'add_knowledge' };
  }
  if (last.agent === 'knowledge' && evidence.some((e) => e.name === 'web_search' && e.isError && /unavailable|failed/i.test(e.output))) {
    return { after: 'knowledge', signal: 'live_data_unavailable', action: 'finish' };
  }
  return null;
}
