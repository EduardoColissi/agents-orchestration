/**
 * Prints a users.json entry: `npm run hash-password -- <username> <merchant|operator> <password>`.
 * Without arguments, regenerates data/users.json with the documented demo users (README).
 */
import { writeFileSync } from 'node:fs';
import { hashPassword } from '../src/auth/credentials.js';

const DEMO_USERS = [
  { username: 'cliente1988', role: 'merchant', password: 'demo-cliente1988' },
  { username: 'cliente2000', role: 'merchant', password: 'demo-cliente2000' },
  { username: 'ghost42', role: 'merchant', password: 'demo-ghost42' },
  { username: 'op.ana', role: 'operator', password: 'demo-op.ana' },
  { username: 'op.bruno', role: 'operator', password: 'demo-op.bruno' },
] as const;

const [username, role, password] = process.argv.slice(2);
if (username && role && password) {
  console.log(JSON.stringify({ username, role, ...hashPassword(password) }));
} else {
  const users = DEMO_USERS.map(({ password: p, ...u }) => ({ ...u, ...hashPassword(p) }));
  writeFileSync('data/users.json', `${JSON.stringify(users, null, 2)}\n`);
  console.log(`data/users.json: ${users.length} demo users`);
}
