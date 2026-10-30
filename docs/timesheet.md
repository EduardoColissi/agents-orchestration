# Timesheet — v2 timed build

Generated from `git log`. Writing the spec, plan and tasks happened before the clock (commit `3e70705`), as SDD allows.

| | Time (-03:00) |
|---|---|
| Clock start — tag `v2-clock-start` | 12:52:29 |
| Core T1–T11 done | 13:17:16 (24:47) |
| Optional T12–T14 done | 13:23:48 (31:19) |
| Last code commit — tag `v2-clock-end` | 13:32:10 (**39:41**) |

## Commits inside the clock

| Time | Commit | Message |
|---|---|---|
| 12:53:04 | `d957edc` | chore: import v1 baseline (router, agents, tools, guardrails, rag) |
| 12:55:31 | `5d7b5f8` | feat(llm): harden the ollama adapter and use per-role local models |
| 12:57:01 | `f55f254` | feat(store): add sqlite persistence with migrations and an append-only audit log |
| 13:00:54 | `61f890e` | feat(auth): authenticate with JWT and derive identity from the token |
| 13:03:46 | `da0846c` | feat(memory): persist conversations per authenticated owner |
| 13:06:32 | `42a22b5` | feat(memory): feed history and a rolling summary to the router and agents |
| 13:07:18 | `09f4bc0` | feat(hitl): add the persistent handoff queue with versioned transitions |
| 13:10:59 | `b1ebdc4` | feat(hitl): let operators reply to escalations and give control back to the agent |
| 13:13:39 | `795b28f` | feat(hitl): gate terminal replacement behind operator approval and resume from checkpoint |
| 13:16:19 | `7c2ee58` | feat(eval): judge the deployed api with an independent model and a regression gate |
| 13:17:16 | `0e367c4` | build(docker): run the stack on node 24 with optional gpu and an eval profile |
| 13:18:54 | `cd2275f` | feat(orchestration): replan after observing a specialist result |
| 13:20:05 | `f124206` | ci: add readiness checks and a pipeline that tests, builds and smokes the container |
| 13:20:48 | `b7a1cd6` | fix: tune the judge and the support prompt after the first live eval run |
| 13:23:48 | `79ea7be` | feat(observability): persist per-stage spans and expose operational metrics |
| 13:24:33 | `ba64c0a` | fix(support): accept a wrapped terminal serial in the replacement request |
| 13:26:38 | `5e4a0c9` | fix(orchestration): harden approvals and language after the second live run |
| 13:27:12 | `29221c7` | feat(eval): check cross-merchant data leaks deterministically |
| 13:32:10 | `04926f3` | fix(support): propose the replacement with a constrained call when the merchant asks for it |

## After the clock (declared)

Everything below is verification and documentation, not part of the 60 minutes. Code fixes found here are separate `fix:` commits, in three passes: an independent review of the diff (13:33–14:07), a re-evaluation against the brief and the original review (15:18–16:01), and a hands-on walk through the test plan with the review's own example (16:58–19:30). The `final` branch (19:30) merges v2 into v1. One more change followed on 2026-10-30, after checking the web search by hand: a search API behind the local `web_search` tool.

