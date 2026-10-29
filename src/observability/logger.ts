import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { service: 'getnet-multi-agent' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Defence in depth: raw messages are masked before logging, but never log secrets.
    redact: ['req.headers.authorization', 'apiKey', '*.apiKey'],
  });
}

/** Measures a stage and returns its result plus latency in ms. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - start) };
}
