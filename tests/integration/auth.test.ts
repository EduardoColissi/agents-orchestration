import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { buildTestApp, route, scriptedLLM, TEST_JWT, tokenFor } from '../helpers.js';

const key = new TextEncoder().encode(TEST_JWT.secret);
const sign = (claims: { sub?: string; role?: string; aud?: string; exp?: number }) =>
  new SignJWT({ role: claims.role ?? 'merchant' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub ?? 'cliente1988')
    .setIssuer(TEST_JWT.issuer)
    .setAudience(claims.aud ?? TEST_JWT.audience)
    .setExpirationTime(claims.exp ?? Math.floor(Date.now() / 1000) + 600)
    .sign(key);

const chat = (app: Awaited<ReturnType<typeof buildTestApp>>['app'], authorization?: string, payload: Record<string, unknown> = { message: 'When will my sales be deposited?' }) =>
  app.inject({ method: 'POST', url: '/chat', payload, ...(authorization ? { headers: { authorization } } : {}) });

describe('authentication (FR6, FR10)', () => {
  it('issues a token for valid demo credentials and audits it', async () => {
    const { app, deps } = await buildTestApp(scriptedLLM({}));
    const res = await app.inject({ method: 'POST', url: '/auth/token', payload: { username: 'op.ana', password: 'demo-op.ana' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ token_type: 'Bearer', expires_in: 3600, sub: 'op.ana', role: 'operator' });
    expect(await deps.jwt.verify(res.json().access_token)).toEqual({ sub: 'op.ana', role: 'operator' });
    expect(deps.audit.list({ action: 'auth.token_issued' })).toHaveLength(1);
  });

  it('rejects a wrong password (audited) and rate limits the login', async () => {
    const { app, deps } = await buildTestApp(scriptedLLM({}));
    const attempt = () => app.inject({ method: 'POST', url: '/auth/token', payload: { username: 'cliente1988', password: 'wrong' } });
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await attempt()).statusCode);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect(deps.audit.list({ action: 'auth.login_failed' })).toHaveLength(5);
  });

  it.each([
    ['missing token', undefined],
    ['garbage token', 'Bearer not-a-jwt'],
    ['expired token', 'expired'],
    ['wrong audience', 'aud'],
    ['alg none', 'none'],
  ])('401 for %s, without calling any agent', async (_name, kind) => {
    const llm = scriptedLLM({});
    const { app } = await buildTestApp(llm);
    let header = kind;
    if (kind === 'expired') header = `Bearer ${await sign({ exp: Math.floor(Date.now() / 1000) - 60 })}`;
    if (kind === 'aud') header = `Bearer ${await sign({ aud: 'another-api' })}`;
    if (kind === 'none') header = `Bearer ${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"cliente1988","role":"merchant"}').toString('base64url')}.`;
    const res = await chat(app, header);
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Bearer');
    expect(llm.calls).toHaveLength(0);
  });
});

describe('authorization (FR7, FR8)', () => {
  it('403 user_mismatch when the payload user_id differs from the token, with zero LLM calls (audited)', async () => {
    const llm = scriptedLLM({});
    const { app, deps } = await buildTestApp(llm);
    const res = await chat(app, await tokenFor('cliente1988'), { message: "Show cliente2000's sales", user_id: 'cliente2000' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('user_mismatch');
    expect(llm.calls).toHaveLength(0);
    expect(deps.audit.list({ action: 'auth.user_mismatch' })[0]).toMatchObject({ actor: 'cliente1988', details: { claimed_user_id: 'cliente2000' } });
  });

  it('an operator token cannot chat as a merchant', async () => {
    const { app } = await buildTestApp(scriptedLLM({}));
    expect((await chat(app, await tokenFor('op.ana', 'operator'))).statusCode).toBe(403);
  });

  it('identity comes from the token: tools read the token subject even without user_id', async () => {
    const llm = scriptedLLM({
      router: [route({ route: 'support' })],
      support: [{ toolCalls: [{ name: 'get_customer_profile', input: { user_id: 'cliente2000' } }] }, { text: 'Your plan is Get Smart.' }],
    });
    const { app } = await buildTestApp(llm);
    const res = await chat(app, await tokenFor('cliente1988'), { message: 'What is my plan?' });
    expect(res.statusCode).toBe(200);
    const toolResult = JSON.stringify(llm.calls.at(-1)!.messages);
    expect(toolResult).toContain('Padaria');
    expect(toolResult).not.toContain('Mercado Bairro Alto');
  });
});
