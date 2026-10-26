import { existsSync } from 'node:fs';
import { z } from 'zod';

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** anthropic = Claude API (default); ollama = free local models, no API key. */
  LLM_PROVIDER: z.enum(['anthropic', 'ollama']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string().optional(),
  OLLAMA_URL: z.string().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('qwen2.5:7b'),
  ROUTER_MODEL: z.string().default('claude-haiku-5-5'),
  AGENT_MODEL: z.string().default('claude-sonnet-5-5'),
  PERSONALITY_ENABLED: z.stringbool().default(true),
  PERSONALITY_MODEL: z.string().default('claude-haiku-5-5'),
  WEB_SEARCH_MAX_USES: z.coerce.number().int().min(0).max(5).default(2),
  ROUTER_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  AGENT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(10).default(5),

  INDEX_PATH: z.string().default('data/index.json'),
  SOURCES_PATH: z.string().default('data/sources.json'),
  CUSTOMERS_PATH: z.string().default('data/customers.json'),
  /** `e5` = local multilingual model (default); `hashing` = dependency-free lexical fallback. */
  EMBEDDER: z.enum(['e5', 'hashing']).default('e5'),
  RETRIEVAL_TOP_K: z.coerce.number().int().min(1).max(20).default(6),
  /** Overrides the embedder's own default similarity threshold. */
  RETRIEVAL_MIN_SCORE: z.coerce.number().min(-1).max(1).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Loads `.env` (if present) into process.env without overriding variables already set. */
export function loadDotEnv(path = process.env.ENV_FILE ?? '.env'): void {
  if (!existsSync(path)) return;
  const before = { ...process.env };
  process.loadEnvFile(path);
  for (const [key, value] of Object.entries(before)) if (value !== undefined) process.env[key] = value;
}

export function loadConfig(env?: NodeJS.ProcessEnv): Config {
  if (!env) loadDotEnv();
  const parsed = ConfigSchema.safeParse(env ?? process.env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
