import { z } from 'zod';
import { defineTool } from '../agents/defineTool.js';
import type { AgentTool } from '../agents/toolLoop.js';
import type { Embedder } from './embedder.js';
import type { VectorStore } from './vectorStore.js';
import type { SearchHit } from './types.js';

export interface RetrieverOptions {
  topK: number;
  minScore?: number;
  /** Max chunks from the same page, so one long page doesn't crowd out the others. */
  maxPerUrl: number;
}

export class Retriever {
  private readonly minScore: number;

  constructor(
    private readonly store: VectorStore,
    private readonly embedder: Embedder,
    private readonly options: RetrieverOptions = { topK: 6, maxPerUrl: 2 },
  ) {
    if (store.size > 0 && store.embedderId !== embedder.id) {
      throw new Error(`Index was built with "${store.embedderId}" but the configured embedder is "${embedder.id}". Re-run ingestion or change EMBEDDER.`);
    }
    this.minScore = options.minScore ?? embedder.defaultMinScore;
  }

  get isEmpty() {
    return this.store.size === 0;
  }

  async search(query: string): Promise<SearchHit[]> {
    if (this.isEmpty) return [];
    const vector = await this.embedder.embedQuery(query);
    const candidates = this.store.search(vector, this.options.topK * 4).filter((h) => h.score >= this.minScore);
    const perUrl = new Map<string, number>();
    const hits: SearchHit[] = [];
    for (const hit of candidates) {
      const count = perUrl.get(hit.chunk.url) ?? 0;
      if (count >= this.options.maxPerUrl) continue;
      perUrl.set(hit.chunk.url, count + 1);
      hits.push(hit);
      if (hits.length === this.options.topK) break;
    }
    return hits;
  }
}

/** Exposes retrieval to agents as a tool so the model can reformulate and search again. */
export function createKnowledgeBaseTool(retriever: Retriever): AgentTool {
  return defineTool(
    'search_knowledge_base',
    "Search the Getnet knowledge base (official Getnet pages, Santander's Getnet pages and the internal support playbook). Content is mostly in Brazilian Portuguese: write the query in Portuguese with Getnet product terms (e.g. 'antecipação de recebíveis', 'link de pagamento WhatsApp', 'Get Smart'). Returns numbered excerpts with their source URL.",
    z.object({ query: z.string().min(2).max(300) }),
    async ({ query }) => {
      if (retriever.isEmpty) return { content: 'The knowledge base is empty (ingestion has not been run).', isError: true };
      const hits = await retriever.search(query);
      if (hits.length === 0) return { content: 'No relevant excerpts found for this query.' };
      const content = hits
        .map((h, i) => `[${i + 1}] ${h.chunk.title} — ${h.chunk.url} (score ${h.score.toFixed(2)})\n${h.chunk.text}`)
        .join('\n\n---\n\n');
      return { content, sources: hits.map((h) => ({ title: h.chunk.title, url: h.chunk.url })) };
    },
  );
}
