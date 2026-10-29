import { factsOf } from '../agents/personality.js';
import type { StoredMessage } from '../store/conversations.js';
import { RECENT_MESSAGES, truncate } from './context.js';

const SUMMARY_MAX_LINES = 20;

/**
 * Rolling summary by deterministic extraction (spec FR15): messages that left the recent window
 * become one line each, with ids, serials, amounts and dates copied verbatim. No LLM, so the
 * summary can never invent a value. Returns null when nothing new left the window.
 */
export function compact(summary: string, summarizedUpto: number, inContext: StoredMessage[]): { summary: string; summarizedUpto: number } | null {
  const leaving = inContext.slice(0, Math.max(0, inContext.length - RECENT_MESSAGES)).filter((m) => m.id > summarizedUpto);
  if (leaving.length === 0) return null;
  const lines = leaving.map((m) => {
    const who = m.role === 'assistant' && m.route ? `assistant[${m.route}]` : m.role;
    const facts = factsOf(m.content);
    return `- ${who}: "${truncate(m.content, m.role === 'merchant' ? 160 : 200)}"${facts.length ? ` (facts: ${facts.join(', ')})` : ''}`;
  });
  const all = [...(summary ? summary.split('\n') : []), ...lines].slice(-SUMMARY_MAX_LINES);
  return { summary: all.join('\n'), summarizedUpto: leaving.at(-1)!.id };
}
