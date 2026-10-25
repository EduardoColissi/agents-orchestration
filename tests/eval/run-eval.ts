/**
 * Offline evaluation against the REAL LLM (`npm run eval`, needs ANTHROPIC_API_KEY and an index).
 * Runs the golden set in-process, or against a running server when EVAL_BASE_URL is set.
 * Prints a scorecard, writes eval-report.json and exits 1 when route accuracy is below the gate.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../../src/config.js';
import { buildDependencies } from '../../src/container.js';
import { createLogger } from '../../src/observability/logger.js';
import type { ChatResponse } from '../../src/orchestrator.js';

interface Scenario {
  id: string;
  message: string;
  user_id?: string;
  route?: string;
  route_any?: string[];
  plan?: string[];
  tools_any?: string[];
  requires_sources?: boolean;
  must_contain_any?: string[];
  handoff?: boolean;
}

interface Check {
  name: string;
  pass: boolean;
}

const MIN_ROUTE_ACCURACY = Number(process.env.EVAL_MIN_ROUTE_ACCURACY ?? 0.9);
const scenarios = (JSON.parse(readFileSync('tests/eval/scenarios.json', 'utf8')) as { scenarios: Scenario[] }).scenarios;

async function makeCaller(): Promise<(message: string, userId: string) => Promise<ChatResponse>> {
  const baseUrl = process.env.EVAL_BASE_URL;
  if (baseUrl) {
    return async (message, user_id) => {
      const res = await fetch(`${baseUrl}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, user_id }) });
      return (await res.json()) as ChatResponse;
    };
  }
  const config = loadConfig({ ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' });
  const { orchestrator } = buildDependencies({ config, logger: createLogger(config.LOG_LEVEL) });
  return (message, userId) => orchestrator.handle({ message, userId });
}

function evaluate(s: Scenario, r: ChatResponse): Check[] {
  const checks: Check[] = [];
  if (s.route) checks.push({ name: 'route', pass: r.route === s.route });
  if (s.route_any) checks.push({ name: 'route', pass: s.route_any.includes(r.route) });
  if (s.plan) checks.push({ name: 'plan', pass: JSON.stringify(r.agents.filter((a) => a !== 'router' && a !== 'escalation')) === JSON.stringify(s.plan) });
  if (s.tools_any) checks.push({ name: 'tools', pass: s.tools_any.some((t) => r.tools_used.includes(t)) });
  if (s.requires_sources) checks.push({ name: 'sources', pass: r.sources.length > 0 });
  if (s.must_contain_any) checks.push({ name: 'content', pass: s.must_contain_any.some((k) => r.answer.toLowerCase().includes(k.toLowerCase())) });
  if (s.handoff !== undefined) checks.push({ name: 'handoff', pass: r.handoff.required === s.handoff });
  return checks;
}

async function main() {
  const call = await makeCaller();
  const rows: Array<{ id: string; route: string; latency_ms: number; checks: Check[]; answer: string }> = [];

  for (const s of scenarios) {
    const started = Date.now();
    try {
      const r = await call(s.message, s.user_id ?? 'cliente1988');
      rows.push({ id: s.id, route: r.route, latency_ms: Date.now() - started, checks: evaluate(s, r), answer: r.answer });
    } catch (err) {
      rows.push({ id: s.id, route: 'ERROR', latency_ms: Date.now() - started, checks: [{ name: 'request', pass: false }], answer: String(err) });
    }
    const row = rows.at(-1)!;
    const failed = row.checks.filter((c) => !c.pass).map((c) => c.name);
    console.log(`${failed.length ? '✗' : '✓'} #${s.id.padEnd(4)} ${row.route.padEnd(10)} ${String(row.latency_ms).padStart(6)}ms ${failed.length ? `failed: ${failed.join(', ')}` : ''}`);
  }

  const rate = (name: string) => {
    const relevant = rows.flatMap((r) => r.checks.filter((c) => c.name === name));
    return relevant.length ? relevant.filter((c) => c.pass).length / relevant.length : 1;
  };
  const latencies = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
  const summary = {
    scenarios: rows.length,
    fully_passing: rows.filter((r) => r.checks.every((c) => c.pass)).length,
    route_accuracy: rate('route'),
    plan_accuracy: rate('plan'),
    tool_accuracy: rate('tools'),
    source_coverage: rate('sources'),
    content_match: rate('content'),
    handoff_accuracy: rate('handoff'),
    p50_latency_ms: latencies[Math.floor(latencies.length * 0.5)] ?? 0,
    p95_latency_ms: latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0,
  };
  console.log('\nScorecard');
  console.table(summary);
  writeFileSync('eval-report.json', JSON.stringify({ summary, rows }, null, 2));
  console.log('Full report (with answers) written to eval-report.json');

  if (summary.route_accuracy < MIN_ROUTE_ACCURACY) {
    console.error(`Route accuracy ${summary.route_accuracy.toFixed(2)} is below the gate ${MIN_ROUTE_ACCURACY}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
