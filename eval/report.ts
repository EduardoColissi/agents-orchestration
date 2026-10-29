import type { Scores } from './judge.js';

export interface Check {
  name: string;
  pass: boolean;
}

export interface RunRecord {
  caseId: string;
  user: string;
  category: string;
  run: number;
  turns: string[];
  answer: string;
  evidence: string;
  referenceFacts: string[];
  checks: Check[];
  latencyMs: number;
  route?: string;
  standaloneQuery?: string | null;
  error?: string;
  scores?: Scores;
  judgeError?: string;
}

export interface CanaryResult {
  id: string;
  target: 'groundedness' | 'correctness' | 'relevance' | 'helpfulness' | 'safety';
  caught: boolean;
  scores?: Scores;
}

const RUBRIC = ['groundedness', 'correctness', 'relevance', 'helpfulness'] as const;

export interface Summary {
  records: number;
  cases: number;
  runs: number;
  deterministic: Record<string, number>;
  rubric: Record<string, { mean: number; stdev: number; n: number }>;
  safety_pass_rate: number;
  judged: number;
  judge_errors: number;
  judge_unreliable: boolean;
  latency_ms: { p50: number; p95: number };
  by_category: Record<string, { cases: number; checks_pass_rate: number; groundedness: number | null; correctness: number | null }>;
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const stdev = (xs: number[]) => (xs.length > 1 ? Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2))) : 0);
export const percentile = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! : 0;
};
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

export function summarize(records: RunRecord[], canaries: CanaryResult[]): Summary {
  const checkNames = [...new Set(records.flatMap((r) => r.checks.map((c) => c.name)))];
  const deterministic = Object.fromEntries(
    checkNames.map((name) => {
      const relevant = records.flatMap((r) => r.checks.filter((c) => c.name === name));
      return [name, round(relevant.filter((c) => c.pass).length / relevant.length)];
    }),
  );
  const judged = records.filter((r) => r.scores);
  const rubric = Object.fromEntries(
    RUBRIC.map((k) => {
      const relevant = k === 'correctness' ? judged.filter((r) => r.referenceFacts.length > 0) : judged;
      const xs = relevant.map((r) => r.scores![k]);
      return [k, { mean: round(mean(xs)), stdev: round(stdev(xs)), n: xs.length }];
    }),
  );
  const categories = [...new Set(records.map((r) => r.category))];
  const byCategory = Object.fromEntries(
    categories.map((cat) => {
      const rs = records.filter((r) => r.category === cat);
      const checks = rs.flatMap((r) => r.checks);
      const js = rs.filter((r) => r.scores);
      const withFacts = js.filter((r) => r.referenceFacts.length > 0);
      return [cat, {
        cases: new Set(rs.map((r) => r.caseId)).size,
        checks_pass_rate: round(checks.length ? checks.filter((c) => c.pass).length / checks.length : 1),
        groundedness: js.length ? round(mean(js.map((r) => r.scores!.groundedness))) : null,
        correctness: withFacts.length ? round(mean(withFacts.map((r) => r.scores!.correctness))) : null,
      }];
    }),
  );
  const latencies = records.map((r) => r.latencyMs);
  return {
    records: records.length,
    cases: new Set(records.map((r) => r.caseId)).size,
    runs: Math.max(0, ...records.map((r) => r.run)),
    deterministic,
    rubric,
    safety_pass_rate: round(judged.length ? judged.filter((r) => r.scores!.safety === 'pass').length / judged.length : 1),
    judged: judged.length,
    judge_errors: records.filter((r) => r.judgeError).length,
    judge_unreliable: canaries.some((c) => !c.caught),
    latency_ms: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    by_category: byCategory,
  };
}

/** A canary has a known defect: the judge must score its target ≤ 2 (or fail safety). */
export function canaryCaught(target: CanaryResult['target'], scores: Scores): boolean {
  return target === 'safety' ? scores.safety === 'fail' : scores[target] <= 2;
}

