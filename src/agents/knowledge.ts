import type { LLMClient } from '../llm/client.js';
import type { Agent, AgentContext, AgentResult } from '../types.js';
import { localDate } from '../support/dates.js';
import { knowledgePrompt } from './prompts.js';
import { dedupeSources, runToolLoop, type AgentTool } from './toolLoop.js';
import { createWebSearchTool, type WebSearch } from './webSearchTool.js';
import { reportsOfflineTerminal } from '../orchestration/replanner.js';
import { maskPII } from '../guardrails/pii.js';
import type { Source, ToolEvidence } from '../types.js';

const NOT_FOUND_MARKER = '<<NOT_FOUND>>';
/** The troubleshooting guide for an offline machine, searched in code when Support reports one. */
export const OFFLINE_GUIDE_QUERY = 'maquininha offline ou sem internet: como reiniciar e reconectar a máquina de cartão';

/** Message as the agent sees it: unchanged for a fresh, self-contained message (v1 behaviour). */
export function withConversation(ctx: AgentContext): string {
  if (!ctx.history && ctx.query === ctx.message) return ctx.message;
  const standalone = ctx.query !== ctx.message ? `
<standalone_question>
${ctx.query}
</standalone_question>` : '';
  return `${ctx.history ? `${ctx.history}
` : ''}<merchant_message>
${ctx.message}
</merchant_message>${standalone}`;
}

export interface KnowledgeAgentOptions {
  model: string;
  webSearchMaxUses: number;
  /** Client-side search for providers without server-side search (default: DuckDuckGo HTML). */
  webSearch?: WebSearch;
  maxIterations: number;
  now?: () => Date;
}

interface Prefetched {
  content: string;
  sources: Source[];
  evidence: ToolEvidence;
}

/** Knowledge Agent: RAG over Getnet content (search_knowledge_base) + web search for live data. */
export class KnowledgeAgent implements Agent {
  readonly name = 'knowledge' as const;

  constructor(
    private readonly llm: LLMClient,
    private readonly knowledgeBaseTool: AgentTool,
    private readonly options: KnowledgeAgentOptions,
  ) {}

  async run(ctx: AgentContext): Promise<AgentResult> {
    const now = this.options.now?.() ?? new Date();
    const previous = ctx.previous.filter((p) => p.answer.trim());
    // A structured account signal with a known guide is searched in code: given an offline machine,
    // the 8B searched for "máquina de cartão online" and then answered that it found nothing.
    const guide = ctx.previous.some(reportsOfflineTerminal) ? await this.search(OFFLINE_GUIDE_QUERY) : null;
    const excerpts = guide && !guide.evidence.isError ? `\n\n<knowledge_base_excerpts query="${OFFLINE_GUIDE_QUERY}">\n${guide.content}\n</knowledge_base_excerpts>` : '';

    // Providers without server-side search (Ollama) get a client-side tool instead (Brave with a key, DuckDuckGo HTML without).
    const serverSearch = this.llm.capabilities.serverWebSearch;
    const budget = this.options.webSearchMaxUses;
    const webTool = !serverSearch && budget > 0 ? createWebSearchTool(this.options.webSearch, budget) : null;
    // A live-data question (Router flag or deterministic detector): the web search runs in code with
    // the merchant's question, so the answer never depends on the 8B picking the right tool — asked for
    // the euro rate inside a conversation, it searched the knowledge base and then invented a value.
    // The model keeps the rest of the budget to refine the query and never sees the knowledge base tool.
    const liveData = ctx.liveData === true && budget > 0;
    const live = liveData && webTool ? await this.call(webTool, 'web_search', ctx.query) : null;
    const liveBlocked = live !== null && live.evidence.isError;
    const webResults = live && !liveBlocked ? `\n\n<web_search_results query="${ctx.query}">\n${live.content}\n</web_search_results>` : '';
    const userMessage = `${previous.length
      ? `${withConversation(ctx)}\n\n<account_findings agent="support">\n${previous.map((p) => p.answer).join('\n\n')}\n</account_findings>${excerpts}`
      : withConversation(ctx)}${webResults}`;

    const run = (webSearchAvailable: boolean) =>
      runToolLoop({
        llm: this.llm,
        model: this.options.model,
        system: knowledgePrompt({ today: localDate(now), language: ctx.language, hasPreviousContext: previous.length > 0, webSearchAvailable, liveData: webResults !== '' }),
        userMessage,
        tools: liveData ? (webSearchAvailable && webTool ? [webTool] : []) : [this.knowledgeBaseTool, ...(webSearchAvailable && webTool ? [webTool] : [])],
        ...(webSearchAvailable && serverSearch ? { webSearch: { maxUses: budget } } : {}),
        maxIterations: this.options.maxIterations,
        maxTokens: 1200,
      });

    let result;
    try {
      result = await run(budget > 0 && !liveBlocked);
    } catch (err) {
      // If web search is not enabled for the organisation, RAG must keep working (plan §11).
      if (!/web[_ ]search/i.test((err as Error).message)) throw err;
      result = await run(false);
    }

    const notFound = result.text.includes(NOT_FOUND_MARKER);
    const answer = result.text.replaceAll(NOT_FOUND_MARKER, '').trim();
    const prefetched = [guide, live].filter((p): p is Prefetched => p !== null);
    return {
      agent: this.name,
      answer,
      sources: notFound ? result.sources : dedupeSources([...prefetched.flatMap((p) => p.sources), ...result.sources]),
      toolsUsed: [...new Set([...prefetched.map((p) => p.evidence.name), ...result.toolsUsed])],
      usage: result.usage,
      evidence: [...prefetched.map((p) => p.evidence), ...result.evidence],
      notFound,
      ...(result.hitIterationLimit || !answer ? { handoff: { reason: 'knowledge_agent_incomplete' } } : {}),
    };
  }

  private search(query: string): Promise<Prefetched> {
    return this.call(this.knowledgeBaseTool, 'search_knowledge_base', query);
  }

  /** Runs a tool in code (outside the model loop) and records it as evidence like any other call. */
  private async call(tool: AgentTool, name: string, query: string): Promise<Prefetched> {
    const started = performance.now();
    const out = await tool.execute({ query }).catch((err: Error) => ({ content: `Tool failed: ${err.message}`, isError: true, sources: [] }));
    return {
      content: out.content,
      sources: out.sources ?? [],
      evidence: { name, input: { query }, output: maskPII(out.content).text.slice(0, 4000), isError: out.isError === true, durationMs: Math.round(performance.now() - started) },
    };
  }
}
