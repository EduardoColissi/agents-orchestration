import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkDocument } from '../../src/rag/chunker.js';
import { extractDocument } from '../../src/rag/crawler.js';
import { HashingEmbedder } from '../../src/rag/embedder.js';
import { InMemoryVectorStore } from '../../src/rag/vectorStore.js';
import { Retriever, createKnowledgeBaseTool } from '../../src/rag/retriever.js';
import { buildIndex, embedChunks, loadLocalDocuments, replaceLocalChunks } from '../../src/rag/ingest.js';

const html = `<!doctype html><html><head><title>Link de Pagamento | Getnet</title></head><body>
<nav><a href="/pix/">Pix</a> Menu repetido</nav>
<main>
  <h1>Link de pagamento</h1>
  <p>Com o link de pagamento você vende pelo WhatsApp, redes sociais ou e-mail, sem maquininha.</p>
  <h2>Formas de pagamento</h2>
  <ul><li>Cartão de crédito à vista ou parcelado</li><li>Cartão de débito e Pix</li></ul>
  <a href="/crediario/?utm_source=x#top">Crediário</a>
</main>
<footer>Rodapé com links</footer></body></html>`;

describe('extractDocument', () => {
  it('keeps content, turns headings into markers and drops navigation/footer', () => {
    const doc = extractDocument('https://site.getnet.com.br/link-de-pagamento/', html);
    expect(doc.title).toBe('Link de Pagamento | Getnet');
    expect(doc.text).toContain('## Link de pagamento');
    expect(doc.text).toContain('WhatsApp');
    expect(doc.text).not.toContain('Rodapé');
    expect(doc.text).not.toContain('Menu repetido');
    expect(doc.links).toContain('https://site.getnet.com.br/crediario/');
  });
});

describe('chunkDocument', () => {
  it('splits by heading, keeps heading metadata and respects maxChars', () => {
    const text = ['## Pix', 'a'.repeat(150), '## Antecipação', ...Array.from({ length: 30 }, (_, i) => `Parágrafo ${i} sobre antecipação de recebíveis da Getnet.`)].join('\n');
    const chunks = chunkDocument({ url: 'u', title: 't', text }, { maxChars: 400, overlapChars: 80, minChars: 50 });
    expect(chunks[0]!.heading).toBe('Pix');
    const antecipacao = chunks.filter((c) => c.heading === 'Antecipação');
    expect(antecipacao.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 400 + 'Antecipação\n'.length)).toBe(true);
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  });
});

describe('retrieval', () => {
  const docs = [
    { url: 'https://g/link', title: 'Link de pagamento', text: '## Link\nVenda pelo WhatsApp com o link de pagamento Get Pay, crédito, débito e Pix. Basta criar o link no app e enviar ao cliente.' },
    { url: 'https://g/antecipacao', title: 'Antecipação', text: '## Antecipação\nAntecipação de recebíveis: receba suas vendas no crédito em até 2 dias úteis, com taxa conforme o plano contratado.' },
    { url: 'https://g/maquininhas', title: 'Maquininhas', text: '## Get Smart\nA Get Smart tem tela touch, Android e app de gestão. A Get Clássica imprime comprovante e tem chip próprio.' },
  ];

  it('returns the most relevant chunk first and its source', async () => {
    const embedder = new HashingEmbedder();
    const retriever = new Retriever(await buildIndex(docs, embedder), embedder, { topK: 2, maxPerUrl: 2 });
    const tool = createKnowledgeBaseTool(retriever);
    const out = await tool.execute({ query: 'vender pelo WhatsApp com link de pagamento' });
    expect(out.sources?.[0]?.url).toBe('https://g/link');
    expect(out.content).toContain('[1] Link de pagamento');
  });

  it('persists and reloads the index snapshot', async () => {
    const embedder = new HashingEmbedder();
    const store = await buildIndex(docs, embedder);
    const path = join(mkdtempSync(join(tmpdir(), 'idx-')), 'index.json');
    store.save(path, docs.map((d) => d.url));
    const loaded = InMemoryVectorStore.load(path);
    expect(loaded.size).toBe(store.size);
    expect(loaded.embedderId).toBe(embedder.id);
  });

  it('refuses an index built with a different embedder', async () => {
    const store = await buildIndex(docs, new HashingEmbedder(512));
    expect(() => new Retriever(store, new HashingEmbedder(1024))).toThrow(/Re-run ingestion/);
  });

  it('says so when the knowledge base is empty', async () => {
    const tool = createKnowledgeBaseTool(new Retriever(new InMemoryVectorStore(), new HashingEmbedder()));
    expect((await tool.execute({ query: 'pix' })).isError).toBe(true);
  });

  it('loads internal markdown documents', () => {
    const local = loadLocalDocuments('data/knowledge');
    expect(local[0]!.url).toBe('internal://knowledge/support-playbook.md');
    expect(local[0]!.title).toMatch(/playbook/i);
  });

  it('re-embeds the internal docs into an existing index without touching the crawled pages', async () => {
    const embedder = new HashingEmbedder(512);
    const web = await embedChunks([{ url: 'https://site.getnet.com.br/pix/', title: 'Pix', text: '## Pix\nReceba vendas por Pix na hora, com QR Code na maquininha, sem custo extra e com o dinheiro direto na sua conta.' }], embedder);
    expect(web).toHaveLength(1);
    const oldLocal = { ...web[0]!, id: 'old', url: 'internal://knowledge/support-playbook.md' };
    const index = { embedder: embedder.id, sources: ['https://site.getnet.com.br/pix/', 'internal://knowledge/support-playbook.md'], chunks: [...web, oldLocal] };
    const local = await embedChunks(loadLocalDocuments('data/knowledge'), embedder);

    const merged = replaceLocalChunks(index, local, embedder.id);
    expect(merged.chunks.filter((c) => c.url.startsWith('https://'))).toEqual(web);
    expect(merged.chunks.some((c) => c.id === 'old')).toBe(false);
    expect(merged.chunks.some((c) => /Maquininha offline ou sem internet/.test(c.text))).toBe(true);
    expect(merged.sources).toEqual(['https://site.getnet.com.br/pix/', 'internal://knowledge/support-playbook.md']);
    expect(() => replaceLocalChunks(index, local, 'another-embedder')).toThrow(/full ingest/);
  });
});
