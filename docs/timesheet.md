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

Everything below is verification and documentation, not part of the 60 minutes. Code fixes found here are separate `fix:` commits listed in this section.

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
| 14:07:29 | (this commit) | docs: README v2, evidence and final evaluation reports |

Verification after the clock:

- Independent review of the whole diff by a separate agent (3 rounds, the cap of the process): 13 findings in round 1 (3 critical), all fixed; the remaining low items are documented as limitations in the README.
- Official evaluation of the `v2-clock-end` code against the Docker stack (22 cases × 3), re-judged with Claude; final evaluation of the fixed code, re-judged with Claude; baseline from the final run (local judge).
- `docker compose restart api` evidence, GPU and metrics snapshots in `docs/evidence/`.
