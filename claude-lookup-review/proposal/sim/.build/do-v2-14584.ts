class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }

// PROPOSAL (not deployed). Redesign of the shared Lark gate + search batcher.
//
//  1. One FIFO gate (concurrency + start spacing + shared cooldown). Waiters are
//     granted slots in arrival order by a single scheduler -- no polling, no
//     thundering herd, no starvation.
//  2. Batch-while-busy: a per-(table,auth,username-field) bucket stays OPEN
//     while it waits for its gate slot, so batch size grows with load instead of
//     being fixed by a 25 ms timer. Latency then scales with the number of
//     tables, not the number of agents.
//  3. Callers carry a deadline (expiresAt). Expired waiters are dropped before
//     a query is built, so cancelled/timed-out lookups stop consuming capacity.
//  4. Fail closed: a merged result with any row that cannot be attributed to a
//     requested username, or a failed/truncated page, never becomes a partial
//     "clean" answer. Oversized chunks are bisected; unattributable results fall
//     back to exact single-user queries.
//  5. Only selective shapes are merged (username + optional Brand). Wide
//     predicates (e.g. Customer Approaching's Agent/Inquiry/Status case lookup)
//     go through the gate unbatched, because Lark has no nested filter groups
//     and merging would pull the table's whole history for those usernames.
//  6. 429 -> bounded retry after a shared cooldown; start spacing backs off
//     multiplicatively and recovers slowly (AIMD).

type Env = { MY_DURABLE_OBJECT: DurableObjectNamespace<MyDurableObject> } & Record<string, unknown>;
type PermitResult = { ticket: string | null; retryAfterMs: number };
type SearchBatchInput = { url: string; method: string; headers: Record<string, string>; body: string; expiresAt?: number };
type SearchBatchResult = { status: number; statusText: string; headers: [string, string][]; body: string };
type Waiter = {
  input: SearchBatchInput; body: any; usernameField: string; username: string;
  expiresAt: number; enqueuedAt: number; resolve: (r: SearchBatchResult) => void;
};
type Bucket = { key: string; waiters: Waiter[]; createdAt: number };

const MAX_USERNAMES = 50;          // Lark: filter.conditions length 0..50
const MAX_PAGES = 10;
const MIN_WINDOW_MS = 15;          // only matters when the gate is idle
const UPSTREAM_TIMEOUT_MS = 6_000;
const MAX_429_RETRIES = 2;
const MAX_COOLDOWN_MS = 5_000;
const PERMIT_LEASE_MS = 8_000;
const ACQUIRE_LONGPOLL_MS = 5_000;

const failure = (status: number, msg: string): SearchBatchResult => ({
  status, statusText: "", headers: [["content-type", "application/json"]],
  body: JSON.stringify({ code: -1, msg }),
});

export class MyDurableObject extends DurableObject<Env> {
  private concurrency: number;
  private baseGapMs: number;
  private gapMs: number;
  private active = 0;
  private nextStartAt = 0;
  private cooldownUntil = 0;
  private okStreak = 0;
  private waitq: Array<{ grant: () => void; cancelled: boolean }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private buckets = new Map<string, Bucket>();
  private tickets = new Map<string, ReturnType<typeof setTimeout>>();
  private s = { upstream: 0, limited: 0, retries429: 0, batches: 0, batchSizes: [] as number[], queueWaitMs: [] as number[],
    expiredDropped: 0, bisected: 0, orphanFallbacks: 0, peakQueue: 0, truncatedFails: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.concurrency = Number(env?.GATE_CONCURRENCY) || 4;
    this.baseGapMs = this.gapMs = Number(env?.GATE_START_GAP_MS) || 100; // 10 starts/s: 50% of the documented 20/s
  }

  getStats() { return { ...this.s, gapMs: this.gapMs, queued: this.waitq.length, active: this.active }; }

  // ---- gate -------------------------------------------------------------
  private acquireSlot(front = false): { promise: Promise<void>; cancel: () => void } {
    let entry!: { grant: () => void; cancelled: boolean };
    const promise = new Promise<void>((grant) => { entry = { grant, cancelled: false }; });
    if (front) this.waitq.unshift(entry); else this.waitq.push(entry);
    this.s.peakQueue = Math.max(this.s.peakQueue, this.waitq.length);
    this.pump();
    return { promise, cancel: () => { entry.cancelled = true; } };
  }

