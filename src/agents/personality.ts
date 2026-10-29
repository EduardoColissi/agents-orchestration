import type { LLMClient } from '../llm/client.js';
import { emptyUsage, type TokenUsage } from '../types.js';
import { personalityPrompt } from './prompts.js';

export interface PersonalityOptions {
  model: string;
  enabled: boolean;
}

export interface PersonalityResult {
  answer: string;
  /** false when the original answer was kept (disabled, LLM error or facts changed). */
  applied: boolean;
  usage: TokenUsage;
  reason?: string;
}

/**
 * Personality stage (diagram: agents → Personality → Output). Gives every answer the same
 * brand voice, whichever agent wrote it. Tone only: a deterministic check guarantees that
 * every number, date, code and ticket id of the original answer survives, otherwise the
 * original is returned unchanged. The stage can never make an answer less accurate.
 */
export class PersonalityStage {
  readonly name = 'personality' as const;

  constructor(private readonly llm: LLMClient, private readonly options: PersonalityOptions) {}

  async apply(answer: string, language: string): Promise<PersonalityResult> {
    if (!this.options.enabled || !answer.trim()) return { answer, applied: false, usage: emptyUsage(), reason: 'disabled' };
    try {
      const response = await this.llm.complete({
        model: this.options.model,
        system: personalityPrompt(language),
        messages: [{ role: 'user', content: `<draft>\n${answer}\n</draft>` }],
        maxTokens: 1200,
        temperature: 0.3,
      });
      const rewritten = response.text.trim();
      const missing = factsOf(answer).filter((f) => !rewritten.includes(f));
      if (!rewritten || missing.length > 0) {
        return { answer, applied: false, usage: response.usage, reason: missing.length ? `facts_changed:${missing.join(',')}` : 'empty' };
      }
      return { answer: rewritten, applied: true, usage: response.usage };
    } catch (err) {
      return { answer, applied: false, usage: emptyUsage(), reason: `error:${(err as Error).message}` };
    }
  }
}

/** Numbers, amounts, dates, codes and ticket ids that a tone rewrite must preserve verbatim. */
export function factsOf(text: string): string[] {
  const facts = text.match(/TCK-[A-Z0-9]+|HND-[A-Z0-9]+|GS-[A-Z0-9-]+|GC-[A-Z0-9-]+|\d{4}-\d{2}-\d{2}|\d+(?:[.,]\d+)+|\b\d+\b/g) ?? [];
  return [...new Set(facts)];
}
