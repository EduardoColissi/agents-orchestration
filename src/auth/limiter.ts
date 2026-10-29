/**
 * Fixed-window counter in memory (single instance, like the rest of the in-process state).
 * Used to cap failed logins per IP across all usernames (password spraying).
 */
export class FixedWindowCounter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** True when the key already reached the limit in the current window. */
  exceeded(key: string): boolean {
    const w = this.windows.get(key);
    return !!w && this.now() - w.start < this.windowMs && w.count >= this.limit;
  }

  hit(key: string): void {
    const at = this.now();
    const w = this.windows.get(key);
    if (!w || at - w.start >= this.windowMs) this.windows.set(key, { start: at, count: 1 });
    else w.count++;
    if (this.windows.size > 10_000) for (const [k, v] of this.windows) if (at - v.start >= this.windowMs) this.windows.delete(k);
  }
}