| Time | Commit | Message |
|---|---|---|
| 13:33:43 | `48e4689` | docs: record the timed build, implementation notes and development eval runs |
| 13:44:03 | `927498f` | fix(hitl): close approval and delivery gaps found in the post-clock review |
| 13:45:02 | `f324a54` | fix(support): tighten replacement intent and check proposals against the merchant data |
| 13:46:16 | `3293860` | fix: address the remaining post-clock review findings |
| 13:48:11 | `0df9625` | fix: findings of the official evaluation run |
| 13:48:11 | `fe70d76` | feat(eval): re-judge an existing report with another judge |
| 13:49:25 | `d5d1352` | fix: second review round (intent precision, concurrent deliveries, partial-run gate) |
| 13:53:00 | `ebcaa39` | fix: claude 5.5 compatibility and replacement intent (third review round) |
| 13:57:13 | `0f872f7` | fix(eval): gate rubric scores per judge and retry incomplete judge output |
| 14:07:38 | `9a82420` | docs: README v2, evidence and final evaluation reports |
| 15:18:42 | `c1799d3` | fix(auth): rate limit logins per client IP and username |
| 15:27:43 | `6e9e3f5` | fix(router): stop the few-shot from leaking into single-turn rewrites |
| 15:29:44 | `b1ebd1d` | fix(hitl): keep approval outcomes consistent with the decision and evaluate them with evidence |
| 15:31:33 | `06eb23a` | feat(orchestration): replan on more signals and evaluate replanning for real |
| 15:32:19 | `5d355d6` | feat: rate limit chat turns per merchant and stamp builds into eval reports |
| 15:44:19 | `be33529` | fix(orchestration): a finished live-data answer is not flagged for a human either |
| 15:44:28 | `51e70ba` | docs: correct README claims found by the independent re-evaluation |
| 16:01:58 | `9a09383` | docs: final evaluation results and timesheet |
| 16:58:50 | `887a0a2` | fix(auth): close the login rate-limit bypass found in the re-evaluation |
| 18:30:06 | `4e6764d` | fix(knowledge): find the playbook in Portuguese and keep the support answer when knowledge finds nothing |
| 18:30:06 | `054d787` | fix(support): label settlement days relative to today in code |
| 18:30:06 | `c2ff2c5` | docs: how to verify, configure, run the UI and the evaluation; how the agents use tools |
| 18:39:21 | `9e8bd2f` | fix(knowledge): search the offline-machine guide in code when support reports one |
| 18:53:31 | `16abfff` | fix(orchestration): join support facts and knowledge guidance in code |
| 19:01:59 | `1dd9c26` | fix: drop restated facts from the guidance and summarize settlements in code |
| 19:30:01 | `c24d56a` | docs(plan): record the fixes found by walking through the test plan |
| 19:38 | `8f62d3f` | Merge v2 into v1 (branch `final`: v1's history + v2's history, v2's content) |
| 19:56 | `e0a559a` | docs: timeline of the build, final evaluation and a point-by-point checklist |
| 20:04 | `9cfe80b` | docs(evidence): restart log captured on the final build |
| 2026-10-30 | (this commit) | feat(knowledge): search the web through the Brave Search API when a key is set |

Verification after the clock:

- Independent review of the whole diff by a separate agent (3 rounds, the cap of the process): 13 findings in round 1 (3 critical), all fixed.
- Independent re-evaluation of the submission against the brief and the original feedback (same rubric): found the router copying its prompt example into single-turn messages, replanning that never fired, an approval outcome that contradicted the decision, and README claims that did not hold — all fixed in the commits above.
- Evaluations against the Docker stack (22–23 cases × 3): clock-end code and final code, each re-judged with Claude; the gate caught one regression on the way (handoff 0.905, fixed in `be33529`). Baseline from the Claude-judged final run.
- `docker compose restart api` evidence, GPU and metrics snapshots in `docs/evidence/`.
- Hands-on walk through the test plan (16:58–19:30), starting with the review's own example: the Portuguese playbook, the offline guide searched in code, the composed support + knowledge answer, the settlement day labels and a login-limit bypass — each a `fix:` with a test (plan §14).
- Final evaluation on the `final` branch (build `8f62d3f`, 23 × 3, fresh database): deterministic checks 1.0 except sources 0.71 (web cases blocked) and route 0.98 (one follow-up sent to a person by the 3B router); by Claude, 4/4 canaries, groundedness 4.03 · correctness 3.68 · relevance 4.19 · helpfulness 3.21 · safety 1.0, gate passed; new baseline. UI smoke 26/26 against the same build.
- Web search checked by hand (2026-10-30): DuckDuckGo's HTML page has answered this network with a bot challenge since the first full evaluation on 2026-10-29 (bursts of identical queries from a client that identifies itself as a bot; two days earlier the same tool on v1 fetched the euro rate normally), so the two web cases had no sources in every report. The Brave Search API, which allows programmatic access, now backs `web_search` on Ollama when `BRAVE_SEARCH_API_KEY` is set; without the key the DuckDuckGo path and its declared degradation remain, and on Claude the search stays server-side.
