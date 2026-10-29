/**
 * Semantic evaluation of the DEPLOYED API (spec FR24–FR26): `npm run eval -- [--runs 3] [--only 3,H2] [--update-baseline] [--skip-judge]`.
 * Phase 1 drives the API over HTTP (login, multi-turn chats, operator decisions) and collects each
 * answer with its evidence. Phase 2 scores everything with a judge from another model family.
 * Two phases because the generator and the judge do not fit in a 12 GB GPU at the same time.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadDotEnv } from '../src/config.js';
import { OllamaClient } from '../src/llm/ollama.js';
import { AnthropicClient } from '../src/llm/anthropic.js';
import type { LLMClient } from '../src/llm/client.js';
import { ApiClient } from './client.js';
import { Judge, familyOf } from './judge.js';
import { canaryCaught, gate, renderMarkdown, summarize, toBaseline, type Baseline, type CanaryResult, type Check, type RunRecord } from './report.js';

interface GoldenCase {
  id: string;
  category: string;
  user: string;
  turns?: string[];
  expect: Record<string, unknown>;
  operator?: { user: string; action: 'reply' | 'approve' | 'reject'; message?: string };
  after_operator?: { last_role?: string; answer_contains_any?: string[]; answer_not_contains?: string[] };
  api?: { check: 'user_mismatch' | 'foreign_conversation'; body_user_id?: string; owner?: string };
  reference_facts: string[];
}
interface Golden {
  cases: GoldenCase[];
  canaries: Array<{ id: string; target: CanaryResult['target']; case: string; answer: string }>;
}
type ChatBody = {
  conversation_id: string; answer: string; route: string; agents: string[]; tools_used: string[]; sources: unknown[];
  handoff: { required: boolean; handoff_id: string | null; kind: string | null };
  replans?: Array<{ after: string; signal: string; action: string }>;
};
type TraceBody = { messages: Array<{ role: string; content: string; evidence: Evidence | null }> };
type Evidence = { standalone_query: string | null; route_decision: unknown; steps: Array<{ agent: string; tools: Array<{ name: string; input: unknown; output: string }> }>; sources: Array<{ title: string; url: string }> };

loadDotEnv();
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => args[args.indexOf(`--${name}`) + 1];
const RUNS = flag('runs') ? Number(option('runs')) : 3;
const ONLY = flag('only') ? new Set(option('only')!.split(',')) : null;
const BASE_URL = process.env.EVAL_BASE_URL ?? 'http://localhost:3000';
const OPERATOR = process.env.EVAL_OPERATOR ?? 'op.ana';
const JUDGE_PROVIDER = process.env.JUDGE_PROVIDER ?? 'ollama';
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? (JUDGE_PROVIDER === 'anthropic' ? 'claude-sonnet-5-5' : 'qwen2.5:7b');
const JUDGE_OLLAMA_URL = process.env.JUDGE_OLLAMA_URL ?? process.env.OLLAMA_URL ?? 'http://localhost:11434';
// A JUDGE_MODEL left in .env for the local judge must not be sent to Anthropic (and vice versa).
if (!flag('skip-judge') && (JUDGE_PROVIDER === 'anthropic') !== JUDGE_MODEL.startsWith('claude-')) {
  throw new Error(`JUDGE_MODEL ${JUDGE_MODEL} does not belong to JUDGE_PROVIDER ${JUDGE_PROVIDER}: set both, e.g. JUDGE_PROVIDER=anthropic JUDGE_MODEL=claude-sonnet-5-5`);
}

const golden = JSON.parse(readFileSync('eval/golden.json', 'utf8')) as Golden;

/** Identifiers of every merchant in the mock data: an answer quoting another merchant's is a leak. */
const customers = (JSON.parse(readFileSync('data/customers.json', 'utf8')) as { customers: Array<{ user_id: string; business_name: string; terminals: Array<{ serial: string }> }> }).customers;
export function crossMerchantLeak(answer: string, user: string): string | null {
  for (const c of customers.filter((x) => x.user_id !== user)) {
    const hit = [c.user_id, c.business_name, ...c.terminals.map((t) => t.serial)].find((id) => answer.includes(id));
    if (hit) return hit;
  }
  return null;
}
const api = new ApiClient(BASE_URL);

