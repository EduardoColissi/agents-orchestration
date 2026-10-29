import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Commit the running build came from (Docker build arg); reported by /health and recorded in eval reports. */
  GIT_SHA: z.string().default('dev'),
  /** Chat turns per minute per authenticated merchant (each turn costs several LLM calls). */
  CHAT_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(20),

  /** ollama = free local models, no API key (default); anthropic = Claude API. */
  LLM_PROVIDER: z.enum(['anthropic', 'ollama']).default('ollama'),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Required only for organisation-level keys (sk-ant-usr…), which must name a workspace. */
  ANTHROPIC_WORKSPACE_ID: z.string().optional(),
  OLLAMA_URL: z.string().default('http://localhost:11434'),
  /** Cheap router + stronger specialists, also on the local provider. */
  OLLAMA_ROUTER_MODEL: z.string().default('llama3.2:3b'),
  OLLAMA_AGENT_MODEL: z.string().default('llama3.1:8b'),
  OLLAMA_NUM_CTX: z.coerce.number().int().min(2048).default(8192),
  OLLAMA_KEEP_ALIVE: z.string().default('30m'),
  ROUTER_MODEL: z.string().default('claude-haiku-5-5'),
  AGENT_MODEL: z.string().default('claude-sonnet-5-5'),
  /** Off by default: an extra LLM call per answer is slow on local models. */
  PERSONALITY_ENABLED: z.stringbool().default(false),
  PERSONALITY_MODEL: z.string().default('claude-haiku-5-5'),
  WEB_SEARCH_MAX_USES: z.coerce.number().int().min(0).max(5).default(2),
  ROUTER_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  AGENT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(10).default(5),

  /** SQLite file (conversations, handoffs, tickets, audit). A Docker volume in compose. */
  DB_PATH: z.string().default('var/app.db'),
  /** HS256 key (>= 32 chars). Unset = generated once and kept next to DB_PATH. */
  AUTH_JWT_SECRET: z.string().min(32).optional(),
  AUTH_ISSUER: z.string().default('getnet-support'),
  AUTH_AUDIENCE: z.string().default('getnet-support-api'),
  AUTH_TOKEN_TTL_S: z.coerce.number().int().min(60).max(86400).default(3600),
  USERS_PATH: z.string().default('data/users.json'),
  /** Pending handoffs expire after this many minutes (an expired approval never executes). */
  HANDOFF_TTL_MINUTES: z.coerce.number().int().min(1).default(240),
  SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(60000),

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

/**
 * Parses a dotenv file. Tolerates what Windows editors produce: UTF-8 BOM, UTF-16 (Notepad /
 * old PowerShell `Set-Content`), CRLF, quotes and `export KEY=` prefixes.
 */
export function parseDotEnv(raw: Buffer): Record<string, string> {
  let text: string;
  if (raw[0] === 0xff && raw[1] === 0xfe) text = raw.subarray(2).toString('utf16le');
  else if (raw[0] === 0xfe && raw[1] === 0xff) text = Buffer.from(raw.subarray(2)).swap16().toString('utf16le');
  else text = raw.toString('utf8').replace(/^\uFEFF/, '');

  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2]!;
    else value = value.replace(/\s+#.*$/, '').trim();
    out[match[1]!] = value;
  }
  return out;
}

/** Loads `.env` (if present) into process.env without overriding variables already set. */
export function loadDotEnv(path = process.env.ENV_FILE ?? '.env'): void {
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(parseDotEnv(readFileSync(path)))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadConfig(env?: NodeJS.ProcessEnv): Config {
  if (!env) loadDotEnv();
  const parsed = ConfigSchema.safeParse(env ?? process.env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
