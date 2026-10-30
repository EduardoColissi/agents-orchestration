# Checklist — the brief and the review, point by point

Where each requirement of [the challenge](challenge.md) and each point of the v1 review lives, how it is tested, and how to see it. Paths are in `src/` unless stated; eval cases are in [`../eval/golden.json`](../eval/golden.json).

## The brief

| Requirement | Where | Proof |
|---|---|---|
| ≥ 3 agent types with a clear communication mechanism | Router, Knowledge, Customer Support (+ Escalation, Personality); direct async calls through the orchestrator (Mediator) with a shared context — `orchestrator.ts`, `agents/*` | `tests/integration/chat.test.ts`; README → Architecture |
| Router: entry point, chooses the agent or the sequence, manages the workflow and data flow | `agents/router.ts` (schema-constrained decision: route, plan, language, standalone question); plan executor + replanner in `orchestrator.ts`, `orchestration/replanner.ts` | eval checks `route`, `plan`, `replanned` = 1.0 |
| Knowledge: RAG grounded in getnet.net + a web search tool | `rag/*` (crawler → chunks → local e5 embeddings → cosine index → retrieval), seeds in `data/sources.json` (`getnet.net`, `getnet.net/en`, `site.getnet.com.br`, Santander); `agents/knowledge.ts`, `agents/webSearchTool.ts` (server-side on Claude; Brave Search API with `BRAVE_SEARCH_API_KEY` or DuckDuckGo HTML on Ollama) | `tests/unit/rag.test.ts`, `tests/unit/ollama.test.ts` (search adapters); eval cases 1, 4, 6, 9, 10 (sources required), 2, 7 (web) |
| Customer Support: retrieves user data, ≥ 2 tools | 6 tools bound to the authenticated merchant: profile, settlements, transactions, terminal status, ticket, gated replacement — `support/tools.ts` | `tests/unit/support.test.ts`; eval cases 3, 5, 8, PT1, MT2 |
| `POST` endpoint, JSON `{message, user_id}` | `POST /chat` (`server.ts`); `user_id` is accepted and checked against the token | `tests/integration/auth.test.ts` (403 on mismatch); README → Try it |
| Dockerfile (+ compose) | `Dockerfile` (multi-stage, runtime + eval), `docker-compose.yml` (API + Ollama + model pull + eval profile), `docker-compose.gpu.yml` | CI builds the image and smokes the container; README → Quick start |
| Testing strategy, integration testing of the orchestration | unit + integration with a scripted fake LLM (165 tests), live semantic evaluation of the deployed API, CI, UI smoke | README → Testing strategy; `tests/`, `eval/`, `.github/workflows/ci.yml` |
| README: build, configure, run, tests; architecture, design choices, message workflow, RAG pipeline, LLM tools | README sections: Quick start, Configuration, Tests and evaluation, Architecture, How the agents use LLM tools, Memory, RAG pipeline, Design decisions | — |
| Bonus: a 4th agent (human escalation) | Escalation agent (`agents/escalation.ts`) → persistent human queue with operators | `tests/integration/hitl.test.ts`; eval H1, N2, N3 |
| Bonus: guardrails for unsafe, irrelevant, sensitive or unsupported requests | `guardrails/*`: input (injection, other customers, harmful), PII masking, Router block, output grounding check | `tests/unit/guardrails.test.ts`; eval N1 (blocked, no tools), N6 |
| Bonus: redirect / human handoff when not confident | low Router confidence, invalid Router output, knowledge gap, agent failure, unknown customer, approval-gated action → `assist` / `approval` handoffs | `tests/integration/hitl.test.ts`, `chat.test.ts`; eval H1–H3, N3 |
| Bonus: evaluation and observability strategy | `eval/*` (golden set, independent judge, canaries, baseline gate, versioned reports); spans + `GET /operator/metrics`; structured logs with `trace_id`; `/health`, `/ready` | README → Evaluation, Observability; `eval/reports/`, `docs/evidence/` |
| Video (≤ 15 min) | recorded after this branch; link in the README | — |

## The review of v1

| Review point | What changed | Proof |
|---|---|---|
| **Memory** (1.0/10) — stateless requests | `conversation_id`; turns persisted (SQLite, survive restarts); rolling summary + last 6 messages given to the Router and the agents; follow-ups rewritten into a standalone question (only with history, same language); deterministic compaction; per-owner isolation | `tests/integration/memory.test.ts`, `context.test.ts`; eval MT1, MT2, `no_spurious_rewrite`; `docs/evidence/restart.log` |
| **Authentication** — `user_id` in the body was the identity | `POST /auth/token` (scrypt, rate limited per IP + username, capped per IP, audited) → JWT (HS256 pinned, iss/aud/exp) → principal; tools bound to the token subject; `user_id` is only an assertion (403 on mismatch, before any LLM call); foreign conversation = 404; roles; chat rate limit per merchant | `tests/integration/auth.test.ts`; eval N4, N5 |
| **Human-in-the-loop** (4.0/10) — handoff opened a ticket and stopped | persistent queue, identified operators reply / approve / reject; approval stops the tool loop before the action, checkpoints and resumes the same run; CAS on `version` (409), idempotent side effect, exactly-once delivery, TTL expiry, crash recovery at boot, append-only audit; operator console in the UI | `tests/integration/hitl.test.ts` (24 tests); eval H1–H3; UI smoke |
| **Evaluation** — lexical checks, real run gitignored | HTTP evaluation of the deployed API, judge from another family (+ Claude as reference), canaries, N runs with spread, baseline gate, reports with build SHA versioned in the repo | `eval/reports/*`, `eval/baseline.json`, `tests/unit/eval.test.ts` |
| **Replanning** — fixed plan | deterministic policy after each specialist: offline machine → add Knowledge; support tool crashed → escalate; live data unavailable → finish without a person | `tests/integration/replan.test.ts`; eval R1 (`replanned`) |
| **Production evidence** | `/ready` (DB, KB, LLM models), CI (typecheck, tests, compose validation, image build, container smoke with restart), state volume | `.github/workflows/ci.yml`; `docs/evidence/` |
| **AI observability** | spans per stage persisted (duration, tokens, status), p50/p95/p99 per stage and per turn, error / escalation / blocked rates; audited evidence per turn | `tests/integration/observability.test.ts`; `GET /operator/metrics`; UI metrics strip |
| **Kept** (rated strong) | own orchestrator, multi-step plan with results passed forward, zod tools with the merchant bound by closure, bounded tool loop, deterministic guardrails + PII masking + grounding check, the RAG pipeline, deterministic escalation, cheap router + stronger specialists | the first commit of the clock imports v1 unchanged; eval checks `route`/`plan`/`tools` = 1.0 |

## Found by walking through the test plan (after the clock, declared)

| Symptom | Cause | Fix |
|---|---|---|
| "Minha maquininha está offline." → "I couldn't find…" + needless handoff | playbook in English only; the 8B searched for the wrong thing; a "not found" replaced Support's answer | bilingual playbook; the offline guide searched in code on Support's signal; Support's facts + Knowledge's guidance joined in code; "not found" never erases Support's answer |
| settlement days swapped ("Pix today, cards tomorrow") | the 8B misread ISO dates against "today" | `get_settlements` returns weekday, today/tomorrow/yesterday and a summary line, computed in code |
| login limit bypass with `" CLIENTE1988 "` | the limiter key used the raw username | key normalized like the validation; 20 failures per IP per minute cap |