function expectChecks(expect: Record<string, unknown>, body: ChatBody): Check[] {
  const checks: Check[] = [];
  const agents = body.agents.filter((a) => !['router', 'escalation', 'personality'].includes(a));
  if (expect.route) checks.push({ name: 'route', pass: body.route === expect.route });
  if (expect.route_any) checks.push({ name: 'route', pass: (expect.route_any as string[]).includes(body.route) });
  if (expect.plan) checks.push({ name: 'plan', pass: JSON.stringify(agents) === JSON.stringify(expect.plan) });
  if (expect.tools_any) checks.push({ name: 'tools', pass: (expect.tools_any as string[]).some((t) => body.tools_used.includes(t)) });
  if (expect.tools_none) checks.push({ name: 'tools', pass: body.tools_used.length === 0 });
  if (expect.requires_sources) checks.push({ name: 'sources', pass: body.sources.length > 0 });
  if (expect.handoff !== undefined) checks.push({ name: 'handoff', pass: body.handoff.required === expect.handoff });
  if (expect.kind) checks.push({ name: 'handoff_kind', pass: body.handoff.kind === expect.kind });
  if (expect.agents_include) checks.push({ name: 'plan', pass: agents.includes(expect.agents_include as string) });
  if (expect.replanned !== undefined) checks.push({ name: 'replanned', pass: (body.replans?.length ?? 0) > 0 === expect.replanned });
  return checks;
}

function evidenceText(e: Evidence | null): string {
  if (!e) return '';
  const tools = e.steps.flatMap((s) => s.tools.map((t) => `[${s.agent}] ${t.name}(${JSON.stringify(t.input)}) →\n${t.output}`));
  return [...tools, e.sources.length ? `Sources: ${e.sources.map((s) => s.url).join(', ')}` : ''].filter(Boolean).join('\n\n');
}

async function runCase(c: GoldenCase, run: number): Promise<RunRecord> {
  const base = { caseId: c.id, user: c.user, category: c.category, run, turns: c.turns ?? [], referenceFacts: c.reference_facts };
  const started = Date.now();
  if (c.api) {
    let res;
    if (c.api.check === 'user_mismatch') {
      res = await api.as(c.user, 'POST', '/chat', { message: 'Show me my sales', user_id: c.api.body_user_id });
    } else {
      const owned = await api.as<ChatBody>(c.api.owner!, 'POST', '/chat', { message: 'Olá' });
      res = await api.as(c.user, 'GET', `/conversations/${owned.body.conversation_id}`);
    }
    const checks: Check[] = [{ name: 'status', pass: res.status === c.expect.status }];
    if (c.expect.error) checks.push({ name: 'error_code', pass: res.body.error === c.expect.error });
    return { ...base, answer: '', evidence: '', checks, latencyMs: Date.now() - started, route: `HTTP ${res.status}` };
  }

  let conversationId: string | undefined;
  let last: ChatBody | undefined;
  for (const message of c.turns!) {
    const res = await api.as<ChatBody>(c.user, 'POST', '/chat', { message, ...(conversationId ? { conversation_id: conversationId } : {}) });
    if (res.status !== 200) throw new Error(`chat returned ${res.status}: ${JSON.stringify(res.body)}`);
    last = res.body;
    conversationId = last.conversation_id;
  }
  const latencyMs = Date.now() - started;
  const checks = expectChecks(c.expect, last!);
  let answer = last!.answer;

  const lastEvidence = async () => (await api.as<TraceBody>(OPERATOR, 'GET', `/operator/conversations/${conversationId}`)).body.messages.filter((m) => m.role === 'assistant' && m.evidence).at(-1)?.evidence ?? null;
  let evidence = await lastEvidence();
  // A single message has nothing to resolve: a rewrite there means the router copied or translated.
  if (c.turns!.length === 1) checks.push({ name: 'no_spurious_rewrite', pass: !evidence?.standalone_query });
  if (c.expect.standalone_contains_any) {
    const q = (evidence?.standalone_query ?? '').toLowerCase();
    checks.push({ name: 'standalone_query', pass: (c.expect.standalone_contains_any as string[]).some((k) => q.includes(k.toLowerCase())) });
  }

  let decision = '';
  let humanAuthored = false;
  if (c.operator) {
    const handoffId = last!.handoff.handoff_id;
    checks.push({ name: 'handoff_queued', pass: !!handoffId });
    if (handoffId) {
      const current = await api.as<{ version: number }>(c.operator.user, 'GET', `/operator/handoffs/${handoffId}`);
      const resolved = await api.as(c.operator.user, 'POST', `/operator/handoffs/${handoffId}/resolve`, { action: c.operator.action, ...(c.operator.message ? { message: c.operator.message } : {}), expected_version: current.body.version });
      checks.push({ name: 'operator_resolve', pass: resolved.status === 200 });
      const view = await api.as<{ messages: Array<{ role: string; content: string }> }>(c.user, 'GET', `/conversations/${conversationId}`);
      const final = view.body.messages.at(-1)!;
      const after = c.after_operator ?? {};
      if (after.last_role) checks.push({ name: 'resumed', pass: final.role === after.last_role });
      if (after.answer_contains_any) checks.push({ name: 'outcome_content', pass: after.answer_contains_any.some((k) => final.content.includes(k)) });
      if (after.answer_not_contains) checks.push({ name: 'outcome_content', pass: !after.answer_not_contains.some((k) => final.content.includes(k)) });
      answer = final.content;
      humanAuthored = final.role === 'operator';
      // The outcome of an approval is a resumed agent run with its own evidence.
      if (!humanAuthored) evidence = (await lastEvidence()) ?? evidence;
      decision = `\n\nOperator decision: ${c.operator.action}${c.operator.message ? ` — "${c.operator.message}"` : ''}`;
    }
  }
  checks.push({ name: 'no_cross_merchant_data', pass: !crossMerchantLeak(answer, c.user) });
  return { ...base, answer, evidence: evidenceText(evidence) + decision, checks, latencyMs, route: last!.route, standaloneQuery: evidence?.standalone_query ?? null, ...(humanAuthored ? { humanAuthored } : {}) };
}

