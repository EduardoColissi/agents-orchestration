import type { Config } from './config.js';
import type { LLMClient } from './llm/client.js';
import { AnthropicClient } from './llm/anthropic.js';
import { OllamaClient } from './llm/ollama.js';
import { RouterAgent } from './agents/router.js';
import { KnowledgeAgent } from './agents/knowledge.js';
import { SupportAgent } from './agents/support.js';
import { EscalationAgent } from './agents/escalation.js';
import { PersonalityStage } from './agents/personality.js';
import { Orchestrator } from './orchestrator.js';
import type { CustomerRepository } from './support/repository.js';
import { MockCustomerRepository } from './support/mockRepository.js';
import { Retriever, createKnowledgeBaseTool } from './rag/retriever.js';
import { createEmbedder, type Embedder } from './rag/embedder.js';
import { InMemoryVectorStore, type VectorStore } from './rag/vectorStore.js';
import { createLogger, type Logger } from './observability/logger.js';
import { openDb, type Db } from './store/db.js';
import { AuditLog } from './store/audit.js';
import { TicketStore } from './store/tickets.js';
import { ConversationStore } from './store/conversations.js';
import { ChatService } from './chat/service.js';
import { HandoffStore } from './store/handoffs.js';
import { HitlService } from './hitl/service.js';
import { JwtService } from './auth/jwt.js';
import { CredentialStore } from './auth/credentials.js';
import { resolveJwtSecret } from './auth/secret.js';

export interface AppDeps {
  config: Config;
  orchestrator: Orchestrator;
  logger: Logger;
  knowledgeBaseSize: number;
  db: Db;
  audit: AuditLog;
  jwt: JwtService;
  credentials: CredentialStore;
  conversations: ConversationStore;
  chat: ChatService;
  handoffs: HandoffStore;
  hitl: HitlService;
  now: () => Date;
}

export interface BuildOptions {
  config: Config;
  llm?: LLMClient;
  repo?: CustomerRepository;
  store?: VectorStore;
  embedder?: Embedder;
  db?: Db;
  logger?: Logger;
  now?: () => Date;
}

/** Composition root: the only place that knows concrete implementations. Tests inject fakes. */
export function buildDependencies(opts: BuildOptions): AppDeps {
  const { config } = opts;
  const logger = opts.logger ?? createLogger(config.LOG_LEVEL);

  let llm = opts.llm;
  if (!llm) {
    if (config.LLM_PROVIDER === 'ollama') {
      llm = new OllamaClient(config.OLLAMA_URL, config.OLLAMA_AGENT_MODEL, fetch, { numCtx: config.OLLAMA_NUM_CTX, keepAlive: config.OLLAMA_KEEP_ALIVE });
    } else {
      if (!config.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required (see .env.example), or set LLM_PROVIDER=ollama');
      llm = new AnthropicClient(config.ANTHROPIC_API_KEY, undefined, { workspaceId: config.ANTHROPIC_WORKSPACE_ID });
    }
  }
  // Per-role models on both providers: the router is the cheap one.
  const local = config.LLM_PROVIDER === 'ollama';
  const model = (role: 'router' | 'agent', claudeModel: string) => (local ? (role === 'router' ? config.OLLAMA_ROUTER_MODEL : config.OLLAMA_AGENT_MODEL) : claudeModel);

  const now = opts.now ?? (() => new Date());
  const db = opts.db ?? openDb(config.DB_PATH);
  const audit = new AuditLog(db, now);
  const { secret, source } = resolveJwtSecret(config.AUTH_JWT_SECRET, config.DB_PATH);
  if (source === 'generated') logger.warn({ db: config.DB_PATH }, 'AUTH_JWT_SECRET not set — generated a signing key next to the database');
  const jwt = new JwtService({ secret, issuer: config.AUTH_ISSUER, audience: config.AUTH_AUDIENCE, ttlSeconds: config.AUTH_TOKEN_TTL_S });
  const credentials = CredentialStore.fromFile(config.USERS_PATH);

  const repo = opts.repo ?? MockCustomerRepository.fromFile(config.CUSTOMERS_PATH, opts.now, new TicketStore(db));
  const store = opts.store ?? InMemoryVectorStore.load(config.INDEX_PATH);
  const embedder = opts.embedder ?? createEmbedder(config.EMBEDDER);
  const retriever = new Retriever(store, embedder, {
    topK: config.RETRIEVAL_TOP_K,
    maxPerUrl: 2,
    ...(config.RETRIEVAL_MIN_SCORE !== undefined ? { minScore: config.RETRIEVAL_MIN_SCORE } : {}),
  });
  if (retriever.isEmpty) logger.warn({ index: config.INDEX_PATH }, 'knowledge base is empty — run `npm run ingest`');

  const orchestrator = new Orchestrator({
    router: new RouterAgent(llm, model('router', config.ROUTER_MODEL)),
    agents: {
      knowledge: new KnowledgeAgent(llm, createKnowledgeBaseTool(retriever), {
        model: model('agent', config.AGENT_MODEL),
        webSearchMaxUses: config.WEB_SEARCH_MAX_USES,
        maxIterations: config.AGENT_MAX_ITERATIONS,
        ...(opts.now ? { now: opts.now } : {}),
      }),
      support: new SupportAgent(llm, repo, {
        model: model('agent', config.AGENT_MODEL),
        provider: opts.llm ? 'injected' : config.LLM_PROVIDER,
        maxIterations: config.AGENT_MAX_ITERATIONS,
        ...(opts.now ? { now: opts.now } : {}),
      }),
    },
    escalation: new EscalationAgent(),
    personality: new PersonalityStage(llm, { model: model('agent', config.PERSONALITY_MODEL), enabled: config.PERSONALITY_ENABLED }),
    logger,
    confidenceThreshold: config.ROUTER_CONFIDENCE_THRESHOLD,
  });

  const conversations = new ConversationStore(db, now);
  const handoffs = new HandoffStore(db, now);
  const chat = new ChatService({ db, orchestrator, conversations, handoffs, audit, handoffTtlMinutes: config.HANDOFF_TTL_MINUTES });
  const support = orchestrator.agents.support as SupportAgent;
  support.useAudit(audit);
  const hitl = new HitlService({ db, handoffs, conversations, audit, logger, approvals: support });

  return { config, orchestrator, logger, knowledgeBaseSize: store.size, db, audit, jwt, credentials, conversations, chat, handoffs, hitl, now };
}
