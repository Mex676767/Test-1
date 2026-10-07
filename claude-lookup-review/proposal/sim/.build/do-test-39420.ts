class DurableObject { constructor(c, e) { this.ctx = c; this.env = e; } }

// PROPOSAL (not deployed). Redesign of the shared Lark gate + search batcher.
//
//  1. One ordered gate (concurrency + start spacing + shared cooldown). Waiters
//     are granted slots by a single scheduler, ordered by arrival time within a
//     priority class (token > read > write, with writes aged by 3 s so they
//     cannot starve). No polling, no thundering herd. A caller that re-polls
//     acquire() with the same waiterId keeps its place in line.
//  2. Batch-while-busy: a per-(table,auth,username-field) bucket stays OPEN
//     while it waits for its gate slot, so batch size grows with load.
//  3. Callers carry a deadline (expiresAt). It is checked before every page, 429
//     retry and orphan fallback, so cancelled/timed-out lookups stop consuming quota.
//  4. Fail closed: a failed/truncated page, or any row that cannot be attributed
//     to a requested username, never becomes a partial "clean" answer.
//     Oversized results are split using Lark's `total` before paging; usernames
//     that overflow on their own are remembered and run solo.
//  5. Only selective shapes (username [+ Brand is]) are merged; wide predicates
//     (Customer Approaching's Agent/Inquiry/Status case lookup) stay exact.
//  6. 429 (code 1254290 recognised on ANY HTTP status) -> bounded retry after a
//     shared cooldown; start spacing backs off multiplicatively and recovers slowly.
//  7. Usernames that normalise identically (case/whitespace) are never co-batched,
//     and repeated attribution failures switch batching off for that table for 5 min.

type Env = { MY_DURABLE_OBJECT: DurableObjectNamespace<MyDurableObject> } & Record<string, unknown>;
type Klass = "token" | "read" | "write";
type PermitResult = { ticket: string | null; retryAfterMs: number };
type SearchBatchInput = { url: string; method: string; headers: Record<string, string>; body: string; expiresAt?: number };
type SearchBatchResult = { status: number; statusText: string; headers: [string, string][]; body: string };
type Waiter = {
  input: SearchBatchInput; body: any; usernameField: string; username: string;
  expiresAt: number; enqueuedAt: number; resolve: (r: SearchBatchResult) => void;
};
type Bucket = { key: string; baseKey: string; waiters: Waiter[]; createdAt: number };
type SlotEntry = { grant: () => void; cancelled: boolean; order: number };
type Poll = { slot: { promise: Promise<void>; cancel: () => void }; granted: Promise<void>; ticket: string | null; idle: ReturnType<typeof setTimeout> | null };

const MAX_USERNAMES = 50;          // Lark: filter.conditions length 0..50
const PAGE_SIZE = 500;
const MAX_PAGES = 20;              // 10,000 rows per merged query
const MAX_BISECT_DEPTH = 6;
const MIN_WINDOW_MS = 15;          // only matters when the gate is idle
const UPSTREAM_TIMEOUT_MS = 6_000;
const MAX_429_RETRIES = 2;
const MAX_COOLDOWN_MS = 5_000;
const PERMIT_LEASE_MS = 8_000;
const LONGPOLL_MS = 5_000;
const LEGACY_WAIT_MS = 150;        // below the legacy client's 250 ms RPC timeout
const POLL_IDLE_MS = 10_000;
const WRITE_AGING_MS = 3_000;
const HEAVY_MEMORY_MS = 10 * 60_000;
const ORPHAN_STRIKES = 3;
const ORPHAN_WINDOW_MS = 60_000;
const NO_BATCH_MS = 5 * 60_000;
const STAT_SAMPLES = 2_000;
const CLASS_OFFSET: Record<Klass, number> = { token: -1e9, read: 0, write: WRITE_AGING_MS };

const failure = (status: number, msg: string): SearchBatchResult => ({
  status, statusText: "", headers: [["content-type", "application/json"]],
  body: JSON.stringify({ code: -1, msg }),
});
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const norm = (value: string) => value.trim().toLowerCase();
const isRateLimited = (status: number, parsed: any) => status === 429 || Number(parsed?.code) === 99991400 || Number(parsed?.code) === 1254290
  || /too ?many ?requests?|rate.?limit/i.test(String(parsed?.msg || ""));

