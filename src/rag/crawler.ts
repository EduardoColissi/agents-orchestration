import * as cheerio from 'cheerio';
import type { SourceDocument } from './types.js';

export interface CrawlConfig {
  seeds: string[];
  allowedHosts: string[];
  keywords: string[];
  maxDepth: number;
  maxPages: number;
  requestDelayMs: number;
}

const USER_AGENT = 'GetnetSupportRAGBot/0.1 (technical challenge; polite crawler)';
const NOISE_SELECTORS = 'script, style, noscript, svg, iframe, form, nav, header, footer, aside, [role="navigation"], [aria-hidden="true"], .cookie, #cookie, .menu, .breadcrumb';
const CONTENT_SELECTORS = 'h1, h2, h3, h4, p, li, td, th, dt, dd, summary, blockquote';

/** Extracts readable text from HTML, turning headings into "## " lines (consumed by the chunker). */
export function extractDocument(url: string, html: string): SourceDocument & { links: string[] } {
  const $ = cheerio.load(html);
  const title = ($('meta[property="og:title"]').attr('content') ?? $('title').text() ?? $('h1').first().text()).trim() || url;
  const links = $('a[href]')
    .map((_, a) => $(a).attr('href'))
    .get()
    .map((href) => safeUrl(href, url))
    .filter((u): u is string => u !== null);

  $(NOISE_SELECTORS).remove();
  const root = $('main').length ? $('main') : $('body');
  const lines: string[] = [];
  const seen = new Set<string>();
  root.find(CONTENT_SELECTORS).each((_, el) => {
    // Skip containers whose text is already captured by a nested content element.
    if ($(el).find(CONTENT_SELECTORS).length > 0 && el.tagName !== 'li') return;
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length < 3 || seen.has(text)) return; // drop duplicated menus/footers
    seen.add(text);
    lines.push(/^h[1-4]$/.test(el.tagName) ? `## ${text}` : text);
  });
  return { url, title, text: lines.join('\n'), links };
}

function safeUrl(href: string | undefined, base: string): string | null {
  if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return null;
  try {
    const u = new URL(href, base);
    u.hash = '';
    // Keep WordPress page ids, drop tracking parameters.
    const pageId = u.searchParams.get('page_id');
    u.search = pageId ? `?page_id=${pageId}` : '';
    return u.toString();
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url: string): Promise<{ status: number; body: string; contentType: string }> {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml', 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: await res.text(), contentType: res.headers.get('content-type') ?? '' };
}

/** Minimal robots.txt support: honours `Disallow` rules for `User-agent: *`. */
async function loadRobots(host: string): Promise<string[]> {
  try {
    const { status, body } = await fetchText(`https://${host}/robots.txt`);
    if (status !== 200) return [];
    const rules: string[] = [];
    let applies = false;
    for (const raw of body.split('\n')) {
      const line = raw.split('#')[0]!.trim();
      const [key, ...rest] = line.split(':');
      const value = rest.join(':').trim();
      if (/^user-agent$/i.test(key ?? '')) applies = value === '*';
      else if (applies && /^disallow$/i.test(key ?? '') && value) rules.push(value);
    }
    return rules;
  } catch {
    return [];
  }
}

export interface CrawlReport {
  documents: SourceDocument[];
  failures: Array<{ url: string; reason: string }>;
}

/** Breadth-first, same-host crawl limited by depth, page count and URL keywords. */
export async function crawl(config: CrawlConfig, log: (msg: string) => void = console.log): Promise<CrawlReport> {
  const queue = config.seeds.map((url) => ({ url, depth: 0 }));
  const visited = new Set<string>();
  const robots = new Map<string, string[]>();
  const documents: SourceDocument[] = [];
  const failures: CrawlReport['failures'] = [];

  while (queue.length > 0 && documents.length < config.maxPages) {
    const { url, depth } = queue.shift()!;
    const normalized = url.replace(/\/$/, '');
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    const { host, pathname } = new URL(url);
    if (!config.allowedHosts.includes(host)) continue;
    if (!robots.has(host)) robots.set(host, await loadRobots(host));
    if (robots.get(host)!.some((rule) => pathname.startsWith(rule))) {
      failures.push({ url, reason: 'disallowed by robots.txt' });
      continue;
    }

    try {
      const { status, body, contentType } = await fetchText(url);
      if (status !== 200 || !contentType.includes('html')) {
        failures.push({ url, reason: `HTTP ${status} ${contentType}` });
        continue;
      }
      const doc = extractDocument(url, body);
      if (doc.text.length < 200) {
        failures.push({ url, reason: 'too little text (JS-rendered page?)' });
      } else {
        documents.push({ url: doc.url, title: doc.title, text: doc.text });
        log(`  ✓ ${url} (${doc.text.length} chars)`);
      }
      if (depth < config.maxDepth) {
        for (const link of doc.links) {
          const l = new URL(link);
          const path = decodeURIComponent(l.pathname).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
          if (!config.allowedHosts.includes(l.host)) continue;
          if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4)$/.test(path)) continue;
          if (!config.keywords.some((k) => path.includes(k))) continue;
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    } catch (err) {
      failures.push({ url, reason: describeError(err) });
    }
    await sleep(config.requestDelayMs);
  }
  return { documents, failures };
}

function describeError(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  return e.cause ? `${e.message} (${e.cause.code ?? e.cause.message})` : e.message;
}
