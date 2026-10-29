import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

export type Role = 'merchant' | 'operator';

/** Authenticated identity. Built only from a verified token, never from the request body. */
export interface Principal {
  sub: string;
  role: Role;
}

export interface JwtOptions {
  secret: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

/** HS256 tokens with pinned algorithm, issuer, audience and expiry. */
export class JwtService {
  private readonly key: Uint8Array;

  constructor(private readonly options: JwtOptions) {
    this.key = new TextEncoder().encode(options.secret);
  }

  get ttlSeconds(): number {
    return this.options.ttlSeconds;
  }

  async issue(principal: Principal): Promise<string> {
    return new SignJWT({ role: principal.role })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(principal.sub)
      .setIssuer(this.options.issuer)
      .setAudience(this.options.audience)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(`${this.options.ttlSeconds}s`)
      .sign(this.key);
  }

  /** Throws on any invalid token: bad signature, other algorithm, wrong iss/aud, expired. */
  async verify(token: string): Promise<Principal> {
    const { payload } = await jwtVerify(token, this.key, {
      algorithms: ['HS256'],
      issuer: this.options.issuer,
      audience: this.options.audience,
      clockTolerance: 5,
    });
    if (typeof payload.sub !== 'string' || (payload.role !== 'merchant' && payload.role !== 'operator')) {
      throw new Error('token without subject or role');
    }
    return { sub: payload.sub, role: payload.role };
  }
}
