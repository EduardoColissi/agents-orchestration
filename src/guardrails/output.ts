import type { AgentResult, Route } from '../types.js';
import { maskPII } from './pii.js';

export interface OutputCheck {
  answer: string;
  /** Set when the answer should be complemented by a human handoff. */
  handoffReason?: 'knowledge_gap' | 'ungrounded_answer';
  /** Amounts in the answer that no evidence of the turn contains; already replaced in `answer`. */
  redactedValues?: string[];
}

const REDACTED: Record<string, string> = { pt: '[valor não confirmado]', es: '[valor no confirmado]', en: '[unverified value]' };

/**
 * Output guardrail: a knowledge answer must be grounded (retrieved or web sources) unless the
 * agent explicitly said it could not find the information, and every amount or percentage in it
 * must come from the evidence of the turn. Also masks any PII echoed back.
 */
export function checkOutput(route: Route, final: AgentResult, allSourcesCount: number, evidenceText = '', language = 'en'): OutputCheck {
  const answer = maskPII(final.answer).text;
  if (final.agent !== 'knowledge' || route === 'blocked') return { answer };
  if (final.notFound) return { answer, handoffReason: 'knowledge_gap' };
  if (allSourcesCount === 0) return { answer, handoffReason: 'ungrounded_answer' };
  const { text, redacted } = redactUngroundedAmounts(answer, evidenceText, REDACTED[language] ?? REDACTED.en!);
  return redacted.length ? { answer: text, handoffReason: 'ungrounded_answer', redactedValues: redacted } : { answer };
}

/** Money and percentages: "R$ 6,03", "BRL 438.90", "US$ 1,234.56", "2,99%", "6,03 reais". */
const AMOUNT = /(?:R\$|US\$|BRL|USD|EUR|€|£|\$)\s?\d[\d.,]*|\d[\d.,]*\s?(?:%|(?:reais|d[oó]lares|euros|BRL|USD|EUR)\b)/gi;
const NUMBER = /\d[\d.,]*/g;

/**
 * Numeric grounding: every amount or percentage in a Knowledge answer must appear in the evidence
 * of the turn (tool outputs, excerpts, web snippets), allowing for formatting (6.0249 / 6,0249) and
 * rounding to the answer's decimals. The 8B answered "R$ 5,92" for the euro with nothing but Getnet
 * pages as evidence: such a value is replaced by the placeholder and reported to the caller.
 */
export function redactUngroundedAmounts(answer: string, evidenceText: string, placeholder: string): { text: string; redacted: string[] } {
  const known: number[] = [];
  for (const token of evidenceText.match(NUMBER) ?? []) for (const { value } of interpretations(token)) known.push(value);
  const redacted: string[] = [];
  const text = answer.replace(AMOUNT, (match) => {
    const token = match.match(NUMBER)?.[0]?.replace(/[.,]+$/, '');
    if (!token) return match;
    const grounded = interpretations(token).some(({ value, decimals }) => known.some((k) => Math.abs(k - value) <= 10 ** -decimals + 1e-9));
    if (grounded) return match;
    redacted.push(match.trim());
    return match.replace(token, placeholder);
  });
  return { text, redacted };
}

/** The readings of a number written the Brazilian or the English way ("6,03" → 6.03; "1.234" → 1234 or 1.234). */
function interpretations(raw: string): Array<{ value: number; decimals: number }> {
  const token = raw.replace(/[.,]+$/, '');
  const out: Array<{ value: number; decimals: number }> = [];
  const add = (s: string, decimals: number) => {
    const value = Number(s);
    if (Number.isFinite(value)) out.push({ value, decimals });
  };
  const dots = (token.match(/\./g) ?? []).length;
  const commas = (token.match(/,/g) ?? []).length;
  if (dots && commas) {
    const decimalSep = token.lastIndexOf('.') > token.lastIndexOf(',') ? '.' : ',';
    const cleaned = token.replace(decimalSep === '.' ? /,/g : /\./g, '').replace(',', '.');
    add(cleaned, cleaned.split('.')[1]?.length ?? 0);
  } else if (dots + commas === 1) {
    const [int = '', frac = ''] = token.split(/[.,]/);
    add(`${int}.${frac}`, frac.length);
    if (frac.length === 3) add(`${int}${frac}`, 0);
  } else if (dots + commas > 1) {
    add(token.replace(/[.,]/g, ''), 0);
  } else {
    add(token, 0);
  }
  return out;
}
