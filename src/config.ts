import { existsSync, readFileSync } from 'node:fs';
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
