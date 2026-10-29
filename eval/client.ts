/** HTTP-only client: the evaluation drives the deployed API exactly like a real caller (FR24). */
export interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
}

export class ApiClient {
  private readonly tokens = new Map<string, string>();

  constructor(private readonly baseUrl: string, private readonly passwords: (username: string) => string = (u) => `demo-${u}`) {}

  async health(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5000) }).catch((err: Error) => {
      throw new Error(`API not reachable at ${this.baseUrl} (${err.message}). Start it with \`docker compose up\` or \`npm run dev\`.`);
    });
    return (await res.json()) as Record<string, unknown>;
  }

  async token(username: string): Promise<string> {
    const cached = this.tokens.get(username);
    if (cached) return cached;
    const res = await this.call<{ access_token: string }>('POST', '/auth/token', undefined, { username, password: this.passwords(username) });
    if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status}`);
    this.tokens.set(username, res.body.access_token);
    return res.body.access_token;
  }

  async as<T = Record<string, unknown>>(username: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResult<T>> {
    const res = await this.call<T>(method, path, await this.token(username), body);
    if (res.status !== 401) return res;
    // Long runs (CPU) outlive the token TTL: log in again once.
    this.tokens.delete(username);
    return this.call<T>(method, path, await this.token(username), body);
  }

  private async call<T>(method: string, path: string, token?: string, body?: unknown): Promise<ApiResult<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(300_000),
    });
    return { status: res.status, body: (await res.json()) as T };
  }
}
