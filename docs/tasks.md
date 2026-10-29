# Tasks — Getnet Multi-Agent Support System (v2)

> SDD stage 3: the timed build, in order. One commit per task (Conventional Commits), so the commit timestamps are the clock.
> Clock = from tag `v2-clock-start` to tag `v2-clock-end`, 60 minutes hard stop. Writing these docs is not part of the clock.
> Core estimate: **55 min** (5 min slack). Everything after the clock is listed in `timesheet.md` as post-clock.

## Before the clock (environment and docs only)

- [x] P1. Docker Desktop with GPU (`docker run --gpus all … nvidia-smi` → RTX 3060).
- [x] P2. Ollama 0.40.11 with `llama3.2:3b`, `llama3.1:8b` (generator) and `qwen2.5:7b` (judge) in the `ollama-models` volume.
- [x] P3. `node:sqlite` verified under Vitest on Node 24; `jose` and `@fastify/rate-limit` cached.
- [x] P4. `.env`: `LLM_PROVIDER=ollama`, per-role models, `COMPOSE_FILE` with the GPU override.
- [x] P5. Router bench with `format`: `llama3.2:3b` 17/17, `llama3.1:8b` 17/17 → router = 3B (`eval/history/2026-10-29-router-bench.md`). v1 adapter without `format`: 3/15.
- [x] P6. `spec.md`, `plan.md`, `tasks.md`, `eval/golden.json`, v1 history report committed; tag `v2-clock-start`.

## Core (clock)

- [x] **T1. Import v1** (2 min) — done 12:53:04 · 0:35 — reuse declared
  `git checkout v1 -- src tests data scripts? tsconfig* vitest.config.ts package*.json Dockerfile .dockerignore .env.example`; add `jose`, `@fastify/rate-limit`; `engines.node >=24`; `.gitignore` += `var/`.
  *Done when:* v1 suite green on Node 24. *Commit:* `chore: import v1 baseline (router, agents, tools, guardrails, rag)`

- [x] **T2. Local provider hardening** (4 min) — done 12:55:31 · 3:02 — plan §9 · independent of T3–T11
  `format` for forced tools, `num_ctx`/`keep_alive`, text tool calls, argument coercion against the tool schema, `toolChoice:'none'` on the last iteration, per-role Ollama models, `LLM_PROVIDER` default `ollama`, evidence capture in `runToolLoop`.
  *Done when:* `ollama.test.ts` + `toolLoop.test.ts` cover format/text calls/last iteration/evidence. *Commit:* `feat(llm): harden the ollama adapter and use per-role local models`

- [x] **T3. SQLite store** (4 min) — done 12:57:01 · 4:32 — FR12, FR22 · plan §4
  `src/store/{db,audit,tickets}.ts`, migration 1, append-only triggers; mock repository writes tickets to SQLite (`INSERT OR IGNORE` with explicit id).
  *Done when:* reopening the file keeps data; UPDATE/DELETE on audit throws; ticket with the same id is created once. *Commit:* `feat(store): add sqlite persistence with migrations and an append-only audit log`

- [x] **T4. Authentication and authorization** (7 min) — done 13:00:54 · 8:25 — FR6–FR10 · plan §5
  `src/auth/{secret,jwt,credentials,plugin}.ts`, `POST /auth/token` (+ rate limit), `data/users.json`, `scripts/hash-password.ts`, `requireRole`, `user_mismatch`; test helper `tokenFor()`.
  *Done when:* 401 (missing, tampered, expired, `alg:none`, wrong audience, wrong password + audit), 429 on the 6th login, 403 (role, mismatch with zero LLM calls); v1 tests green with tokens. *Commit:* `feat(auth): authenticate with JWT and derive identity from the token`

- [x] **T5. Persistent conversations** (5 min) — done 13:03:46 · 11:17 — FR9, FR11, FR12 · plan §6
  `src/store/conversations.ts`, `src/chat/service.ts` (getOwned|create, lock, turn transaction), `conversation_id` in request/response, `GET /conversations/:id`.
  *Done when:* turn 2 continues turn 1 after rebuilding the app on the same file; cliente2000 gets 404 on cliente1988's conversation; concurrent turn → 409. *Commit:* `feat(memory): persist conversations per authenticated owner`

- [x] **T6. Context for Router and agents** (5 min) — done 13:06:32 · 14:03 — FR13–FR16 · plan §6
  `src/memory/{context,compaction}.ts`; Router input + `standalone_query` + guardrail on it; agents receive history/query; few-shot follow-up; `PROMPT_VERSION`.
  *Done when:* turn-2 `llm.calls` of Router **and** Knowledge contain turn 1; Knowledge searches with the standalone query; summary keeps TCK/serial/amount; blocked turn absent from context. *Commit:* `feat(memory): feed history and a rolling summary to the router and agents`

