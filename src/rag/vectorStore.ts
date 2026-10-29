import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cosine } from './embedder.js';
import type { IndexedChunk, SearchHit } from './types.js';

/** Storage contract; swap for LanceDB/Chroma/pgvector by implementing it. */
export interface VectorStore {
  readonly size: number;
  readonly embedderId: string | null;
  add(chunks: IndexedChunk[]): void;
  search(vector: number[], topK: number): SearchHit[];
}

export interface IndexFile {
  version: 1;
  embedder: string;
  createdAt: string;
  sources: string[];
  chunks: IndexedChunk[];
}

/**
 * Brute-force cosine search over an in-memory array. For a few hundred chunks this is
 * sub-millisecond and needs no extra service; persisted as a JSON snapshot (FR9).
 */
export class InMemoryVectorStore implements VectorStore {
  private chunks: IndexedChunk[] = [];

  constructor(public embedderId: string | null = null) {}

  get size() {
    return this.chunks.length;
  }

  add(chunks: IndexedChunk[]) {
    this.chunks.push(...chunks);
  }

  search(vector: number[], topK: number): SearchHit[] {
    return this.chunks
      .map(({ vector: v, ...chunk }) => ({ chunk, score: cosine(vector, v) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  save(path: string, sources: string[]) {
    if (!this.embedderId) throw new Error('Cannot save an index without an embedder id');
    const file: IndexFile = {
      version: 1,
      embedder: this.embedderId,
      createdAt: new Date().toISOString(),
      sources,
      chunks: this.chunks.map((c) => ({ ...c, vector: c.vector.map((x) => Math.round(x * 1e5) / 1e5) })),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(file));
  }

  static load(path: string): InMemoryVectorStore {
    if (!existsSync(path)) return new InMemoryVectorStore();
    const file = JSON.parse(readFileSync(path, 'utf8')) as IndexFile;
    if (file.version !== 1) throw new Error(`Unsupported index version ${String(file.version)}`);
    const store = new InMemoryVectorStore(file.embedder);
    store.add(file.chunks);
    return store;
  }
}
