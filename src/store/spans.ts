import type { Db } from './db.js';

export type SpanStage = 'turn' | 'router' | 'agent' | 'tool' | 'rag' | 'personality';

export interface Span {
  stage: SpanStage;
  name: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  status: 'ok' | 'error';
  attrs?: Record<string, unknown>;
}

/** Persistent per-stage traces (router, agents, tools, RAG) and the operational metrics built on them. */
export class SpanStore {
  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  record(traceId: string, conversationId: string | null, spans: Span[]): void {
    const insert = this.db.prepare(
      'INSERT INTO spans (trace_id, conversation_id, stage, name, duration_ms, input_tokens, output_tokens, status, attrs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const at = this.now().toISOString();
    for (const s of spans) {
      insert.run(traceId, conversationId, s.stage, s.name, Math.round(s.durationMs), s.inputTokens ?? 0, s.outputTokens ?? 0, s.status, s.attrs ? JSON.stringify(s.attrs) : null, at);
    }
  }

  forTrace(traceId: string): Array<Span & { traceId: string }> {
    const rows = this.db.prepare('SELECT * FROM spans WHERE trace_id = ? ORDER BY id').all(traceId) as unknown as SpanRow[];
    return rows.map((r) => ({ traceId: r.trace_id, stage: r.stage, name: r.name, durationMs: r.duration_ms, inputTokens: r.input_tokens, outputTokens: r.output_tokens, status: r.status, ...(r.attrs ? { attrs: JSON.parse(r.attrs) } : {}) }));
  }

  /** Latency percentiles, error rate and tokens per stage, plus turn-level escalation rate. */
  metrics(sinceIso?: string) {
    const rows = this.db.prepare('SELECT * FROM spans WHERE (?1 IS NULL OR created_at >= ?1) ORDER BY id').all(sinceIso ?? null) as unknown as SpanRow[];
    const groups = new Map<string, SpanRow[]>();
    for (const r of rows) {
      const key = `${r.stage}:${r.name}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const stages = [...groups.entries()].map(([key, rs]) => {
      const durations = rs.map((r) => r.duration_ms);
      return {
        key,
        count: rs.length,
        p50_ms: percentile(durations, 0.5),
        p95_ms: percentile(durations, 0.95),
        p99_ms: percentile(durations, 0.99),
        error_rate: round(rs.filter((r) => r.status === 'error').length / rs.length),
        input_tokens: rs.reduce((n, r) => n + r.input_tokens, 0),
        output_tokens: rs.reduce((n, r) => n + r.output_tokens, 0),
      };
    });
    const turns = rows.filter((r) => r.stage === 'turn');
    const attrs = turns.map((r) => (r.attrs ? (JSON.parse(r.attrs) as { route?: string; handoff_required?: boolean }) : {}));
    return {
      turns: turns.length,
      turn_latency_ms: { p50: percentile(turns.map((t) => t.duration_ms), 0.5), p95: percentile(turns.map((t) => t.duration_ms), 0.95), p99: percentile(turns.map((t) => t.duration_ms), 0.99) },
      escalation_rate: round(turns.length ? attrs.filter((a) => a.handoff_required).length / turns.length : 0),
      blocked_rate: round(turns.length ? attrs.filter((a) => a.route === 'blocked').length / turns.length : 0),
      stages,
    };
  }
}

interface SpanRow {
  trace_id: string;
  stage: SpanStage;
  name: string;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  status: 'ok' | 'error';
  attrs: string | null;
}

const round = (x: number) => Math.round(x * 1000) / 1000;
function percentile(xs: number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! : 0;
}