// Same value-unwrapping order as the Pages-side toDisplay() (value, text, name,
// link); unknown object shapes are stringified so they can never silently
// look like an empty username.
function fieldText(value: any): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((item) => fieldText(item)).filter(Boolean).join(", ");
  if (typeof value === "object") {
    if ("value" in value) return fieldText(value.value);
    if ("text" in value) return String(value.text ?? "").trim();
    if ("name" in value) return String(value.name).trim();
    if ("link" in value) return String(value.link).trim();
    return JSON.stringify(value);
  }
  return String(value).trim();
}

export class MyDurableObject extends DurableObject<Env> {
  private concurrency: number;
  private baseGapMs: number;
  private gapMs: number;
  private longPollMs: number;
  private active = 0;
  private nextStartAt = 0;
  private cooldownUntil = 0;
  private okStreak = 0;
  private waitq: SlotEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private buckets = new Map<string, Bucket>();
  private tickets = new Map<string, ReturnType<typeof setTimeout>>();
  private polls = new Map<string, Poll>();
  private heavy = new Map<string, number>();
  private orphanStrikes = new Map<string, { n: number; first: number }>();
  private noBatchUntil = new Map<string, number>();
  private recentStarts: number[] = [];
  private s = {
    upstream: 0, limited: 0, retries429: 0, batches: 0, expiredDropped: 0, bisected: 0, orphanFallbacks: 0,
    noBatchTrips: 0, peakQueue: 0, truncatedFails: 0, heavyUsers: 0, peakStartsPerSec: 0,
    startsByClass: { token: 0, read: 0, write: 0 } as Record<Klass, number>,
    batchSizes: [] as number[], queueWaitMs: [] as number[],
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.concurrency = Number(env?.GATE_CONCURRENCY) || 3;
    this.longPollMs = Number(env?.GATE_LONGPOLL_MS) || LONGPOLL_MS;
    this.baseGapMs = this.gapMs = Number(env?.GATE_START_GAP_MS) || 250;   // ship at today's pace, then ramp down
  }

  getStats() {
    const { batchSizes, queueWaitMs, ...rest } = this.s;
    const sorted = [...queueWaitMs].sort((a, b) => a - b);
    return { ...rest, gapMs: this.gapMs, queued: this.waitq.length, active: this.active, buckets: this.buckets.size,
      meanBatch: batchSizes.length ? +(batchSizes.reduce((a, b) => a + b, 0) / batchSizes.length).toFixed(1) : 0,
      queueWaitP50: sorted[Math.floor(sorted.length / 2)] ?? 0, queueWaitMax: sorted.at(-1) ?? 0 };
  }
  private sample(arr: number[], value: number) { arr.push(value); if (arr.length > STAT_SAMPLES) arr.splice(0, arr.length - STAT_SAMPLES); }

