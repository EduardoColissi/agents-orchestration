/**
 * Ingestion CLI (`npm run ingest`): crawl → clean → chunk → embed → save index snapshot.
 * Re-runnable and independent from the API (FR9).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { chunkDocument } from './chunker.js';
import { crawl } from './crawler.js';
import { createEmbedder, type Embedder } from './embedder.js';
import { InMemoryVectorStore } from './vectorStore.js';
import type { SourceDocument } from './types.js';

const SourcesSchema = z.object({
  seeds: z.array(z.url()).min(1),
  allowedHosts: z.array(z.string()).min(1),
  keywords: z.array(z.string()),
  maxDepth: z.number().int().min(0).max(4),
  maxPages: z.number().int().min(1).max(500),
  requestDelayMs: z.number().int().min(0),
  localKnowledgeDir: z.string().optional(),
});

/** Markdown files in data/knowledge are internal docs (e.g. the support playbook). */
export function loadLocalDocuments(dir: string): SourceDocument[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((file) => {
      const text = readFileSync(join(dir, file), 'utf8');
      const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? file;
      return { url: `internal://knowledge/${file}`, title, text: text.replace(/^#\s+.+$/m, '') };
    });
}

export async function buildIndex(documents: SourceDocument[], embedder: Embedder): Promise<InMemoryVectorStore> {
  const chunks = documents.flatMap((d) => chunkDocument(d));
  const unique = [...new Map(chunks.map((c) => [c.id, c])).values()];
  const vectors = await embedder.embedDocuments(unique.map((c) => c.text));
  const store = new InMemoryVectorStore(embedder.id);
  store.add(unique.map((c, i) => ({ ...c, vector: vectors[i]! })));
  return store;
}

async function main() {
  const config = loadConfig();
  const sources = SourcesSchema.parse(JSON.parse(readFileSync(config.SOURCES_PATH, 'utf8')));
  const started = Date.now();

  console.log(`Crawling ${sources.seeds.length} seeds (depth ≤ ${sources.maxDepth}, ≤ ${sources.maxPages} pages)…`);
  const { documents: webDocs, failures } = await crawl(sources);
  const localDocs = sources.localKnowledgeDir ? loadLocalDocuments(sources.localKnowledgeDir) : [];
  for (const f of failures) console.warn(`  ✗ ${f.url}: ${f.reason}`);
  if (webDocs.length === 0) console.warn('WARNING: no web page could be ingested — the index will only contain local documents.');

  const documents = [...webDocs, ...localDocs];
  console.log(`Embedding ${documents.length} documents with ${config.EMBEDDER}…`);
  const store = await buildIndex(documents, createEmbedder(config.EMBEDDER));
  store.save(config.INDEX_PATH, documents.map((d) => d.url));

  console.log(`Index saved to ${config.INDEX_PATH}: ${webDocs.length} web pages + ${localDocs.length} local docs → ${store.size} chunks in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
