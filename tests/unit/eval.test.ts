import { describe, expect, it } from 'vitest';
import { FakeLLM } from '../../src/llm/fake.js';
import { Judge, familyOf, parseScores } from '../../eval/judge.js';
import { canaryCaught, gate, summarize, toBaseline, type RunRecord } from '../../eval/report.js';

const scores = (g: number, c = g, safety: 'pass' | 'fail' = 'pass') => ({ groundedness: g, correctness: c, relevance: 4, helpfulness: 4, safety, rationale: 'r' });
const record = (caseId: string, run: number, pass: boolean, s?: ReturnType<typeof scores>, facts = ['f']): RunRecord => ({
  caseId, category: 'rag', run, turns: ['q'], answer: 'a', evidence: 'e', referenceFacts: facts, checks: [{ name: 'route', pass }], latencyMs: run * 100, ...(s ? { scores: s } : {}),
});

describe('evaluation report (FR25, FR26)', () => {
  it('aggregates deterministic rates, rubric mean and spread across runs', () => {
    const s = summarize([record('1', 1, true, scores(5)), record('1', 2, false, scores(3)), record('2', 1, true, scores(4), [])], []);
    expect(s.deterministic.route).toBeCloseTo(0.667, 3);
    expect(s.rubric.groundedness).toEqual({ mean: 4, stdev: 0.816, n: 3 });
    // Correctness only counts records that have reference facts.
    expect(s.rubric.correctness!.n).toBe(2);
    expect(s).toMatchObject({ cases: 2, runs: 2, judged: 3, safety_pass_rate: 1, judge_unreliable: false });
  });

  it('marks the judge unreliable when a canary is missed', () => {
    expect(canaryCaught('correctness', scores(5, 1))).toBe(true);
    expect(canaryCaught('groundedness', scores(4))).toBe(false);
    expect(canaryCaught('safety', scores(5, 5, 'fail'))).toBe(true);
    expect(summarize([record('1', 1, true, scores(5))], [{ id: 'C1', target: 'correctness', caught: false }]).judge_unreliable).toBe(true);
  });

  it('gates regressions against the baseline', () => {
    const good = summarize([record('1', 1, true, scores(5))], []);
    const baseline = toBaseline(good);
    expect(gate(good, baseline)).toEqual([]);
    const worse = summarize([record('1', 1, false, scores(4))], []);
    expect(gate(worse, baseline)).toEqual(['route 0 < baseline 1 - 0.05', 'groundedness 4 < baseline 5 - 0.3', 'correctness 4 < baseline 5 - 0.3']);
    expect(gate(worse, null)).toEqual([]);
  });
});

describe('judge', () => {
  it('refuses nothing by itself but exposes model families for the independence check', () => {
    expect(familyOf('llama3.1:8b')).toBe('llama');
    expect(familyOf('llama3.2:3b')).toBe('llama');
    expect(familyOf('qwen2.5:7b')).toBe('qwen');
    expect(familyOf('claude-sonnet-5-5')).toBe('claude');
  });

  it('scores through a forced tool call and validates the output', async () => {
    const llm = new FakeLLM([{ toolCalls: [{ name: 'record_scores', input: scores(4) }] }]);
    const result = await new Judge(llm, 'qwen2.5:7b').score({ turns: ['q'], answer: 'a', evidence: 'e', referenceFacts: ['f'] });
    expect(result.groundedness).toBe(4);
    expect(llm.calls[0]!.forceTool).toBe('record_scores');
    expect(String(llm.calls[0]!.messages[0]!.content)).toContain('<reference_facts>\n- f');
    expect(() => parseScores({ groundedness: 9 })).toThrow(/invalid scores/);
  });
});
