/**
 * Local-mode stand-in for @altium-mcp/metering.
 *
 * The hosted server meters tool calls against a plan (Postgres + Redis).
 * The local `pcbviber` package runs on one engineer's machine with no
 * account, so there is nothing to meter: the dispatch layer is always
 * handed `metering: null` and never reaches `meter()`. This shim only
 * exists so the bundle does not pull in the database client.
 */
export type Metric = string;

export class QuotaExceeded extends Error {
  readonly metric: Metric;
  readonly limit: number;
  readonly used: number;

  constructor(args: { metric: Metric; limit: number; used: number }) {
    super(`quota_exceeded: ${args.metric} limit=${args.limit} used=${args.used}`);
    this.name = "QuotaExceeded";
    this.metric = args.metric;
    this.limit = args.limit;
    this.used = args.used;
  }
}

export async function meter<T>(
  _ctx: unknown,
  _opts: unknown,
  fn: () => Promise<T>,
  _deps?: unknown
): Promise<T> {
  return fn();
}
