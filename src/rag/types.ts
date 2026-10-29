/** A cleaned page ready to be chunked. `text` uses "## " lines for headings. */
export interface SourceDocument {
  url: string;
  title: string;
  text: string;
}

export interface Chunk {
  id: string;
  url: string;
  title: string;
  heading: string;
  text: string;
}

export interface IndexedChunk extends Chunk {
  vector: number[];
}

export interface SearchHit {
  chunk: Chunk;
  score: number;
}
