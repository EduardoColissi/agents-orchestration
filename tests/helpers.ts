import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { loadConfig } from '../src/config.js';
import { buildDependencies } from '../src/container.js';
import { buildServer } from '../src/server.js';
import { FakeLLM, type FakeReply } from '../src/llm/fake.js';
import type { LLMRequest } from '../src/llm/client.js';
import { MockCustomerRepository } from '../src/support/mockRepository.js';
import { HashingEmbedder } from '../src/rag/embedder.js';
import { buildIndex } from '../src/rag/ingest.js';
import type { RouteDecision } from '../src/agents/router.js';
import { JwtService, type Role } from '../src/auth/jwt.js';
import type { WebSearch } from '../src/agents/webSearchTool.js';

/** The client-side web search of the test app: a fixed exchange-rate page, no network. */
export const FAKE_WEB_SEARCH: WebSearch = async (query) => [
  { title: 'Euro hoje — Câmbio Exemplo', url: 'https://cambio.example/euro', snippet: `Resultado para "${query}": euro comercial hoje R$ 6,20 na venda; dólar R$ 5,40.` },
];

export const TEST_JWT = { secret: 'test-secret-test-secret-test-secret-0123', issuer: 'getnet-support', audience: 'getnet-support-api', ttlSeconds: 3600 };
const testJwt = new JwtService(TEST_JWT);

/** A valid bearer token for tests (same key as the app built by buildTestApp). */
export const tokenFor = async (sub: string, role: Role = 'merchant') => `Bearer ${await testJwt.issue({ sub, role })}`;

/** Friday 2026-10-23 12:00 in São Paulo. */
export const FIXED_NOW = () => new Date('2026-10-23T15:00:00Z');

export const KB_DOCS = [
  {
    url: 'https://site.getnet.com.br/todas-as-maquininhas/',
    title: 'Maquininhas Getnet',
    text: '## Get Smart\nA Get Smart é a maquininha mais completa: tela touch, sistema Android, aplicativos de gestão e emissão de nota fiscal.\n## Get Clássica\nA Get Clássica imprime comprovante, tem chip próprio e bateria de longa duração para agilizar o pagamento.',
  },
  {
    url: 'https://site.getnet.com.br/link-de-pagamento/',
    title: 'Link de pagamento',
    text: '## Link de pagamento\nCom o link de pagamento Get Pay você vende pelo WhatsApp, redes sociais ou e-mail e recebe no crédito, débito ou Pix sem maquininha.',
  },
  {
    url: 'internal://knowledge/support-playbook.md',
    title: 'Internal support playbook (synthetic)',
    text: '## Card machine does not connect to the internet\nRestart the card machine, check the Wi-Fi router, switch to the 4G chip and move the machine closer to an open area before opening a ticket.\n## Maquininha offline ou sem internet: como reiniciar e reconectar a máquina de cartão\nReinicie a maquininha, confira o roteador Wi-Fi e troque para o chip 4G antes de abrir um chamado de suporte.',
  },
];

export type AgentKind = 'router' | 'knowledge' | 'support' | 'personality';

export function kindOf(request: LLMRequest): AgentKind {
  if (request.system.includes('You are the Router')) return 'router';
  if (request.system.includes('Knowledge Agent')) return 'knowledge';
  if (request.system.includes('Customer Support Agent')) return 'support';
  if (request.system.includes('voice of Getnet')) return 'personality';
  throw new Error('unknown agent prompt');
}

export const route = (d: Partial<RouteDecision> & Pick<RouteDecision, 'route'>): FakeReply => ({
  toolCalls: [{ name: 'route_decision', input: { plan: [d.route], confidence: 0.95, language: 'en', reason: 'test', standalone_query: '', ...d } }],
});

/**
 * Fake LLM scripted per agent: each agent consumes its own queue of replies, so a test
 * describes the conversation of every agent independently of call ordering.
 */
export function scriptedLLM(script: Partial<Record<AgentKind, Array<FakeReply | (() => never)>>>) {
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...(v ?? [])]])) as Record<AgentKind, Array<FakeReply | (() => never)>>;
  return new FakeLLM((request) => {
    const kind = kindOf(request);
    const next = queues[kind]?.shift();
    if (!next) throw new Error(`FakeLLM: no scripted reply left for ${kind}`);
    return typeof next === 'function' ? next() : next;
  });
}

export async function buildTestApp(llm: FakeLLM, opts: { emptyKb?: boolean; personality?: boolean; dbPath?: string; now?: () => Date; webSearch?: WebSearch } = {}) {
  const config = loadConfig({ LOG_LEVEL: 'silent', ROUTER_CONFIDENCE_THRESHOLD: '0.6', PERSONALITY_ENABLED: String(opts.personality ?? false), AUTH_JWT_SECRET: TEST_JWT.secret, DB_PATH: opts.dbPath ?? ':memory:' });
  const repo = new MockCustomerRepository(JSON.parse(readFileSync('data/customers.json', 'utf8')), FIXED_NOW);
  const embedder = new HashingEmbedder();
  const store = await buildIndex(opts.emptyKb ? [] : KB_DOCS, embedder);
  const deps = buildDependencies({ config, llm, repo, store, embedder, now: opts.now ?? FIXED_NOW, logger: pino({ level: 'silent' }), webSearch: opts.webSearch ?? FAKE_WEB_SEARCH });
  return { app: await buildServer(deps), repo, llm, deps };
}
