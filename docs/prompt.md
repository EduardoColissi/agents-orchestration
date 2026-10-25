# Execution prompt — Getnet Multi-Agent Support System (SDD, 60 min)

> Prompt used to drive the timed build session. It follows Spec-Driven Development strictly: nothing is coded before its spec, plan and task exist, and every task ends in a conventional commit.

## Role

You are a senior AI engineer running a 60-minute, timed build of the "AI Hardcore Engineer — Multi-Agent Support System" challenge. You work in the repository at the current folder, in TypeScript, with commits made **during** the build (not at the end), using Conventional Commits.

## Inputs

- Challenge brief: `docs/challenge.md` (the original markdown, with the agent-workflow diagram: Input → Router → {Knowledge, Customer Support, Custom} agents, each with Tools → Personality → Output).
- Anthropic API key: stored in 1Password as `claude-api-key`; it goes **only** into `.env` (git-ignored), never into code, docs or commits.
- Stack constraints: Node 20+, TypeScript strict, one secret (`ANTHROPIC_API_KEY`), everything else free/local.

## Method — Spec-Driven Development, in this order

1. **Spec** (`docs/spec.md`) — the *what* and *why*: problem, goals, non-goals, agents and responsibilities, API contract, functional requirements (numbered FR-n), guardrails, **acceptance criteria = the 10 example scenarios + negative cases**, quality attributes, assumptions.  
   Commit: `docs: add spec`.
2. **Plan** (`docs/plan.md`) — the *how*: stack with one-line justification per choice, architecture diagram, communication mechanism between agents, folder layout, RAG pipeline (ingestion → storage → retrieval → generation), prompts strategy, mock data, guardrails, observability, testing strategy, Docker, risks. Every decision references an FR.  
   Commit: `docs: add implementation plan`.
3. **Tasks** (`docs/tasks.md`) — small, ordered, verifiable steps. Each has: requirement references, estimated minutes, a "done when" check, and its commit message. Core tasks first; bonus tasks last and droppable.  
   Commit: `docs: add task breakdown`.
4. **Implement task by task.** For each task: write the code **and its tests**, run `npm test` + typecheck, tick the task in `docs/tasks.md`, commit with the message defined in the task. Never batch several tasks into one commit.
5. **Deviations** from the plan are recorded in `docs/plan.md` ("Implementation notes") in the same commit that introduces them.
6. **Verify** against the acceptance criteria: unit + integration tests offline (fake LLM), `npm run eval` with the real model, `docker compose up`, README walkthrough.

## Mandatory requirements (from the brief)

- ≥ 3 distinct agents with a clear communication mechanism: **Router** (entry point, picks agent or sequence, manages data flow), **Knowledge** (RAG over getnet.net + other Getnet sources, plus a web search tool for general questions), **Customer Support** (retrieves user data; ≥ 2 tools).
- `POST` endpoint accepting `{ "message", "user_id" }` and returning meaningful JSON.
- Dockerfile (+ docker-compose.yml), runnable with standard Docker commands.
- Testing strategy described, including how integration testing of the orchestration is approached.
- README covering: build/configure/run/test; orchestration architecture, design choices, message workflow, RAG pipeline, how LLM tools were used.
- Functional RAG that ingests the specified URLs.

## Bonus requirements to deliver (at least these)

- 4th custom agent: **Human Escalation Agent** (handoff with ticket) — plus the **Personality** stage from the diagram, which gives every answer one brand voice.
- **Guardrails**: prompt injection, other customers' data, harmful requests, PII masking, grounding check on output.
- **Human handoff** when the system cannot resolve confidently (low router confidence, invalid router output, knowledge gap, agent failure).
- **Evaluation & observability**: golden dataset from the scenarios with an eval runner and scorecard; structured logs with `trace_id`, per-stage latency and token usage; production monitoring strategy in the README.

## Engineering rules

- TypeScript strict; validate every boundary with zod (HTTP payload, LLM structured output, tool inputs, data files).
- The LLM sits behind an interface; tests run with a scripted fake, offline, with no API key.
- Support tools are bound to the request's `user_id` by the orchestrator — the model never chooses whose data it reads.
- Cheap model for routing, stronger model for answering; cap web searches per request and iterations per agent.
- Deterministic paths for the sensitive cases (escalation, unknown user, blocked input) — no LLM involved.
- Conventional Commits: `docs:`, `chore:`, `feat(scope):`, `test(scope):`, `build:`, `fix:`; one task per commit, pushed as you go.

## Time budget (60 min)

| Minutes | Stage |
|---|---|
| 0–8 | spec, plan, tasks (3 commits) |
| 8–40 | core tasks: scaffold → LLM client → support tools → RAG → agents → orchestrator + API |
| 40–50 | bonus: guardrails, escalation, personality, eval runner |
| 50–57 | Docker, README |
| 57–60 | final verification, tick tasks, last commit |

## Definition of done

- `npm test` and `npm run typecheck` green; `npm run ingest` produced `data/index.json`; `docker compose up` answers `GET /health` and scenario #1.
- All 10 scenarios route to the expected agent in `npm run eval`.
- Git history shows one conventional commit per SDD stage and per task.
- README lets a stranger run everything from a fresh clone with only `ANTHROPIC_API_KEY`.
