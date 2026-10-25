import * as cheerio from 'cheerio';
import { z } from 'zod';
import { defineTool } from './defineTool.js';
import type { AgentTool } from './toolLoop.js';
import type { Source } from '../types.js';

export interface WebSearchHit extends Source {
  snippet: string;
}

/** DuckDuckGo HTML endpoint: no API key, good enough for weather/exchange-rate questions. */
export async function searchDuckDuckGo(query: string, fetchImpl: typeof fetch = fetch, limit = 5): Promise<WebSearchHit[]> {
  const res = await fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; GetnetSupportBot/0.1)', 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  return parseDuckDuckGo(await res.text(), limit);
}

export function parseDuckDuckGo(html: string, limit = 5): WebSearchHit[] {
  const $ = cheerio.load(html);
  const hits: WebSearchHit[] = [];
  $('.result').each((_, el) => {
    if (hits.length >= limit) return;
    const a = $(el).find('a.result__a').first();
    const href = a.attr('href') ?? '';
    const url = decodeRedirect(href);
    const title = a.text().trim();
    const snippet = $(el).find('.result__snippet').text().replace(/\s+/g, ' ').trim();
    if (url && title) hits.push({ url, title, snippet });
  });
  return hits;
}

function decodeRedirect(href: string): string {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    return u.searchParams.get('uddg') ?? u.toString();
  } catch {
    return '';
  }
}

/**
 * Client-side replacement for Anthropic's server web search, used when the LLM provider
 * has no native search (Ollama). Same tool name, so `tools_used` stays comparable.
 */
export function createWebSearchTool(search: (q: string) => Promise<WebSearchHit[]> = searchDuckDuckGo, maxUses = 2): AgentTool {
  let uses = 0;
  return defineTool(
    'web_search',
    'Search the public web for current, general-purpose information (weather, exchange rates, news). Not for Getnet products. Returns titles, URLs and snippets.',
    z.object({ query: z.string().min(2).max(200) }),
    async ({ query }) => {
      if (uses >= maxUses) return { content: 'Web search budget for this request is exhausted; answer with what you have.', isError: true };
      uses++;
      try {
        const hits = await search(query);
        if (hits.length === 0) return { content: 'No results.' };
        return {
          content: hits.map((h, i) => `[${i + 1}] ${h.title} — ${h.url}\n${h.snippet}`).join('\n\n'),
          sources: hits.slice(0, 3).map(({ title, url }) => ({ title, url })),
        };
      } catch (err) {
        return { content: `Web search failed: ${(err as Error).message}`, isError: true };
      }
    },
  );
}
