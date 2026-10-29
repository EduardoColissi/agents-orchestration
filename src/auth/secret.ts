import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Signing key: AUTH_JWT_SECRET when set; otherwise a random key generated once and kept next to
 * the database (a Docker volume), so `docker compose up` needs no secret and none lives in the repo.
 */
export function resolveJwtSecret(configured: string | undefined, dbPath: string): { secret: string; source: 'env' | 'generated' | 'file' } {
  if (configured) return { secret: configured, source: 'env' };
  if (dbPath === ':memory:') return { secret: randomBytes(48).toString('base64url'), source: 'generated' };
  const file = join(dirname(dbPath), 'jwt-secret');
  if (existsSync(file)) return { secret: readFileSync(file, 'utf8').trim(), source: 'file' };
  mkdirSync(dirname(file), { recursive: true });
  const secret = randomBytes(48).toString('base64url');
  writeFileSync(file, secret, { mode: 0o600 });
  return { secret, source: 'generated' };
}
