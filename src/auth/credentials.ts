import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Principal } from './jwt.js';

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;

const UserRecord = z.object({
  username: z.string().min(1),
  role: z.enum(['merchant', 'operator']),
  salt: z.string().min(16),
  hash: z.string().min(16),
});
export type UserRecord = z.infer<typeof UserRecord>;

export function hashPassword(password: string, salt = randomBytes(16).toString('base64url')): { salt: string; hash: string } {
  return { salt, hash: scryptSync(password, salt, KEY_LENGTH, SCRYPT).toString('base64url') };
}

/**
 * Demo identity store standing in for the company IdP (spec §3): scrypt hashes, constant-time
 * comparison, and the same work for unknown usernames so timing does not reveal who exists.
 */
export class CredentialStore {
  private readonly users: Map<string, UserRecord>;
  private readonly dummy = hashPassword('dummy-password');

  constructor(users: UserRecord[]) {
    this.users = new Map(users.map((u) => [u.username, u]));
  }

  static fromFile(path: string): CredentialStore {
    return new CredentialStore(z.array(UserRecord).parse(JSON.parse(readFileSync(path, 'utf8'))));
  }

  verify(username: string, password: string): Principal | null {
    const user = this.users.get(username);
    const expected = Buffer.from(user?.hash ?? this.dummy.hash, 'base64url');
    const actual = scryptSync(password, user?.salt ?? this.dummy.salt, KEY_LENGTH, SCRYPT);
    const match = expected.length === actual.length && timingSafeEqual(expected, actual);
    return user && match ? { sub: user.username, role: user.role } : null;
  }
}