  // ---- gate -------------------------------------------------------------
  private acquireSlot(klass: Klass, since = Date.now()): { promise: Promise<void>; cancel: () => void } {
    let entry!: SlotEntry;
    const promise = new Promise<void>((grant) => { entry = { grant, cancelled: false, order: since + CLASS_OFFSET[klass] }; });
    let at = this.waitq.length;
    while (at > 0 && this.waitq[at - 1].order > entry.order) at--;       // stable insert by order
    this.waitq.splice(at, 0, entry);
    this.s.peakQueue = Math.max(this.s.peakQueue, this.waitq.length);
    promise.then(() => { this.s.startsByClass[klass]++; });
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
      this.recentStarts.push(now);
      while (this.recentStarts.length && now - this.recentStarts[0] >= 1000) this.recentStarts.shift();
      this.s.peakStartsPerSec = Math.max(this.s.peakStartsPerSec, this.recentStarts.length);
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
      let parsed: any = null;
      try { parsed = JSON.parse(body); } catch { /* HTTP status only */ }
      const limited = isRateLimited(response.status, parsed);
      if (limited) console.warn("Lark rate limit", JSON.stringify({ httpStatus: response.status, code: parsed?.code, retryAfter: response.headers.get("Retry-After"), gapMs: this.gapMs }));
      this.releaseSlot(limited, Number(response.headers.get("Retry-After")) * 1000 || 0);
      return { limited, result: { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body } };
    } catch (error) {
      this.releaseSlot(false);
      return { limited: false, result: failure(504, String((error as Error)?.message || error)) };
    }
  }

  private async fetchPage(input: SearchBatchInput, haveSlot: boolean, since: number, deadline: number): Promise<SearchBatchResult> {
    for (let attempt = 0; ; attempt++) {
      if (!haveSlot) {
        if (Date.now() >= deadline) { this.s.expiredDropped++; return failure(504, "Lark search deadline exceeded in queue."); }
        await this.acquireSlot("read", since).promise;
      }
      haveSlot = false;
      if (Date.now() >= deadline) { this.s.expiredDropped++; this.releaseSlot(false); return failure(504, "Lark search deadline exceeded in queue."); }
      const { result, limited } = await this.fetchOnce(input);
      if (!limited || attempt >= MAX_429_RETRIES) return result;
      this.s.retries429++;
    }
  }

  // ---- RPC: permits for non-search calls (token, create, update, fields) -----
  // Long-polls inside the DO. A caller that comes back with the same waiterId
  // (after its RPC timed out) keeps its original place in line.
  async acquire(kind?: Klass, waiterId?: string): Promise<PermitResult> {
    // A bare acquire() is the legacy protocol (current Pages code, 250 ms RPC timeout):
    // wait briefly, then answer "retry in N ms" instead of holding the call open.
    if (kind === undefined && waiterId === undefined) return this.acquireLegacy();
    kind = kind ?? "write";
    let poll = waiterId ? this.polls.get(waiterId) : undefined;
    if (!poll) {
      const slot = this.acquireSlot(kind === "token" || kind === "read" ? kind : "write");
      const created: Poll = { slot, ticket: null, idle: null, granted: Promise.resolve() };
      created.granted = slot.promise.then(() => {
        created.ticket = crypto.randomUUID();
        const ticket = created.ticket;
        this.tickets.set(ticket, setTimeout(() => { if (this.tickets.delete(ticket)) this.releaseSlot(false); }, PERMIT_LEASE_MS));
      });
      poll = created;
      if (waiterId) this.polls.set(waiterId, poll);
    }
    if (poll.idle) { clearTimeout(poll.idle); poll.idle = null; }
    const timedOut = await Promise.race([poll.granted.then(() => false), sleep(this.longPollMs).then(() => true)]);
    if (timedOut) {
      const current = poll;
      if (!waiterId) { current.slot.cancel(); return { ticket: null, retryAfterMs: 100 }; }
      current.idle = setTimeout(() => {                  // the caller never came back
        this.polls.delete(waiterId);
        if (!current.ticket) current.slot.cancel();
      }, POLL_IDLE_MS);
      return { ticket: null, retryAfterMs: 0 };
    }
    if (waiterId) this.polls.delete(waiterId);
    return { ticket: poll.ticket, retryAfterMs: 0 };
  }
  private async acquireLegacy(): Promise<PermitResult> {
    const slot = this.acquireSlot("write");
    let granted = false;
    void slot.promise.then(() => { granted = true; });
    const timedOut = await Promise.race([slot.promise.then(() => false), sleep(LEGACY_WAIT_MS).then(() => true)]);
    if (timedOut && !granted) { slot.cancel(); return { ticket: null, retryAfterMs: 100 }; }
    return { ticket: this.issueTicket(), retryAfterMs: 0 };
  }
  private issueTicket(): string {
    const ticket = crypto.randomUUID();
    this.tickets.set(ticket, setTimeout(() => { if (this.tickets.delete(ticket)) this.releaseSlot(false); }, PERMIT_LEASE_MS));
    return ticket;
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
    const expiresAt = Number(input.expiresAt) || Date.now() + 40_000;
    let body: any;
    try { body = JSON.parse(input.body || "{}"); } catch { return this.single(input, expiresAt); }
    const conds = body?.filter?.conditions;
    if (!Array.isArray(conds) || body?.filter?.conjunction === "or") return this.single(input, expiresAt);
    const userConds = conds.filter((c: any) => c?.operator === "is" && /^(username(?:\/uid)?|uid)$/i.test(String(c.field_name || ""))
      && Array.isArray(c.value) && c.value.length === 1);
    const others = conds.filter((c: any) => !userConds.includes(c));
    // Merge username [+ brand] shapes, and wider shapes (is / isEmpty / isNotEmpty on other
    // columns) only when the caller projected its columns: the merged query then returns
    // just those few columns for the usernames and every caller re-applies its own full
    // predicate. Without a projection a merge could drag whole row histories, so stay exact.
    const brandOnly = others.every((c: any) => c?.operator === "is" && /^brand$/i.test(String(c.field_name || "")));
    const simpleOps = others.every((c: any) => ["is", "isEmpty", "isNotEmpty"].includes(String(c?.operator || "")));
    const selective = brandOnly || (simpleOps && Array.isArray(body.field_names) && body.field_names.length > 0);
    if (userConds.length !== 1 || !selective || !String(userConds[0].value[0] ?? "")) return this.single(input, expiresAt);

    const username = String(userConds[0].value[0]);
    const url = new URL(input.url);
    const headers = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v]));
    // automatic_fields is deliberately NOT part of the key: the merged query asks for it when any
    // caller did, and the extra created_time on rows is harmless to the others.
    const baseKey = JSON.stringify([url.origin, url.pathname, headers.authorization || "", String(userConds[0].field_name),
      !!body.field_names?.length]);
    const now = Date.now();
    if ((this.noBatchUntil.get(baseKey) || 0) > now) return this.single(input, expiresAt);       // kill switch tripped
    const isHeavy = (this.heavy.get(baseKey + "|" + username) || 0) > now;
    const key = isHeavy ? `${baseKey}#solo#${username}` : baseKey;

    return new Promise<SearchBatchResult>((resolve) => {
      const waiter: Waiter = { input, body, usernameField: String(userConds[0].field_name), username, expiresAt, enqueuedAt: now, resolve };
      let bucket = this.buckets.get(key);
      if (!bucket) { bucket = { key, baseKey, waiters: [], createdAt: now }; this.buckets.set(key, bucket); void this.runBucket(bucket); }
      bucket.waiters.push(waiter);
    });
  }

  private async single(input: SearchBatchInput, expiresAt: number): Promise<SearchBatchResult> {
    const since = Date.now();
    if (since >= expiresAt) { this.s.expiredDropped++; return failure(504, "Lark search deadline exceeded in queue."); }
    return this.fetchPage(input, false, since, expiresAt);
  }

  private async runBucket(bucket: Bucket): Promise<void> {
    if (bucket.createdAt) {                              // collection window happens BEFORE taking a slot
      const wait = bucket.createdAt + MIN_WINDOW_MS - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const since = Math.min(...bucket.waiters.map((w) => w.enqueuedAt), Date.now());
    await this.acquireSlot("read", since).promise;       // bucket stays open (in this.buckets) until now
    if (this.buckets.get(bucket.key) === bucket) this.buckets.delete(bucket.key);   // close: later arrivals open a new bucket

    const now = Date.now();
    const live: Waiter[] = [];
    for (const w of bucket.waiters) {
      if (w.expiresAt <= now) { this.s.expiredDropped++; w.resolve(failure(504, "Lark search deadline exceeded in queue.")); } else live.push(w);
    }
    if (!live.length) { this.releaseSlot(false); return; }

    // Up to MAX_USERNAMES distinct usernames; usernames that normalise the same
    // (case/whitespace) are never co-batched; the rest re-queue keeping their age.
    const byUser = new Map<string, Waiter[]>();
    const rawByNorm = new Map<string, string>();
    const leftover: Waiter[] = [];
    for (const w of live) {
      const list = byUser.get(w.username);
      if (list) { list.push(w); continue; }
      const existing = rawByNorm.get(norm(w.username));
      if (byUser.size >= MAX_USERNAMES || (existing !== undefined && existing !== w.username)) { leftover.push(w); continue; }
      rawByNorm.set(norm(w.username), w.username);
      byUser.set(w.username, [w]);
    }
    if (leftover.length) this.requeue(bucket, leftover);
    await this.execute(bucket.baseKey, [...byUser.entries()], since, 0);
  }

  private requeue(from: Bucket, waiters: Waiter[]): void {
    let bucket = this.buckets.get(from.key);
    if (bucket) { bucket.waiters.unshift(...waiters); return; }
    bucket = { key: from.key, baseKey: from.baseKey, waiters, createdAt: 0 };
    this.buckets.set(from.key, bucket);
    void this.runBucket(bucket);
  }

  // The first page uses the slot runBucket (or executeAfterSlot) already holds.
  private async execute(baseKey: string, chunk: Array<[string, Waiter[]]>, since: number, depth: number): Promise<void> {
    const first = chunk[0][1][0];
    const usernameField = first.usernameField;
    const usernames = new Set(chunk.map(([u]) => u));
    const allWaiters = chunk.flatMap(([, w]) => w);
    const deadline = Math.max(...allWaiters.map((w) => w.expiresAt));
    const startedAt = Date.now();
    for (const w of allWaiters) this.sample(this.s.queueWaitMs, startedAt - w.enqueuedAt);
    this.s.batches++; this.sample(this.s.batchSizes, usernames.size);

    const unionFields = chunk.some(([, ws]) => ws.some((w) => !w.body.field_names?.length)) ? null
      : [...new Set([usernameField, ...allWaiters.flatMap((w) => [...(w.body.field_names || []),
          ...(w.body.filter?.conditions || []).map((c: any) => c.field_name).filter(Boolean)])])];
    const merged = JSON.stringify({
      filter: { conjunction: "or", conditions: [...usernames].map((u) => ({ field_name: usernameField, operator: "is", value: [u] })) },
      automatic_fields: allWaiters.some((w) => !!w.body.automatic_fields),
      ...(unionFields ? { field_names: unionFields } : {}),
    });
    const baseUrl = new URL(first.input.url);
    baseUrl.searchParams.set("page_size", String(PAGE_SIZE));

    const rows: any[] = [];
    let pageToken = "";
    let more = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (Date.now() >= deadline) { for (const w of allWaiters) w.resolve(failure(504, "Lark search deadline exceeded.")); this.s.expiredDropped += allWaiters.length; return; }
      const pageUrl = new URL(baseUrl);
      pageUrl.searchParams.delete("page_token");
      if (pageToken) pageUrl.searchParams.set("page_token", pageToken);
      const result = await this.fetchPage({ ...first.input, url: pageUrl.toString(), body: merged }, page === 0, since, deadline);
      let parsed: any = null;
      try { parsed = JSON.parse(result.body); } catch { /* handled below */ }
      if (result.status < 200 || result.status >= 300 || !parsed || parsed.code !== 0) {
        for (const w of allWaiters) w.resolve(result);   // never a partial answer
        return;
      }
      rows.push(...(parsed.data?.items || []));
      more = !!parsed.data?.has_more && !!parsed.data?.page_token;
      if (!more) break;
      // Lark reports `total` on the first page: split BEFORE spending pages on a result that cannot fit.
      const total = Number(parsed.data?.total);
      if (page === 0 && Number.isFinite(total) && total > MAX_PAGES * PAGE_SIZE) break;
      pageToken = String(parsed.data.page_token);
    }
    if (more) {
      this.s.truncatedFails++;
      if (chunk.length > 1 && depth < MAX_BISECT_DEPTH) {                // one heavy user must not fail the others
        this.s.bisected++;
        const mid = Math.ceil(chunk.length / 2);
        await Promise.all([chunk.slice(0, mid), chunk.slice(mid)].map(async (half) => {
          await this.acquireSlot("read", since).promise;
          return this.execute(baseKey, half, since, depth + 1);
        }));
        return;
      }
      if (chunk.length === 1) { this.heavy.set(baseKey + "|" + chunk[0][0], Date.now() + HEAVY_MEMORY_MS); this.s.heavyUsers++; }
      for (const w of allWaiters) w.resolve(failure(502, `Lark search exceeded ${MAX_PAGES * PAGE_SIZE} rows${chunk.length === 1 ? " for one username" : ""}; refusing a partial result.`));
      return;
    }

    // Attribution check: every row must belong to a requested username, else
    // normalisation differs from Lark's `is` and splitting could silently drop rows.
    const seen = new Set<string>();
    const per = new Map<string, any[]>();
    let orphan = false;
    for (const row of rows) {
      if (row.record_id && seen.has(row.record_id)) continue;
      if (row.record_id) seen.add(row.record_id);
      const text = fieldText(row?.fields?.[usernameField]);
      if (!usernames.has(text)) { orphan = true; break; }
      (per.get(text) || per.set(text, []).get(text)!).push(row);
    }
    if (orphan) {
      this.s.orphanFallbacks++;
      this.recordOrphan(baseKey);
      await Promise.all(allWaiters.map(async (w) => w.resolve(await this.single(w.input, w.expiresAt))));
      return;
    }
    const ok = (items: any[]): SearchBatchResult => ({
      status: 200, statusText: "OK", headers: [["content-type", "application/json"], ["x-lark-batched", "1"]],
      body: JSON.stringify({ code: 0, data: { items, has_more: false, page_token: "" } }),
    });
    for (const [username, ws] of chunk) { const body = ok(per.get(username) || []); for (const w of ws) w.resolve(body); }
  }

  private recordOrphan(baseKey: string): void {
    const now = Date.now();
    const entry = this.orphanStrikes.get(baseKey);
    if (!entry || now - entry.first > ORPHAN_WINDOW_MS) { this.orphanStrikes.set(baseKey, { n: 1, first: now }); return; }
    entry.n++;
    if (entry.n >= ORPHAN_STRIKES) {
      this.noBatchUntil.set(baseKey, now + NO_BATCH_MS);
      this.orphanStrikes.delete(baseKey);
      this.s.noBatchTrips++;
      console.warn("Lark batching disabled for table after repeated attribution mismatches", baseKey.slice(0, 120));
    }
  }
}

export default {
  async fetch(): Promise<Response> { return new Response("Not found", { status: 404 }); },
} satisfies ExportedHandler<Env>;
