/**
 * Ingestion CLI (`npm run ingest`): crawl → clean → chunk → embed → save index snapshot.
 * Re-runnable and independent from the API (FR9). `npm run ingest -- --local-only` re-embeds only
 * the internal docs (data/knowledge) into the existing index, keeping the crawled pages as they are.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { chunkDocument } from './chunker.js';
import { crawl } from './crawler.js';
import { createEmbedder, type Embedder } from './embedder.js';
import { InMemoryVectorStore, type IndexFile } from './vectorStore.js';
import type { IndexedChunk, SourceDocument } from './types.js';

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

export async function embedChunks(documents: SourceDocument[], embedder: Embedder): Promise<IndexedChunk[]> {
  const chunks = documents.flatMap((d) => chunkDocument(d));
  const unique = [...new Map(chunks.map((c) => [c.id, c])).values()];
  const vectors = await embedder.embedDocuments(unique.map((c) => c.text));
  return unique.map((c, i) => ({ ...c, vector: vectors[i]! }));
}

export async function buildIndex(documents: SourceDocument[], embedder: Embedder): Promise<InMemoryVectorStore> {
  const store = new InMemoryVectorStore(embedder.id);
  store.add(await embedChunks(documents, embedder));
  return store;
}

const LOCAL_PREFIX = 'internal://';

/** The crawled chunks of an existing index plus freshly embedded internal docs (which replace the old ones). */
export function replaceLocalChunks(index: Pick<IndexFile, 'embedder' | 'sources' | 'chunks'>, local: IndexedChunk[], embedderId: string): { chunks: IndexedChunk[]; sources: string[] } {
  if (index.embedder !== embedderId) throw new Error(`The index was built with ${index.embedder}, not ${embedderId}: run a full ingest instead.`);
  const isLocal = (url: string) => url.startsWith(LOCAL_PREFIX);
  return {
    chunks: [...index.chunks.filter((c) => !isLocal(c.url)), ...local],
    sources: [...index.sources.filter((u) => !isLocal(u)), ...new Set(local.map((c) => c.url))],
  };
}

async function main() {
  const config = loadConfig();
  const sources = SourcesSchema.parse(JSON.parse(readFileSync(config.SOURCES_PATH, 'utf8')));
  const started = Date.now();

  if (process.argv.includes('--local-only')) {
    const embedder = createEmbedder(config.EMBEDDER);
    const localDocs = sources.localKnowledgeDir ? loadLocalDocuments(sources.localKnowledgeDir) : [];
    const index = JSON.parse(readFileSync(config.INDEX_PATH, 'utf8')) as IndexFile;
    const merged = replaceLocalChunks(index, await embedChunks(localDocs, embedder), embedder.id);
    const store = new InMemoryVectorStore(embedder.id);
    store.add(merged.chunks);
    store.save(config.INDEX_PATH, merged.sources);
    console.log(`Index saved to ${config.INDEX_PATH}: ${localDocs.length} local docs re-embedded → ${store.size} chunks in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return;
  }

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
