import type { LLMClient, LLMMessage, ToolResultContent, ToolSpec } from '../llm/client.js';
import { maskPII } from '../guardrails/pii.js';
import { addUsage, emptyUsage, type Source, type TokenUsage, type ToolEvidence } from '../types.js';

export interface ToolExecutionResult {
  /** Serialized result handed back to the model. */
  content: string;
  /** Sources produced by the tool (e.g. knowledge base chunks). */
  sources?: Source[];
  isError?: boolean;
}

export interface ToolExecutionOptions {
  /** Makes a side effect idempotent (e.g. the handoff id of an approved action). */
  idempotencyKey?: string;
}

/** A tool the model can call, with its handler. Handlers receive validated-by-caller input. */
export interface AgentTool {
  spec: ToolSpec;
  /** The loop stops before running it; an operator must approve (HITL). */
  requiresApproval?: boolean;
  execute(input: unknown, options?: ToolExecutionOptions): Promise<ToolExecutionResult>;
}

export interface ToolLoopParams {
  llm: LLMClient;
  model: string;
  system: string;
  userMessage: string;
  /** Resume from a checkpoint instead of starting from `userMessage`. */
  initialMessages?: LLMMessage[];
  tools: AgentTool[];
  webSearch?: { maxUses: number };
  maxIterations: number;
  maxTokens?: number;
}

export interface ToolLoopResult {
  text: string;
  toolsUsed: string[];
  sources: Source[];
  usage: TokenUsage;
  iterations: number;
  hitIterationLimit: boolean;
  evidence: ToolEvidence[];
  /** Set when the model called an approval-gated tool: the loop stopped before running it. */
  interrupt?: ToolLoopInterrupt;
}

export interface ToolLoopInterrupt {
  pendingCall: { id: string; name: string; input: unknown };
  /** Results of the non-gated calls of the same turn, to send back together on resume. */
  siblingResults: ToolResultContent[];
  /** Conversation with the model up to (and including) the gated call. JSON-serializable. */
  messages: LLMMessage[];
}

const EVIDENCE_MAX_CHARS = 4000;

/**
 * Generic agentic loop: call the model, execute requested tools, feed results back,
 * stop when the model answers without tool calls or the iteration budget is spent.
 * The last iteration is sent with `toolChoice: 'none'`, so the agent always ends with an answer.
 */
export async function runToolLoop(params: ToolLoopParams): Promise<ToolLoopResult> {
  const byName = new Map(params.tools.map((t) => [t.spec.name, t]));
  const messages: LLMMessage[] = params.initialMessages ? [...params.initialMessages] : [{ role: 'user', content: params.userMessage }];
  const toolsUsed: string[] = [];
  const sources: Source[] = [];
  const evidence: ToolEvidence[] = [];
  let usage = emptyUsage();
  // The web search cap is per agent run, not per API call (spec §9 cost control).
  let searchesLeft = params.webSearch?.maxUses ?? 0;

  for (let iteration = 1; iteration <= params.maxIterations; iteration++) {
    const last = iteration === params.maxIterations && params.maxIterations > 1;
    const response = await params.llm.complete({
      model: params.model,
      system: params.system,
      messages,
      tools: params.tools.map((t) => t.spec),
      // Once the budget is spent the tool stays declared (max_uses: 1) only if earlier turns
      // contain search blocks, because the API needs the tool to replay them.
      ...(searchesLeft > 0 ? { webSearch: { maxUses: searchesLeft } } : usage.webSearches > 0 ? { webSearch: { maxUses: 1 } } : {}),
      ...(last ? { toolChoice: 'none' as const } : {}),
      maxTokens: params.maxTokens ?? 1024,
    });
    usage = addUsage(usage, response.usage);
    searchesLeft = Math.max(0, searchesLeft - response.usage.webSearches);
    sources.push(...response.webSources);
    if (response.usage.webSearches > 0) toolsUsed.push('web_search');

    if (response.toolCalls.length === 0) {
      return { text: response.text, toolsUsed: unique(toolsUsed), sources: dedupeSources(sources), usage, iterations: iteration, hitIterationLimit: false, evidence };
    }

    messages.push({ role: 'assistant', content: response.assistantContent });
    const results: ToolResultContent[] = [];
    const gated = response.toolCalls.find((c) => byName.get(c.name)?.requiresApproval);
    for (const call of response.toolCalls) {
      if (call === gated) continue;
      toolsUsed.push(call.name);
      const tool = byName.get(call.name);
      const toolStarted = performance.now();
      let result: ToolResultContent;
      if (!tool) {
        result = { type: 'tool_result', tool_use_id: call.id, content: `Unknown tool: ${call.name}`, is_error: true };
      } else {
        try {
          const out = await tool.execute(call.input);
          if (out.sources) sources.push(...out.sources);
          result = { type: 'tool_result', tool_use_id: call.id, content: out.content, ...(out.isError ? { is_error: true } : {}) };
        } catch (err) {
          result = { type: 'tool_result', tool_use_id: call.id, content: `Tool failed: ${(err as Error).message}`, is_error: true };
        }
      }
      results.push(result);
      evidence.push({ name: call.name, input: call.input, output: maskPII(result.content).text.slice(0, EVIDENCE_MAX_CHARS), isError: result.is_error === true, durationMs: Math.round(performance.now() - toolStarted) });
    }
    if (gated) {
      toolsUsed.push(gated.name);
      const interrupt = { pendingCall: { id: gated.id, name: gated.name, input: gated.input }, siblingResults: results, messages };
      return { text: '', toolsUsed: unique(toolsUsed), sources: dedupeSources(sources), usage, iterations: iteration, hitIterationLimit: false, evidence, interrupt };
    }
    messages.push({ role: 'user', content: results });
  }

  return { text: '', toolsUsed: unique(toolsUsed), sources: dedupeSources(sources), usage, iterations: params.maxIterations, hitIterationLimit: true, evidence };
}

const unique = (xs: string[]) => [...new Set(xs)];

export function dedupeSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
}
