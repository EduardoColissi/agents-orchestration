import { createHash } from 'node:crypto';
import type { Chunk, SourceDocument } from './types.js';

export interface ChunkOptions {
  /** ~4 chars per token → 1800 chars ≈ 450 tokens. */
  maxChars: number;
  /** Tail of the previous chunk repeated at the start of the next one. */
  overlapChars: number;
  /** Chunks smaller than this are merged or dropped (navigation crumbs, buttons). */
  minChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxChars: 1800, overlapChars: 300, minChars: 80 };

/**
 * Heading-aware chunker: splits a document into sections by "## " headings, then packs
 * paragraphs into chunks up to `maxChars`, keeping the section heading as metadata and
 * prefixing it to the text so each chunk is self-explanatory when retrieved alone.
 */
export function chunkDocument(doc: SourceDocument, options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of splitSections(doc.text)) {
    const paragraphs = section.body.flatMap((p) => splitLong(p, options.maxChars));
    let current = '';
    const flush = () => {
      const body = current.trim();
      if (body.length >= options.minChars) chunks.push(makeChunk(doc, section.heading, body));
      current = body.length > options.overlapChars ? body.slice(-options.overlapChars).replace(/^\S*\s/, '') : '';
    };
    for (const p of paragraphs) {
      if (current.length + p.length + 1 > options.maxChars && current.trim().length > 0) flush();
      current += (current ? '\n' : '') + p;
    }
    // Avoid emitting a chunk that only repeats the overlap of the previous one.
    if (current.trim().length >= options.minChars && !chunks.at(-1)?.text.endsWith(current.trim())) {
      chunks.push(makeChunk(doc, section.heading, current.trim()));
    }
  }
  return chunks;
}

interface Section {
  heading: string;
  body: string[];
}

function splitSections(text: string): Section[] {
  const sections: Section[] = [{ heading: '', body: [] }];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) sections.push({ heading: heading[1]!.trim(), body: [] });
    else sections.at(-1)!.body.push(line);
  }
  return sections.filter((s) => s.body.length > 0);
}

/** Splits an oversized paragraph on sentence boundaries. */
function splitLong(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  const sentences = paragraph.match(/[^.!?]+[.!?]*\s*/g) ?? [paragraph];
  const parts: string[] = [];
  let current = '';
  for (const s of sentences) {
    if (current.length + s.length > maxChars && current) {
      parts.push(current.trim());
      current = '';
    }
    current += s.length > maxChars ? s.slice(0, maxChars) : s;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function makeChunk(doc: SourceDocument, heading: string, body: string): Chunk {
  const text = heading ? `${heading}\n${body}` : body;
  const id = createHash('sha1').update(`${doc.url}|${text}`).digest('hex').slice(0, 16);
  return { id, url: doc.url, title: doc.title, heading, text };
}