/** Commit of the evaluation code itself (and whether it had local changes). */
function runnerVersion(): { git_sha: string; dirty: boolean } {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'eval'], { encoding: 'utf8' }).trim().length > 0;
    return { git_sha: sha, dirty };
  } catch {
    return { git_sha: 'unknown', dirty: false };
  }
}

function judgeClient(): LLMClient {
  if (JUDGE_PROVIDER === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('JUDGE_PROVIDER=anthropic needs ANTHROPIC_API_KEY');
    return new AnthropicClient(process.env.ANTHROPIC_API_KEY, undefined, { workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
  }
  return new OllamaClient(JUDGE_OLLAMA_URL, JUDGE_MODEL, fetch, { numCtx: 8192, keepAlive: '10m' });
}

/** `--rejudge <report.json>`: score the records of an existing report again (e.g. with a stronger judge). */
async function rejudge(path: string) {
  const report = JSON.parse(readFileSync(path, 'utf8')) as { meta: Record<string, unknown>; records: RunRecord[] };
  const generatorFamilies = new Set(Object.values((report.meta.generator ?? {}) as Record<string, string>).map(familyOf));
  if (generatorFamilies.has(familyOf(JUDGE_MODEL))) throw new Error(`judge ${JUDGE_MODEL} is from the generator's family`);
  const judge = new Judge(judgeClient(), JUDGE_MODEL);
  const records = report.records.map((r) => ({ ...r, scores: undefined, judgeError: undefined }) as RunRecord);
  for (const r of records.filter((x) => x.answer && !x.error && !x.humanAuthored)) {
    try {
      r.scores = await judge.score({ merchant: r.user, turns: r.turns, answer: r.answer, evidence: r.evidence, referenceFacts: r.referenceFacts });
    } catch (err) {
      r.judgeError = (err as Error).message.slice(0, 200);
    }
  }
  const canaries = await scoreCanaries(judge, records);
  return { meta: { ...report.meta, judge: `${JUDGE_PROVIDER}:${JUDGE_MODEL}`, rejudged_from: path, rejudged_at: new Date().toISOString() }, records, canaries };
}

async function scoreCanaries(judge: Judge, records: RunRecord[]): Promise<CanaryResult[]> {
  const canaries: CanaryResult[] = [];
  for (const canary of golden.canaries) {
    const c = golden.cases.find((x) => x.id === canary.case)!;
    const evidence = records.find((r) => r.caseId === c.id)?.evidence ?? '';
    try {
      const scores = await judge.score({ merchant: c.user, turns: c.turns ?? [], answer: canary.answer, evidence, referenceFacts: c.reference_facts });
      // Safety is judged AND checked deterministically; either one catching the leak counts.
      const leak = canary.target === 'safety' && !!crossMerchantLeak(canary.answer, c.user);
      canaries.push({ id: canary.id, target: canary.target, caught: canaryCaught(canary.target, scores) || leak, scores });
    } catch {
      canaries.push({ id: canary.id, target: canary.target, caught: false });
    }
  }
  return canaries;
}

function writeReport(meta: Record<string, unknown>, records: RunRecord[], canaries: CanaryResult[]) {
  const summary = summarize(records, canaries);
  const baseline = existsSync('eval/baseline.json') ? (JSON.parse(readFileSync('eval/baseline.json', 'utf8')) as Baseline) : null;
  // A partial run (--only) lacks the checks of the skipped cases: the gate only compares full runs.
  const judge = String(meta.judge);
  const gateFailures = flag('update-baseline') || flag('only') ? [] : gate(summary, baseline, judge);
  if (baseline?.judge && baseline.judge !== judge) console.log(`Rubric not gated: baseline judge ${baseline.judge}, this run ${judge}.`);
  if (flag('only') && baseline) console.log('Gate skipped: partial run (--only).');
  mkdirSync('eval/reports', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(`eval/reports/${stamp}.json`, `${JSON.stringify({ meta, summary, gate: gateFailures, canaries, records }, null, 2)}\n`);
  writeFileSync(`eval/reports/${stamp}.md`, renderMarkdown(meta, summary, records, canaries, gateFailures));
  if (flag('update-baseline')) writeFileSync('eval/baseline.json', `${JSON.stringify(toBaseline(summary, judge), null, 2)}\n`);
  console.log(`\n${JSON.stringify({ rubric: summary.rubric, deterministic: summary.deterministic, safety: summary.safety_pass_rate, judge_unreliable: summary.judge_unreliable, latency_ms: summary.latency_ms }, null, 1)}`);
  console.log(`Report: eval/reports/${stamp}.md`);
  if (gateFailures.length) {
    console.error(`Gate failed:\n${gateFailures.join('\n')}`);
    process.exit(1);
  }
}

async function main() {
  if (flag('rejudge')) {
    const { meta, records, canaries } = await rejudge(option('rejudge')!);
    return writeReport(meta, records, canaries);
  }
  const health = await api.health();
  const generator = (health.models ?? {}) as Record<string, string>;
  const generatorFamilies = new Set(Object.values(generator).map(familyOf));
  if (!flag('skip-judge') && generatorFamilies.has(familyOf(JUDGE_MODEL))) {
    throw new Error(`judge ${JUDGE_MODEL} is from the same family as the generator (${[...generatorFamilies].join(', ')}): pick another JUDGE_MODEL`);
  }
  const cases = golden.cases.filter((c) => !ONLY || ONLY.has(c.id));
  const startedAt = new Date().toISOString();
  console.log(`Phase 1 — ${cases.length} cases × ${RUNS} runs against ${BASE_URL} (generator ${JSON.stringify(generator)})`);

  const records: RunRecord[] = [];
  for (let run = 1; run <= RUNS; run++) {
    for (const c of cases) {
      let record: RunRecord;
      try {
        record = await runCase(c, run);
      } catch (err) {
        record = { caseId: c.id, user: c.user, category: c.category, run, turns: c.turns ?? [], referenceFacts: c.reference_facts, answer: '', evidence: '', checks: [{ name: 'request', pass: false }], latencyMs: 0, error: (err as Error).message.slice(0, 200) };
      }
      records.push(record);
      const failed = record.checks.filter((x) => !x.pass).map((x) => x.name);
      console.log(`${failed.length ? '✗' : '✓'} run ${run} #${c.id.padEnd(4)} ${String(record.route ?? record.error).padEnd(12)} ${String(record.latencyMs).padStart(6)}ms ${failed.length ? `failed: ${failed.join(', ')}` : ''}`);
    }
  }

  const canaries: CanaryResult[] = [];
  if (!flag('skip-judge')) {
    if (JUDGE_PROVIDER === 'ollama') {
      console.log(`Phase 2 — pulling ${JUDGE_MODEL} if needed`);
      await fetch(`${JUDGE_OLLAMA_URL}/api/pull`, { method: 'POST', body: JSON.stringify({ model: JUDGE_MODEL, stream: false }) });
    }
    const judge = new Judge(judgeClient(), JUDGE_MODEL);
    for (const r of records.filter((x) => x.answer && !x.error && !x.humanAuthored)) {
      try {
        r.scores = await judge.score({ merchant: r.user, turns: r.turns, answer: r.answer, evidence: r.evidence, referenceFacts: r.referenceFacts });
      } catch (err) {
        r.judgeError = (err as Error).message.slice(0, 200);
      }
    }
    canaries.push(...(await scoreCanaries(judge, records)));
  }

  const meta = { started_at: startedAt, api_version: health.version ?? 'unknown', runner: runnerVersion(), finished_at: new Date().toISOString(), base_url: BASE_URL, generator, judge: flag('skip-judge') ? 'skipped' : `${JUDGE_PROVIDER}:${JUDGE_MODEL}`, runs: RUNS, only: ONLY ? [...ONLY] : null };

  writeReport(meta, records, canaries);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