- [x] **T7. Handoff store** (5 min) — done 13:07:18 · 14:49 — FR20–FR23 · plan §8 · independent of T4–T6
  `src/store/handoffs.ts`: create (one open per conversation), CAS resolve, complete exactly-once, expire, `findResuming`, audit per transition.
  *Done when:* unit tests for each transition, 409 on stale version, second delivery ignored. *Commit:* `feat(hitl): add the persistent handoff queue with versioned transitions`

- [x] **T8. HITL `assist`** (4 min) — done 13:10:59 · 18:30 — FR17, FR19–FR21 · plan §8
  Escalation opens the handoff; `src/hitl/service.ts`; operator routes (`handoffs`, `resolve`, `conversations/:id` with evidence); `reply`/`reject`; sweeper + boot recovery in `main.ts`.
  *Done when:* "quero falar com um humano" → operator reply → message in the conversation and visible to the next turn; double resolve 409; expiry with a fake clock; recovery idempotent; merchant on `/operator/*` 403. *Commit:* `feat(hitl): let operators reply to escalations and give control back to the agent`

- [x] **T9. HITL `approval`** (6 min) — done 13:13:39 · 21:10 — FR18–FR20 · plan §8
  `requiresApproval` in `defineTool`; tool loop interrupt + `initialMessages`; `request_terminal_replacement`; `SupportAgent.resume(checkpoint, result)`; approve executes once; reject; fallback on provider/model mismatch.
  *Done when:* replacement request → `approval` handoff with no ticket; approve → 1 ticket + 1 message and the resumed run starts from the checkpoint (earlier tools not re-run); reject → 0 tickets; mismatched checkpoint → fallback. *Commit:* `feat(hitl): gate terminal replacement behind operator approval and resume from checkpoint`

- [x] **T10. Semantic evaluation over HTTP** (9 min) — done 13:16:19 · 23:50 — FR24–FR26 · plan §10
  `eval/{client,judge,report,run}.ts`, two phases, N runs, canaries, family check, baseline gate; `npm run eval`.
  *Done when:* unit tests for aggregation, gate, judge parsing and family refusal; `npm run eval -- --runs 1 --only 3` against the local server writes a real report (in background). *Commit:* `feat(eval): judge the deployed api with an independent model and a regression gate`

- [x] **T11. Docker and compose** (4 min) — done 13:17:16 · 24:47 — plan §11
  Dockerfile on Node 24 (+ `eval` stage, `/app/var`), portable `docker-compose.yml` (ollama, ollama-pull, api, eval profile), `docker-compose.gpu.yml`.
  *Done when:* `docker compose config` valid with and without the GPU override and with `--profile eval`; image build started in background. *Commit:* `build(docker): run the stack on node 24 with optional gpu and an eval profile`

**Result.** Core done at 24:47 (estimate 55 min); the cut ladder was not needed. Commit timestamps are the clock: `git log v2-clock-start..v2-clock-end`.

**Cut ladder.** (1) T4 over 8 min → rate limit moves to README "next steps". (2) T9 starting after minute 38 (nominal 36) → T9 moves after T11 (`assist` already closes interrupt → queue → operator → resume). Hard stop at 60:00; whatever is left is marked "not done" here.

## Optional (only if time remains, in this order) — all done inside the clock

- [x] T12. Replanning `decideNext()` over tool signals (`terminal_offline`, `not_found`, `tool_error`) — `replans[]` in the response. (5 min) — done 13:18:54 · 26:25
- [x] T13. `/ready` + GitHub Actions (test + docker build). (6 min) — done 13:20:05 · 27:36
- [x] T14. Spans in SQLite (router/agent/tool/rag) + `/operator/metrics` (p50/p95/p99, tokens, escalation rate). (7 min) — done 13:23:48 · 31:19

## Inside the clock, after the optional tasks

Short live evaluations against the local API (`npm run eval -- --runs 1 --only …`, reports in `eval/reports/2026-10-29T16-*`) found real model behaviours; each fix is its own commit before `v2-clock-end` (plan §14.5). Last code commit 13:32:10 → **clock 39:41**.

## After the clock (declared, see `timesheet.md`)

1. Tag `v2-clock-end`; `docs/timesheet.md` from `git log`.
2. `docker compose up -d` → `npm run eval -- --runs 3` against the container → `eval/reports/*` + `eval/baseline.json`.
3. `docker compose restart api` → same conversation still readable → `docs/evidence/restart.log`.
4. Bugs found in 2–3 → separate `fix:` commits, listed as post-clock.
5. README v2.
