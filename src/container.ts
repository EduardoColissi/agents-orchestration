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

export interface AppDeps {
  orchestrator: Orchestrator;
  logger: Logger;
  knowledgeBaseSize: number;
}

export interface BuildOptions {
  config: Config;
  llm?: LLMClient;
  repo?: CustomerRepository;
  store?: VectorStore;
  embedder?: Embedder;
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
      llm = new OllamaClient(config.OLLAMA_URL, config.OLLAMA_MODEL);
    } else {
      if (!config.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required (see .env.example), or set LLM_PROVIDER=ollama');
      llm = new AnthropicClient(config.ANTHROPIC_API_KEY);
    }
  }
  // With Ollama every role uses the single local model.
  const model = (claudeModel: string) => (config.LLM_PROVIDER === 'ollama' ? config.OLLAMA_MODEL : claudeModel);

  const repo = opts.repo ?? MockCustomerRepository.fromFile(config.CUSTOMERS_PATH, opts.now);
  const store = opts.store ?? InMemoryVectorStore.load(config.INDEX_PATH);
  const embedder = opts.embedder ?? createEmbedder(config.EMBEDDER);
  const retriever = new Retriever(store, embedder, {
    topK: config.RETRIEVAL_TOP_K,
    maxPerUrl: 2,
    ...(config.RETRIEVAL_MIN_SCORE !== undefined ? { minScore: config.RETRIEVAL_MIN_SCORE } : {}),
  });
  if (retriever.isEmpty) logger.warn({ index: config.INDEX_PATH }, 'knowledge base is empty — run `npm run ingest`');

  const orchestrator = new Orchestrator({
    router: new RouterAgent(llm, model(config.ROUTER_MODEL)),
    agents: {
      knowledge: new KnowledgeAgent(llm, createKnowledgeBaseTool(retriever), {
        model: model(config.AGENT_MODEL),
        webSearchMaxUses: config.WEB_SEARCH_MAX_USES,
        maxIterations: config.AGENT_MAX_ITERATIONS,
        ...(opts.now ? { now: opts.now } : {}),
      }),
      support: new SupportAgent(llm, repo, {
        model: model(config.AGENT_MODEL),
        maxIterations: config.AGENT_MAX_ITERATIONS,
        ...(opts.now ? { now: opts.now } : {}),
      }),
    },
    escalation: new EscalationAgent(repo),
    personality: new PersonalityStage(llm, { model: model(config.PERSONALITY_MODEL), enabled: config.PERSONALITY_ENABLED }),
    logger,
    confidenceThreshold: config.ROUTER_CONFIDENCE_THRESHOLD,
  });

  return { orchestrator, logger, knowledgeBaseSize: store.size };
}
