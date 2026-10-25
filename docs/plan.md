# Plan — Getnet Multi-Agent Support System

> SDD stage 2: **how**. Every decision traces back to a requirement in `spec.md`.

## 1. Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 20 + TypeScript (strict) | Typed contracts between agents; team-friendly |
| HTTP | Fastify | Fast, built-in schema validation, `inject()` for integration tests |
| Validation | zod | One schema for API payloads and LLM structured outputs (FR1) |
| LLM | `@anthropic-ai/sdk` | Single key (A1); native tool use and server-side web search (FR4) |
| Models | Router: `claude-haiku-5-5`; agents: `claude-sonnet-5-5` (env-configurable) | Cheap classification, stronger generation |
| Web search | Anthropic `web_search` server tool, `max_uses: 2` | No extra key, citations included |
| Scraping | `fetch` + `cheerio` | Light, no headless browser |
| Embeddings | `@huggingface/transformers` with `Xenova/multilingual-e5-small` (local) | Free, multilingual (A2), no second key |
| Vector store | In-memory cosine search over `data/index.json`, behind a `VectorStore` interface | A few hundred chunks don't need a DB; swap to LanceDB/Chroma by implementing the interface |
| Logs | pino (JSON) | Structured traces per `trace_id` |
| Tests | Vitest + Fastify `inject` | Fast, TS-native |

## 2. Architecture

```
POST /chat
   │
   ▼
[Input Guardrail] ──blocked──► response(route=blocked)
   │
   ▼
[Router Agent]  (structured output: route, plan[], confidence, language)
   │
   ├─ confidence < 0.6 / asks for human ─► [Escalation Agent]
   ▼
[Orchestrator] executes plan steps sequentially, passing a shared AgentContext
   ├─ [Knowledge Agent]  tools: search_knowledge_base (RAG), web_search (server tool)
   └─ [Support Agent]    tools: get_customer_profile, get_settlements, get_transactions,
                                get_terminal_status, create_support_ticket
   │
   ▼
[Output Guardrail] (sources present? PII masked?)
   │
   ▼
[Personality stage]  (brand voice; facts verified unchanged, else original kept)
   │
   ▼
JSON response + one log line per stage
```

Communication mechanism: **direct async function calls** through an `Orchestrator`. Each agent implements:

```ts
interface Agent {
  name: AgentName;
  run(ctx: AgentContext): Promise<AgentResult>;
}
interface AgentContext {
  traceId: string; userId: string; message: string; language: string;
  previous: AgentResult[];          // outputs of earlier plan steps (FR2)
}
interface AgentResult {
  answer: string; sources: Source[]; toolsUsed: string[];
  handoff?: { reason: string; ticketId?: string };
}
```

Why not a message queue or LangGraph: with 3–4 agents and a linear plan, plain functions are the simplest thing that's easy to test and explain. The `Agent` interface keeps the door open to move to a queue later.

## 3. Folder layout

```
src/
  server.ts                 # Fastify app + /chat + /health
  config.ts                 # env parsing (zod)
  llm/
    client.ts               # LLMClient interface
    anthropic.ts            # real implementation
    fake.ts                 # scripted fake for tests
  agents/
    router.ts  knowledge.ts  support.ts  escalation.ts
    prompts/                # one .md file per agent system prompt
  orchestrator.ts
  guardrails/ input.ts output.ts pii.ts
  rag/
    ingest.ts               # npm run ingest
    chunker.ts  embedder.ts  vectorStore.ts  retriever.ts
  support/
    repository.ts           # CustomerRepository interface
    mockRepository.ts       # JSON-backed, dates relative to today (A3)
    tools.ts                # tool definitions + handlers
  observability/logger.ts
data/
  customers.json  index.json  sources.json
tests/
  unit/  integration/  eval/scenarios.json
```

## 4. RAG pipeline

1. **Ingestion** (`npm run ingest`): start from seed URLs in `data/sources.json`, crawl same-domain links up to depth 2 (max ~60 pages), filtered by keywords (maquininha, get-, pix, antecip, link, pagamento, ajuda, faq, crediário, taxa). Seeds:
   - `https://www.getnet.net/` and `https://www.getnet.net/en` (given)
   - Getnet Brasil official site pages (`site.getnet.com.br`) for products, Pix, payment link, receivables advance, help
   - Santander Getnet product page and blog posts about Getnet products (extra sources, as the challenge asks)
2. **Cleaning**: cheerio removes nav, footer, scripts; keep title, headings, body text.
3. **Chunking**: ~500 tokens with 80 overlap, split on headings/paragraphs; each chunk keeps `{url, title, heading}` metadata.
4. **Embedding**: e5 needs prefixes: `passage: ` for chunks, `query: ` for queries. Normalized vectors.
5. **Storage**: `data/index.json` (chunks + vectors + metadata). A snapshot is committed so the API runs offline (FR9).
6. **Retrieval**: top-k = 6 by cosine, drop chunks below a similarity threshold, dedupe by URL.
7. **Generation**: the Knowledge agent calls `search_knowledge_base(query)` as a tool. This lets the model reformulate the query (e.g. English → Portuguese terms) and search more than once. The prompt requires answering only from returned chunks and citing URLs; otherwise it says it couldn't find the information (FR3).

