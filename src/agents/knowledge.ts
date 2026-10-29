import type { LLMClient } from '../llm/client.js';
import type { Agent, AgentContext, AgentResult } from '../types.js';
import { localDate } from '../support/dates.js';
import { knowledgePrompt } from './prompts.js';
import { runToolLoop, type AgentTool } from './toolLoop.js';
import { createWebSearchTool } from './webSearchTool.js';

const NOT_FOUND_MARKER = '<<NOT_FOUND>>';

export interface KnowledgeAgentOptions {
  model: string;
  webSearchMaxUses: number;
  maxIterations: number;
  now?: () => Date;
}

/** Knowledge Agent: RAG over Getnet content (search_knowledge_base) + server-side web search. */
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
    const userMessage = previous.length
      ? `${ctx.message}\n\n<account_findings agent="support">\n${previous.map((p) => p.answer).join('\n\n')}\n</account_findings>`
      : ctx.message;

    // Providers without server-side search (Ollama) get a local DuckDuckGo tool instead.
    const serverSearch = this.llm.capabilities.serverWebSearch;
    const run = (webSearchAvailable: boolean) =>
      runToolLoop({
        llm: this.llm,
        model: this.options.model,
        system: knowledgePrompt({ today: localDate(now), language: ctx.language, hasPreviousContext: previous.length > 0, webSearchAvailable }),
        userMessage,
        tools: [this.knowledgeBaseTool, ...(webSearchAvailable && !serverSearch ? [createWebSearchTool(undefined, this.options.webSearchMaxUses)] : [])],
        ...(webSearchAvailable && serverSearch ? { webSearch: { maxUses: this.options.webSearchMaxUses } } : {}),
        maxIterations: this.options.maxIterations,
        maxTokens: 1200,
      });

    let result;
    try {
      result = await run(this.options.webSearchMaxUses > 0);
    } catch (err) {
      // If web search is not enabled for the organisation, RAG must keep working (plan §11).
      if (!/web[_ ]search/i.test((err as Error).message)) throw err;
      result = await run(false);
    }

    const notFound = result.text.includes(NOT_FOUND_MARKER);
    const answer = result.text.replaceAll(NOT_FOUND_MARKER, '').trim();
    return {
      agent: this.name,
      answer,
      sources: result.sources,
      toolsUsed: result.toolsUsed,
      usage: result.usage,
      evidence: result.evidence,
      notFound,
      ...(result.hitIterationLimit || !answer ? { handoff: { reason: 'knowledge_agent_incomplete' } } : {}),
    };
  }
}
