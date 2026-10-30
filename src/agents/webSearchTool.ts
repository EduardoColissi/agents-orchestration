import * as cheerio from 'cheerio';
import { z } from 'zod';
import { defineTool } from './defineTool.js';
import type { AgentTool } from './toolLoop.js';
import type { Source } from '../types.js';

export interface WebSearchHit extends Source {
  snippet: string;
}

export type WebSearch = (query: string) => Promise<WebSearchHit[]>;

/** DuckDuckGo HTML endpoint: no API key, good enough for weather/exchange-rate questions. */
export async function searchDuckDuckGo(query: string, fetchImpl: typeof fetch = fetch, limit = 5): Promise<WebSearchHit[]> {
  const res = await fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; GetnetSupportBot/0.1)', 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const html = await res.text();
  // DuckDuckGo answers 202 with a bot challenge when it blocks a network: that is "unavailable", not "no results".
  if (res.status === 202 || /anomaly-modal|challenge-form/i.test(html)) throw new Error('the search provider blocked this request (bot challenge); live web data is unavailable');
  return parseDuckDuckGo(html, limit);
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

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const BraveResponse = z.object({
  web: z.object({ results: z.array(z.object({ title: z.string(), url: z.string(), description: z.string().optional() })) }).optional(),
});

/**
 * Brave Search API (api-dashboard.search.brave.com, free plan): a provider that allows programmatic
 * access, unlike DuckDuckGo's HTML page. Used when BRAVE_SEARCH_API_KEY is set.
 */
export async function searchBrave(query: string, apiKey: string, fetchImpl: typeof fetch = fetch, limit = 5): Promise<WebSearchHit[]> {
  const params = new URLSearchParams({ q: query, count: String(limit), country: 'BR', text_decorations: 'false' });
  const res = await fetchImpl(`${BRAVE_SEARCH_URL}?${params}`, {
    headers: { accept: 'application/json', 'x-subscription-token': apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error(`Brave Search rejected the API key (HTTP ${res.status})`);
  if (res.status === 429) throw new Error('Brave Search rate limit reached; live web data is unavailable');
  if (!res.ok) throw new Error(`Brave Search ${res.status}`);
  const parsed = BraveResponse.safeParse(await res.json());
  if (!parsed.success) throw new Error('Brave Search returned an unexpected payload');
  return (parsed.data.web?.results ?? []).slice(0, limit).map((r) => ({ title: plainText(r.title), url: r.url, snippet: plainText(r.description ?? '') }));
}

/** Brave may mark query terms with <strong> and escapes entities; the agent gets plain text. */
function plainText(text: string): string {
  return cheerio.load(text).text().replace(/\s+/g, ' ').trim();
}

/** The search behind `web_search` on providers without server-side search: Brave with a key, DuckDuckGo HTML without one. */
export function selectWebSearch(braveApiKey: string | undefined): { name: 'brave' | 'duckduckgo'; search: WebSearch } {
  return braveApiKey ? { name: 'brave', search: (q) => searchBrave(q, braveApiKey) } : { name: 'duckduckgo', search: searchDuckDuckGo };
}

/**
 * Client-side replacement for Anthropic's server web search, used when the LLM provider
 * has no native search (Ollama). Same tool name, so `tools_used` stays comparable.
 */
export function createWebSearchTool(search: WebSearch = searchDuckDuckGo, maxUses = 2): AgentTool {
  let uses = 0;
  return defineTool(
    'web_search',
    'Search the public web for current, general-purpose information (weather, exchange rates, news). Not for Getnet products. The merchant is in Brazil: ask for exchange rates against the Brazilian real (BRL). Returns titles, URLs and snippets.',
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
