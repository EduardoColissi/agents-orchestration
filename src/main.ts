import { loadConfig } from './config.js';
import { buildDependencies } from './container.js';
import { buildServer } from './server.js';

const config = loadConfig();
const deps = buildDependencies({ config });
const app = await buildServer(deps);

const shutdown = async (signal: string) => {
  deps.logger.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Finish resolutions interrupted by a crash, then expire stale handoffs periodically (FR21).
deps.hitl.sweep();
await deps.hitl.recover();
const sweeper = setInterval(() => void deps.hitl.tick(), config.SWEEP_INTERVAL_MS);
sweeper.unref();

await app.listen({ port: config.PORT, host: config.HOST });
deps.logger.info({ port: config.PORT, provider: config.LLM_PROVIDER, router_model: config.LLM_PROVIDER === 'ollama' ? config.OLLAMA_ROUTER_MODEL : config.ROUTER_MODEL, agent_model: config.LLM_PROVIDER === 'ollama' ? config.OLLAMA_AGENT_MODEL : config.AGENT_MODEL, kb_chunks: deps.knowledgeBaseSize }, 'server ready');
