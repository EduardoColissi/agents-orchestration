# Tasks — Getnet Multi-Agent Support System

> SDD stage 3: small, verifiable steps in priority order. Core = must ship in the 60-minute session. Bonus = only if time remains.
> Each task references the requirements it satisfies and has a "done when".

## Core (target: ~45 min of implementation)

- [x] **T1. Scaffold** (3 min)
  Node 20 + TS strict, Fastify, zod, Vitest, pino, `@anthropic-ai/sdk`, `cheerio`, `@huggingface/transformers`. `config.ts` reads env with zod.
  *Done when:* `npm run build` and `npm test` pass on an empty test.

- [x] **T2. LLM client abstraction** (3 min) — spec §9 testability
  `LLMClient` interface (`complete({system, messages, tools, model})`), Anthropic implementation, scripted `FakeLLM`.
  *Done when:* a unit test drives `FakeLLM` through a tool-call round trip.

- [x] **T3. Customer repository + support tools** (5 min) — FR5, FR6, FR7, A3
  `CustomerRepository` interface, JSON mock with dates relative to today, 5 tool definitions + handlers, `user_id` injected by the caller.
  *Done when:* unit tests cover each tool, the unknown user case and cross-user isolation.

- [x] **T4. RAG ingestion** (7 min) — FR9, plan §4
  `sources.json` seeds → crawl (depth 2, keyword filter, max 60 pages) → clean → chunk → embed (e5 `passage:` prefix) → `data/index.json`.
  *Done when:* `npm run ingest` writes an index with >0 chunks, each carrying url/title metadata. ⚠️ Verified offline (local docs only); the web crawl must run on a machine with internet access.

- [x] **T5. Retriever** (3 min) — FR3
  Load the index, embed the query (`query:` prefix), cosine top-k=6, threshold, dedupe by URL.
  *Done when:* a unit test with a tiny fixture index returns the expected chunk first.

- [x] **T6. Knowledge agent** (5 min) — FR3, FR4, FR8, G1, G2
  System prompt in `prompts/knowledge.md`; tools: `search_knowledge_base` + `web_search` (max_uses 2); returns answer + sources.
  *Done when:* an integration test with FakeLLM returns sources; a manual run of scenario #1 cites getnet URLs.

- [x] **T7. Support agent** (5 min) — FR5, FR6, G3
  Tool-use loop (max 5 iterations), prompt in `prompts/support.md`, may call `search_knowledge_base` for troubleshooting.
  *Done when:* scenario #3 calls `get_settlements` and returns a date and an amount.

- [x] **T8. Router + orchestrator** (6 min) — FR1, FR2, G4
  Router forced through the `route_decision` tool (zod schema) with few-shot prompt; the orchestrator runs plan steps sequentially with a shared context; parse failure → escalation.
  *Done when:* integration tests cover a single-step route, the multi-step route (#5) and malformed Router output.

- [x] **T9. API + observability** (4 min) — spec §5, G5, G6
  `POST /chat` (zod-validated), `GET /health`, `trace_id`, one structured log per stage with latency and tokens.
  *Done when:* `inject` tests cover 200, 400 (empty message) and the response shape matching the spec.

- [ ] **T10. Docker** — written; `docker compose up` still to be verified on a machine with a Docker daemon (3 min) — G5
  Multi-stage Dockerfile, embedding model cached at build, `docker-compose.yml`, `.env.example`.
  *Done when:* `docker compose up` answers `curl /health` and scenario #1.

- [x] **T11. README** (3 min)
  Build/run/test/ingest instructions, architecture diagram, message workflow, RAG pipeline (ingestion → storage → retrieval → generation), design choices and trade-offs, testing strategy, observability.
  *Done when:* a fresh clone can follow the README end to end.

- [x] **T12. Personality stage** (4 min) — FR10, diagram
  `PersonalityStage` after the output guardrail; fact-preservation check; config switch. *Done when:* unit tests cover rewrite, fact loss and failure; integration test shows `personality` in `agents`.

- [x] **T13. Local LLM provider** (bonus) — plan §12
  `OllamaClient` adapter, `capabilities` on `LLMClient`, local DuckDuckGo `web_search` tool, compose profile `local`. *Done when:* unit tests cover the adapter mapping, emulated forced tool choice and the search tool; `docker compose --profile local up` answers without a key.

## Bonus (in order — drop from the bottom)

- [x] **B1. Guardrails** — spec §7: input injection/other-user checks, PII masking in logs, output source check. *Done when:* N1 → blocked; a unit test proves masking.
- [x] **B2. Escalation agent** — handoff ticket + template reply; covers N2, N3 and low confidence. *Done when:* integration tests pass for N2 and N3.
- [ ] **B3. Eval runner** — written; scorecard still to be run with the real API key — `npm run eval` over `tests/eval/scenarios.json` (10 + negatives) printing route accuracy, tool accuracy and source coverage. *Done when:* the scorecard prints with the real API.

## Before starting the clock (environment only, not development)

- [ ] Anthropic key working; web search enabled on the org in Console
- [ ] Node 20, Docker and Claude Code installed; empty GitHub repo created
- [ ] Embedding model pre-downloaded once (avoids a slow first run)