export interface Baseline {
  deterministic: Record<string, number>;
  rubric: Record<string, number>;
}

/** Regression gate (FR26): rates may drop ≤ 0.05, rubric means ≤ 0.3 against the baseline. */
export function gate(summary: Summary, baseline: Baseline | null): string[] {
  if (!baseline) return [];
  const failures: string[] = [];
  for (const [name, value] of Object.entries(baseline.deterministic)) {
    const current = summary.deterministic[name];
    if (current !== undefined && current < value - 0.05) failures.push(`${name} ${current} < baseline ${value} - 0.05`);
  }
  for (const [name, value] of Object.entries(baseline.rubric)) {
    const current = summary.rubric[name]?.mean;
    if (current !== undefined && summary.rubric[name]!.n > 0 && current < value - 0.3) failures.push(`${name} ${current} < baseline ${value} - 0.3`);
  }
  return failures;
}

export const toBaseline = (s: Summary): Baseline => ({
  deterministic: s.deterministic,
  rubric: Object.fromEntries(Object.entries(s.rubric).filter(([, v]) => v.n > 0).map(([k, v]) => [k, v.mean])),
});

export function renderMarkdown(meta: Record<string, unknown>, summary: Summary, records: RunRecord[], canaries: CanaryResult[], gateFailures: string[]): string {
  const lines = [
    `# Evaluation report — ${meta.started_at}`,
    '',
    `API ${meta.base_url} · generator ${JSON.stringify(meta.generator)} · judge \`${meta.judge}\` · ${summary.cases} cases × ${summary.runs} runs = ${summary.records} records`,
    '',
    '## Rubric (judge, 1–5)',
    '',
    '| Metric | Mean | Stdev | n |',
    '|---|---|---|---|',
    ...Object.entries(summary.rubric).map(([k, v]) => `| ${k} | ${v.mean} | ${v.stdev} | ${v.n} |`),
    `| safety pass rate | ${summary.safety_pass_rate} | | ${summary.judged} |`,
    '',
    '## Deterministic checks',
    '',
    '| Check | Pass rate |',
    '|---|---|',
    ...Object.entries(summary.deterministic).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    `Latency p50 ${summary.latency_ms.p50} ms · p95 ${summary.latency_ms.p95} ms · judge errors ${summary.judge_errors}`,
    '',
    '## Judge calibration (canaries)',
    '',
    ...canaries.map((c) => `- ${c.id} (${c.target}): ${c.caught ? 'caught' : '**missed**'}`),
    summary.judge_unreliable ? '\n**Judge unreliable: at least one canary was missed.**' : '',
    '',
    '## Gate',
    '',
    gateFailures.length ? gateFailures.map((f) => `- FAIL ${f}`).join('\n') : '- pass',
    '',
    '## By category',
    '',
    '| Category | Cases | Checks | Groundedness | Correctness |',
    '|---|---|---|---|---|',
    ...Object.entries(summary.by_category).map(([k, v]) => `| ${k} | ${v.cases} | ${v.checks_pass_rate} | ${v.groundedness ?? '–'} | ${v.correctness ?? '–'} |`),
    '',
    '## Records',
    '',
    '| Case | Run | Route | Failed checks | G | C | R | H | Safety | Latency |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...records.map((r) => {
      const failed = r.checks.filter((c) => !c.pass).map((c) => c.name).join(', ') || '–';
      const s = r.scores;
      return `| ${r.caseId} | ${r.run} | ${r.route ?? r.error ?? '–'} | ${failed} | ${s?.groundedness ?? '–'} | ${s?.correctness ?? '–'} | ${s?.relevance ?? '–'} | ${s?.helpfulness ?? '–'} | ${s?.safety ?? '–'} | ${r.latencyMs} |`;
    }),
  ];
  return `${lines.join('\n')}\n`;
}
