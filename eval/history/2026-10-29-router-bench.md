# Router model bench (before the v2 clock, 2026-10-29)

Question: can the cheap model route as well as the specialist model, keeping the "cheap router + stronger specialist" design on the local provider?

**Setup.** Ollama 0.40.11 on an RTX 3060 12 GB (100% GPU). The v1 Router prompt (`PROMPT_VERSION 2026-10-23.2`) sent directly to `/api/chat` with `format` = the `RouteDecision` JSON Schema (constrained decoding), `temperature 0`, `num_ctx 8192`. Cases: the 15 v1 scenarios plus a follow-up with conversation context ("E como reinicio ela?") and a terminal replacement request. Pass = route and normalized plan as expected.

| Model | Route + plan | p50 latency |
|---|---|---|
| `llama3.2:3b` | 17/17 | 0.54 s |
| `llama3.1:8b` | 17/17 | 0.84 s |

**Decision.** Router = `llama3.2:3b`, agents = `llama3.1:8b`.

**Contrast — v1 adapter.** The full v1 eval with `llama3.2:3b` on the v1 Ollama adapter (forced tool *emulated* through the prompt, no `format`) routed only 3/15 correctly: every other message fell back to escalation in ~0.5 s because the output did not match the schema. With `llama3.1:8b` the same run failed the same way, and the router log shows why: Llama's tool calls send nested arguments as strings (`plan: "[\"knowledge\"]"`, `confidence: "0.9"`). The v2 adapter uses `format` for forced tools and coerces tool-call arguments against the tool schema (plan §9).
