/**
 * Embedding contract. Documents and queries are embedded separately because asymmetric
 * models like e5 need different prefixes for each.
 */
export interface Embedder {
  /** Stored in the index; a query must be embedded with the same embedder that built it. */
  readonly id: string;
  /** Similarity below which a chunk is considered irrelevant for this model. */
  readonly defaultMinScore: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

/**
 * Local multilingual sentence embeddings (intfloat/multilingual-e5-small, ONNX via
 * transformers.js). No API key; Portuguese pages match English questions (spec A2).
 */
export class E5Embedder implements Embedder {
  readonly id = 'Xenova/multilingual-e5-small';
  readonly defaultMinScore = 0.78;
  private extractor: Promise<(texts: string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>> | null = null;

  constructor(private readonly cacheDir = process.env.MODEL_CACHE_DIR ?? '.models') {}

  private load() {
    this.extractor ??= (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = this.cacheDir;
      const extractor = await pipeline('feature-extraction', this.id, { dtype: 'q8' });
      return extractor as unknown as (texts: string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>;
    })();
    return this.extractor;
  }

  private async embed(texts: string[]): Promise<number[][]> {
    const extractor = await this.load();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const tensor = await extractor(texts.slice(i, i + 16), { pooling: 'mean', normalize: true });
      out.push(...tensor.tolist());
    }
    return out;
  }

  embedDocuments(texts: string[]) {
    return this.embed(texts.map((t) => `passage: ${t}`));
  }

  async embedQuery(text: string) {
    return (await this.embed([`query: ${text}`]))[0]!;
  }
}

const STOPWORDS = new Set(
  ('a o e de da do das dos em no na nos nas um uma para por com que se ao aos the of and to in on for is are be can i my your you how what with it this that do does '
    + 'meu minha sua seu como qual quais ou mais the an as at by from').split(' '),
);

/**
 * Dependency-free lexical embedder (feature hashing of unigrams + bigrams, accent-folded).
 * Used in tests and as an offline fallback (`EMBEDDER=hashing`). Unlike e5 it does not
 * bridge languages, so the Knowledge agent also searches with Portuguese terms.
 */
export class HashingEmbedder implements Embedder {
  readonly id: string;
  readonly defaultMinScore = 0.12;

  constructor(private readonly dim = 1024) {
    this.id = `hashing-${dim}`;
  }

  async embedDocuments(texts: string[]) {
    return texts.map((t) => this.vector(t));
  }

  async embedQuery(text: string) {
    return this.vector(text);
  }

  private vector(text: string): number[] {
    const tokens = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t));
    const v = new Array<number>(this.dim).fill(0);
    const features = [...tokens, ...tokens.slice(1).map((t, i) => `${tokens[i]}_${t}`)];
    for (const f of features) {
      const h = fnv1a(f);
      v[h % this.dim]! += (h & 0x80000000) === 0 ? 1 : -1;
    }
    return normalize(v);
  }
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createEmbedder(kind: 'e5' | 'hashing'): Embedder {
  return kind === 'e5' ? new E5Embedder() : new HashingEmbedder();
}