## 5. Agents & prompts

- **Router**: system prompt with the route definitions plus few-shot examples (one per route, including a multi-step example). Output is forced via a single tool `route_decision` whose input schema is the zod schema. Parse failure or exception → escalation (FR1).
- **Knowledge**: tools are `search_knowledge_base` and `web_search`. The prompt states: Getnet topics → knowledge base first; non-Getnet, time-sensitive topics → web; never mix in unsupported claims; answer in `language`.
- **Support**: tool-use loop (max 5 iterations). `user_id` is injected by the orchestrator into every tool handler; the model never chooses it (FR6). The prompt asks the agent to explain data in plain language, suggest next steps, and open a ticket when the issue persists.
- **Personality** (FR10): Haiku rewrites tone only; code extracts amounts/dates/codes/ids from the draft and keeps the original if any is missing from the rewrite. Disabled via `PERSONALITY_ENABLED=false` (also in tests).
- **Escalation**: deterministic. It creates a handoff ticket in the mock repository and returns a template message in the user's language, with no LLM call needed.

## 6. Mock customer data

`cliente1988`: Get Smart terminal, `status: offline`, `last_seen` 3h ago, Wi-Fi configured, 4G chip active. Sales from yesterday with an expected settlement date of D+1 business day. One declined transaction with code `51` (insufficient funds) and one with code `05` (not authorized). `cliente2000` exists for isolation tests. Dates are computed at load time relative to `now()`.

## 7. Guardrails

- Input: zod limits; regex + small denylist for injection patterns ("ignore previous instructions", "system prompt"); mention of another `user_id` → blocked. The Router can also return `blocked` for harmful or off-policy requests.
- PII: mask card numbers (13–19 digits, Luhn), CPF and CNPJ in logs.
- Output: Knowledge answer with zero sources and not an explicit "not found" → append a disclaimer and set `handoff.required = true`.

## 8. Observability

- `trace_id` per request, propagated in `AgentContext`, returned in the response.
- Per stage: `{trace_id, stage, agent, latency_ms, input_tokens, output_tokens, route, confidence, tools}`.
- Production path (README only): ship pino logs to an OTel collector; dashboards for route distribution, escalation rate, p95 latency, tokens/request; alerts on error rate and escalation spikes.

## 9. Testing strategy

| Level | What | How |
|---|---|---|
| Unit | chunker, cosine retrieval, PII masking, guardrail regexes, repository date logic, tool handlers (incl. FR6 isolation) | Vitest, no network |
| Integration | full `/chat` pipeline per route, invalid payloads, unknown user, Router malformed output → escalation | Fastify `inject` + `FakeLLM` returning scripted tool calls |
| Eval (real LLM) | the 10 spec scenarios + negatives: route accuracy, required tools called, sources present, must-contain keywords | `npm run eval`, needs API key, prints a scorecard; separate from CI |

Future work for the README: LLM-as-judge for groundedness, a regression gate on route accuracy, and a golden set grown from production escalations.

## 10. Docker

- Multi-stage Dockerfile (build TS → slim runtime). The embedding model is downloaded at build time and cached in the image layer.
- `docker-compose.yml` with one `api` service, `.env` containing `ANTHROPIC_API_KEY`, port 3000.
- `docker compose run api npm run ingest` refreshes the index.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Getnet site is JS-rendered or blocks scraping | Committed index snapshot plus extra seed sources; document it |
| Web search not enabled on the org | Check in Console before the timed session; Knowledge agent degrades to "can't fetch live data" |
| 60-minute limit | Tasks ordered by priority; bonus tasks are last and droppable |

## 12. Implementation notes (deviations decided while building)

| Plan said | Built | Why |
|---|---|---|
| Support agent also has `search_knowledge_base` | Support only has account tools; troubleshooting comes from the `support → knowledge` plan | One responsibility per agent; the multi-step plan makes the collaboration explicit and testable (scenario #5) |
| One `.md` file per prompt | All prompts in `src/agents/prompts.ts` with a `PROMPT_VERSION` | Ships with the compiled build; one place to review and version prompts |
| Output guardrail: no sources → handoff | `<<NOT_FOUND>>` answers → Escalation agent opens a ticket; answers with no sources at all → disclaimer + `handoff.required=true` without ticket | Distinguishes an honest "I don't know" (worth a human) from an unverifiable answer (warn the user) |
| — | Hashing embedder (`EMBEDDER=hashing`) besides e5 | Tests and offline runs need no model download |
| — | `data/knowledge/support-playbook.md` (synthetic, clearly labelled) ingested with the web pages | The Getnet site has no troubleshooting content; models the "internal" source the challenge mentions |
| — | Agent exceptions → Escalation instead of HTTP 500 | Graceful degradation during LLM outages; 500 is kept for bugs outside the agents |
| Index snapshot committed | The snapshot must be produced by `npm run ingest` on a machine with internet access and committed | The build sandbox could not reach getnet.net / Hugging Face |
| — | `LLM_PROVIDER=ollama` + compose profile `local` (Ollama + qwen2.5:7b, DuckDuckGo tool for web search) | Lets the evaluator run everything with no API key; proves the provider abstraction. Trade-off: slower and weaker routing than Claude, so Claude stays the default |
