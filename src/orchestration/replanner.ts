import type { AgentResult } from '../types.js';

export type PlanStep = 'knowledge' | 'support';

export interface Replan {
  after: PlanStep;
  signal: string;
  action: 'add_knowledge';
}

/** Hard cap on specialists per request, whatever the replanner decides. */
export const MAX_PLAN_STEPS = 3;

/**
 * Replanning (observe → decide). Deterministic on purpose: it reacts to structured signals in
 * the tool results, not to another LLM opinion, so it is cheap, testable and cannot loop.
 * Today one rule: Support found an offline machine but the plan has no troubleshooting step →
 * add Knowledge, which receives the account findings and adds the official guidance.
 */
export function decideNext(plan: PlanStep[], last: AgentResult): Replan | null {
  if (plan.length >= MAX_PLAN_STEPS) return null;
  if (last.agent === 'support' && !plan.includes('knowledge')) {
    const offline = (last.evidence ?? []).some((e) => e.name === 'get_terminal_status' && /"status":\s*"offline"/.test(e.output));
    if (offline) return { after: 'support', signal: 'terminal_offline', action: 'add_knowledge' };
  }
  return null;
}
