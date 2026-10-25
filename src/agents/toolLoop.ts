import type { LLMClient, LLMMessage, ToolResultContent, ToolSpec } from '../llm/client.js';
import { addUsage, emptyUsage, type Source, type TokenUsage } from '../types.js';

export interface ToolExecutionResult {
  /** Serialized result handed back to the model. */
  content: string;
  /** Sources produced by the tool (e.g. knowledge base chunks). */
  sources?: Source[];
  isError?: boolean;
}

/** A tool the model can call, with its handler. Handlers receive validated-by-caller input. */
export interface AgentTool {
  spec: ToolSpec;
  execute(input: unknown): Promise<ToolExecutionResult>;
}

export interface ToolLoopParams {
  llm: LLMClient;
  model: string;
  system: string;
  userMessage: string;
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
}

/**
 * Generic agentic loop: call the model, execute requested tools, feed results back,
 * stop when the model answers without tool calls or the iteration budget is spent.
 */
export async function runToolLoop(params: ToolLoopParams): Promise<ToolLoopResult> {
  const byName = new Map(params.tools.map((t) => [t.spec.name, t]));
  const messages: LLMMessage[] = [{ role: 'user', content: params.userMessage }];
  const toolsUsed: string[] = [];
  const sources: Source[] = [];
  let usage = emptyUsage();
  // The web search cap is per agent run, not per API call (spec §9 cost control).
  let searchesLeft = params.webSearch?.maxUses ?? 0;

  for (let iteration = 1; iteration <= params.maxIterations; iteration++) {
    const response = await params.llm.complete({
      model: params.model,
      system: params.system,
      messages,
      tools: params.tools.map((t) => t.spec),
      // Once the budget is spent the tool stays declared (max_uses: 1) only if earlier turns
      // contain search blocks, because the API needs the tool to replay them.
      ...(searchesLeft > 0 ? { webSearch: { maxUses: searchesLeft } } : usage.webSearches > 0 ? { webSearch: { maxUses: 1 } } : {}),
      maxTokens: params.maxTokens ?? 1024,
    });
    usage = addUsage(usage, response.usage);
    searchesLeft = Math.max(0, searchesLeft - response.usage.webSearches);
    sources.push(...response.webSources);
    if (response.usage.webSearches > 0) toolsUsed.push('web_search');

    if (response.toolCalls.length === 0) {
      return { text: response.text, toolsUsed: unique(toolsUsed), sources: dedupeSources(sources), usage, iterations: iteration, hitIterationLimit: false };
    }

    messages.push({ role: 'assistant', content: response.assistantContent });
    const results: ToolResultContent[] = [];
    for (const call of response.toolCalls) {
      toolsUsed.push(call.name);
      const tool = byName.get(call.name);
      if (!tool) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: `Unknown tool: ${call.name}`, is_error: true });
        continue;
      }
      try {
        const out = await tool.execute(call.input);
        if (out.sources) sources.push(...out.sources);
        results.push({ type: 'tool_result', tool_use_id: call.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: `Tool failed: ${(err as Error).message}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  return { text: '', toolsUsed: unique(toolsUsed), sources: dedupeSources(sources), usage, iterations: params.maxIterations, hitIterationLimit: true };
}

const unique = (xs: string[]) => [...new Set(xs)];

export function dedupeSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
}
