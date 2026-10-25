import { describe, expect, it } from 'vitest';
import { FakeLLM } from '../../src/llm/fake.js';
import { PersonalityStage, factsOf } from '../../src/agents/personality.js';

const draft = 'Your sales from 2026-10-22 (BRL 438.90 gross) will be deposited on Friday 2026-10-23. Ticket TCK-9FA8A279 is open. Decline code 51 means insufficient funds.';

describe('PersonalityStage', () => {
  it('rewrites the tone when every fact survives', async () => {
    const styled = 'Good news: your sales from 2026-10-22 (BRL 438.90 gross) land this Friday, 2026-10-23. Ticket TCK-9FA8A279 is open, and decline code 51 means insufficient funds.';
    const llm = new FakeLLM([{ text: styled }]);
    const result = await new PersonalityStage(llm, { model: 'm', enabled: true }).apply(draft, 'en');
    expect(result).toMatchObject({ applied: true, answer: styled });
    expect(llm.calls[0]!.system).toContain('voice of Getnet');
  });

  it('keeps the original when the rewrite loses or changes a fact', async () => {
    const llm = new FakeLLM([{ text: 'Your sales will be deposited soon. Ticket TCK-9FA8A279 is open.' }]);
    const result = await new PersonalityStage(llm, { model: 'm', enabled: true }).apply(draft, 'en');
    expect(result.applied).toBe(false);
    expect(result.answer).toBe(draft);
    expect(result.reason).toMatch(/facts_changed/);
  });

  it('keeps the original when disabled or when the LLM fails', async () => {
    const disabled = await new PersonalityStage(new FakeLLM([]), { model: 'm', enabled: false }).apply(draft, 'en');
    expect(disabled).toMatchObject({ applied: false, answer: draft, reason: 'disabled' });
    const failing = new FakeLLM(() => { throw new Error('529 overloaded'); });
    const failed = await new PersonalityStage(failing, { model: 'm', enabled: true }).apply(draft, 'en');
    expect(failed).toMatchObject({ applied: false, answer: draft });
    expect(failed.reason).toMatch(/error/);
  });

  it('extracts amounts, dates, codes and ids as facts', () => {
    expect(factsOf(draft)).toEqual(expect.arrayContaining(['2026-10-22', '438.90', '2026-10-23', 'TCK-9FA8A279', '51']));
  });
});