  private pump(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    while (this.waitq.length && this.active < this.concurrency) {
      const head = this.waitq[0];
      if (head.cancelled) { this.waitq.shift(); continue; }
      const now = Date.now();
      const at = Math.max(this.nextStartAt, this.cooldownUntil);
      if (at > now) { this.timer = setTimeout(() => { this.timer = null; this.pump(); }, at - now); return; }
      this.waitq.shift();
      this.active++;
      this.nextStartAt = now + this.gapMs;
      head.grant();
    }
  }

  private releaseSlot(limited: boolean, retryAfterMs = 0): void {
    this.active = Math.max(0, this.active - 1);
    if (limited) {
      this.s.limited++;
      this.okStreak = 0;
      this.gapMs = Math.min(500, this.gapMs * 2);
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + Math.min(MAX_COOLDOWN_MS, Math.max(1_000, retryAfterMs)));
    } else if (++this.okStreak >= 20) {
      this.okStreak = 0;
      this.gapMs = Math.max(this.baseGapMs, Math.floor(this.gapMs * 0.8));
    }
    this.pump();
  }

  // Slot must already be held. Always releases it.
  private async fetchOnce(input: SearchBatchInput): Promise<{ result: SearchBatchResult; limited: boolean }> {
    this.s.upstream++;
    try {
      const response = await fetch(input.url, {
        method: input.method || "POST", headers: input.headers, body: input.body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const body = await response.text();
      let limited = response.status === 429;
      try { const p = JSON.parse(body); limited ||= Number(p.code) === 99991400 || Number(p.code) === 1254290 || /too ?many ?requests?|rate.?limit/i.test(String(p.msg || "")); } catch { /* HTTP status only */ }
      this.releaseSlot(limited, Number(response.headers.get("Retry-After")) * 1000 || 0);
      return { limited, result: { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body } };
    } catch (error) {
      this.releaseSlot(false);
      return { limited: false, result: failure(504, String((error as Error)?.message || error)) };
    }
  }

  private async fetchPage(input: SearchBatchInput, haveSlot: boolean): Promise<SearchBatchResult> {
    for (let attempt = 0; ; attempt++) {
      if (!haveSlot) await this.acquireSlot(true).promise;
      haveSlot = false;
      const { result, limited } = await this.fetchOnce(input);
      if (!limited) return result;
      if (attempt >= MAX_429_RETRIES) return result;
      this.s.retries429++;
    }
  }

  // ---- RPC: permits for non-search calls (token, create, update, fields) -----
  // Long-polls inside the DO so callers do not poll over RPC and are served FIFO.
  async acquire(): Promise<PermitResult> {
    const slot = this.acquireSlot(false);
    let timedOut = false;
    const timeout = new Promise<null>((resolve) => setTimeout(() => { timedOut = true; resolve(null); }, ACQUIRE_LONGPOLL_MS));
    await Promise.race([slot.promise, timeout]);
    if (timedOut) { slot.cancel(); return { ticket: null, retryAfterMs: 100 }; }
    const ticket = crypto.randomUUID();
    this.tickets.set(ticket, setTimeout(() => { if (this.tickets.delete(ticket)) this.releaseSlot(false); }, PERMIT_LEASE_MS));
    return { ticket, retryAfterMs: 0 };
  }
  async release(ticket: string, rateLimited = false, retryAfterMs = 0): Promise<void> {
    const t = this.tickets.get(ticket);
    if (!t) return;
    clearTimeout(t); this.tickets.delete(ticket);
    this.releaseSlot(rateLimited, retryAfterMs);
  }
  async penalize(retryAfterMs = 0): Promise<void> {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + Math.min(MAX_COOLDOWN_MS, Math.max(1_000, retryAfterMs)));
  }

  // ---- RPC: searches ------------------------------------------------------
  async searchBatch(input: SearchBatchInput): Promise<SearchBatchResult> {
    const expiresAt = Number(input.expiresAt) || Date.now() + 60_000;
    let body: any;
    try { body = JSON.parse(input.body || "{}"); } catch { return this.single(input, expiresAt); }
    const conds = body?.filter?.conditions;
    if (!Array.isArray(conds) || body?.filter?.conjunction === "or") return this.single(input, expiresAt);
    const userConds = conds.filter((c: any) => c?.operator === "is" && /^(username(?:\/uid)?|uid)$/i.test(String(c.field_name || ""))
      && Array.isArray(c.value) && c.value.length === 1);
    const others = conds.filter((c: any) => !userConds.includes(c));
    // Only merge selective shapes: username [+ brand]. Anything else stays exact.
    const selective = others.every((c: any) => c?.operator === "is" && /^brand$/i.test(String(c.field_name || "")));
    if (userConds.length !== 1 || !selective || !String(userConds[0].value[0] ?? "")) return this.single(input, expiresAt);

    return new Promise<SearchBatchResult>((resolve) => {
      const waiter: Waiter = {
        input, body, usernameField: String(userConds[0].field_name), username: String(userConds[0].value[0]),
        expiresAt, enqueuedAt: Date.now(), resolve,
      };
      const url = new URL(input.url);
      const headers = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v]));
      const key = JSON.stringify([url.origin, url.pathname, headers.authorization || "", waiter.usernameField,
        !!body.automatic_fields, !!body.field_names?.length]);
      let bucket = this.buckets.get(key);
      if (!bucket) { bucket = { key, waiters: [], createdAt: Date.now() }; this.buckets.set(key, bucket); void this.runBucket(bucket, false); }
      bucket.waiters.push(waiter);
    });
  }

  private async single(input: SearchBatchInput, expiresAt: number): Promise<SearchBatchResult> {
    const slot = this.acquireSlot(false);
    await slot.promise;
    if (Date.now() >= expiresAt) { this.s.expiredDropped++; this.releaseSlot(false); return failure(504, "Lark search deadline exceeded in queue."); }
    return this.fetchPage(input, true);
  }

  private async runBucket(bucket: Bucket, front: boolean): Promise<void> {
    await this.acquireSlot(front).promise;               // bucket stays open (still in this.buckets) until now
    const wait = bucket.createdAt + MIN_WINDOW_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (this.buckets.get(bucket.key) === bucket) this.buckets.delete(bucket.key); // close: later arrivals open a new bucket

    const now = Date.now();
    const live: Waiter[] = [];
    for (const w of bucket.waiters) {
      if (w.expiresAt <= now) { this.s.expiredDropped++; w.resolve(failure(504, "Lark search deadline exceeded in queue.")); } else live.push(w);
    }
    if (!live.length) { this.releaseSlot(false); return; }

    // Take up to MAX_USERNAMES distinct usernames; the rest re-queue at the FRONT (they have waited longest).
    const byUser = new Map<string, Waiter[]>();
    const leftover: Waiter[] = [];
    for (const w of live) {
      const list = byUser.get(w.username);
      if (list) list.push(w);
      else if (byUser.size < MAX_USERNAMES) byUser.set(w.username, [w]);
      else leftover.push(w);
    }
    if (leftover.length) this.requeue(bucket.key, leftover, true);
    await this.execute(bucket.key, [...byUser.entries()]);
  }

  private requeue(key: string, waiters: Waiter[], front: boolean): void {
    let bucket = this.buckets.get(key);
    if (bucket) { bucket.waiters.unshift(...waiters); return; }
    bucket = { key, waiters, createdAt: 0 };
    this.buckets.set(key, bucket);
    void this.runBucket(bucket, front);
  }

  // The first page uses the slot runBucket already holds.
  private async execute(key: string, chunk: Array<[string, Waiter[]]>): Promise<void> {
    const first = chunk[0][1][0];
    const usernameField = first.usernameField;
    const usernames = new Set(chunk.map(([u]) => u));
    const allWaiters = chunk.flatMap(([, w]) => w);
    const startedAt = Date.now();
    for (const w of allWaiters) this.s.queueWaitMs.push(startedAt - w.enqueuedAt);
    this.s.batches++; this.s.batchSizes.push(usernames.size);

    const unionFields = chunk.some(([, ws]) => ws.some((w) => !w.body.field_names?.length)) ? null
      : [...new Set([usernameField, ...allWaiters.flatMap((w) => [...(w.body.field_names || []),
          ...(w.body.filter?.conditions || []).map((c: any) => c.field_name).filter(Boolean)])])];
    const merged = JSON.stringify({
      filter: { conjunction: "or", conditions: [...usernames].map((u) => ({ field_name: usernameField, operator: "is", value: [u] })) },
      automatic_fields: !!first.body.automatic_fields,
      ...(unionFields ? { field_names: unionFields } : {}),
    });
    const baseUrl = new URL(first.input.url);
    baseUrl.searchParams.set("page_size", "500");

    const rows: any[] = [];
    let pageToken = "";
    let more = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const pageUrl = new URL(baseUrl);
      pageUrl.searchParams.delete("page_token");
      if (pageToken) pageUrl.searchParams.set("page_token", pageToken);
      const result = await this.fetchPage({ ...first.input, url: pageUrl.toString(), body: merged }, page === 0);
      let parsed: any = null;
      try { parsed = JSON.parse(result.body); } catch { /* handled below */ }
      if (result.status < 200 || result.status >= 300 || !parsed || parsed.code !== 0) {
        // Never a partial answer: every caller gets the upstream failure.
        for (const w of allWaiters) w.resolve(result);
        return;
      }
      rows.push(...(parsed.data?.items || []));
      more = !!parsed.data?.has_more && !!parsed.data?.page_token;
      if (!more) break;
      pageToken = String(parsed.data.page_token);
    }
    if (more) {
      this.s.truncatedFails++;
      if (chunk.length > 1) {                              // bisect: one heavy user must not fail 49 others
        this.s.bisected++;
        const mid = Math.ceil(chunk.length / 2);
        await Promise.all([chunk.slice(0, mid), chunk.slice(mid)].map((half) => this.executeAfterSlot(key, half)));
        return;
      }
      for (const w of allWaiters) w.resolve(failure(502, `Batched Lark search exceeded ${MAX_PAGES} pages for one username.`));
      return;
    }

    // Attribution check: every row must belong to a requested username, else
    // normalization differs from Lark's `is` and splitting could silently drop rows.
    const seen = new Set<string>();
    const per = new Map<string, any[]>();
    let orphan = false;
    for (const row of rows) {
      if (row.record_id && seen.has(row.record_id)) continue;
      if (row.record_id) seen.add(row.record_id);
      const text = this.fieldText(row?.fields?.[usernameField]);
      if (!usernames.has(text)) { orphan = true; break; }
      (per.get(text) || per.set(text, []).get(text)!).push(row);
    }
    if (orphan) {
      this.s.orphanFallbacks++;
      await Promise.all(allWaiters.map(async (w) => w.resolve(await this.single(w.input, w.expiresAt))));
      return;
    }
    const ok = (items: any[]): SearchBatchResult => ({
      status: 200, statusText: "OK", headers: [["content-type", "application/json"], ["x-lark-batched", "1"]],
      body: JSON.stringify({ code: 0, data: { items, has_more: false, page_token: "" } }),
    });
    for (const [username, ws] of chunk) { const body = ok(per.get(username) || []); for (const w of ws) w.resolve(body); }
  }

  private async executeAfterSlot(key: string, half: Array<[string, Waiter[]]>): Promise<void> {
    await this.acquireSlot(true).promise;
    return this.execute(key, half);
  }

  private fieldText(value: any): string {
    if (value == null) return "";
    if (Array.isArray(value)) return value.map((item) => this.fieldText(item)).filter(Boolean).join(", ");
    if (typeof value === "object") {
      if ("text" in value) return this.fieldText(value.text);
      if ("value" in value) return this.fieldText(value.value);
      return "";
    }
    return String(value).trim();
  }
}

export default {
  async fetch(): Promise<Response> { return new Response("Not found", { status: 404 }); },
} satisfies ExportedHandler<Env>;
