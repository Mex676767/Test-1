class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }

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
type CreateWaiter = { input: SearchBatchInput; fields: Record<string, unknown>; expiresAt: number; enqueuedAt: number; resolve: (r: SearchBatchResult) => void };
type CreateBucket = { key: string; waiters: CreateWaiter[]; createdAt: number };
type Grant = { klass: Klass; at: number };                       // a granted slot: which class, and when (for hold-time stats)
type SlotEntry = { grant: (g: Grant) => void; cancelled: boolean; order: number; klass: Klass; requestedAt: number };
type CallType = "search" | "batchCreate" | "create" | "other";
type Slot = { promise: Promise<Grant>; cancel: () => void };
type Poll = { slot: Slot; granted: Promise<void>; ticket: string | null; idle: ReturnType<typeof setTimeout> | null };
type Ticket = { timer: ReturnType<typeof setTimeout>; grant: Grant };

const MAX_USERNAMES = 50;          // Lark: filter.conditions length 0..50
const PAGE_SIZE = 500;
const MAX_PAGES = 20;              // 10,000 rows per merged query
const MAX_BISECT_DEPTH = 6;
const MIN_WINDOW_MS = 15;          // only matters when the gate is idle
const UPSTREAM_TIMEOUT_MS = 6_000;     // searches
const WRITE_TIMEOUT_MS = 15_000;       // creates / other writes (Env GATE_WRITE_TIMEOUT_MS overrides, for tests)
const CREATE_MEMORY_MS = 120_000;      // identical creates within this window share ONE row (Env CREATE_MEMORY_MS; 0 = off)
const CREATE_MEMORY_MAX = 2_000;
const WRITE_RETRIES = 1;               // one retry of a timed-out / 5xx create, with the SAME client_token
const MAX_429_RETRIES = 2;
const MAX_COOLDOWN_MS = 5_000;
const PERMIT_LEASE_MS = 8_000;
const LONGPOLL_MS = 5_000;
const MAX_CREATE_BATCH = 100;      // Lark allows 1,000; stay small so one bad batch is cheap
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
// Results that came from a timeout / transport error / HTTP 5xx on a real upstream call (not from our own queue
// deadline): the only failures worth retrying, and only for idempotent (client_token) writes.
const upstreamFailures = new WeakSet<SearchBatchResult>();
const callType = (input: SearchBatchInput): CallType => {
  let path = "";
  try { path = new URL(input.url).pathname; } catch { /* unknown */ }
  if (/\/records\/batch_create$/.test(path)) return "batchCreate";
  if (/\/records\/search$/.test(path)) return "search";
  if (/\/records$/.test(path) && (input.method || "POST").toUpperCase() === "POST") return "create";
  return "other";
};
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0, p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0, max: sorted.at(-1) ?? 0 };
};
const canonicalFields = (fields: Record<string, unknown>) => JSON.stringify(Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const createdRecord = (result: SearchBatchResult): any | null => {
  if (result.status < 200 || result.status >= 300) return null;
  try { const parsed = JSON.parse(result.body); return parsed?.code === 0 && parsed.data?.record?.record_id ? parsed.data.record : null; } catch { return null; }
};
const okRecord = (record: any): SearchBatchResult => ({
  status: 200, statusText: "OK", headers: [["content-type", "application/json"]],
  body: JSON.stringify({ code: 0, data: { record } }),
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
  private tickets = new Map<string, Ticket>();
  private polls = new Map<string, Poll>();
  private heavy = new Map<string, number>();
  private orphanStrikes = new Map<string, { n: number; first: number }>();
  private noBatchUntil = new Map<string, number>();
  private createBuckets = new Map<string, CreateBucket>();
  private pendingCreates = new Map<string, Promise<SearchBatchResult>>();                   // identical creates in flight -> share the result
  private recentCreates = new Map<string, { record: any; at: number }>();                   // identical creates already done -> same row
  private recordIndex = new Map<string, string>();                                          // record_id -> recentCreates key (for forgetCreated)
  private writeTimeoutMs: number;
  private createMemoryMs: number;
  // Diagnostics only (no behaviour depends on these): permit wait (acquire -> grant) and hold (grant -> release) per
  // class, and the latency of each kind of upstream Lark call. Bounded like the other samples.
  private m = {
    waitMs: { token: [] as number[], read: [] as number[], write: [] as number[] } as Record<Klass, number[]>,
    holdMs: { token: [] as number[], read: [] as number[], write: [] as number[] } as Record<Klass, number[]>,
    larkMs: { search: [] as number[], batchCreate: [] as number[], create: [] as number[], other: [] as number[] } as Record<CallType, number[]>,
  };
  private recentStarts: number[] = [];
  private pruneCounter = 0;
  private s = {
    upstream: 0, limited: 0, retries429: 0, batches: 0, expiredDropped: 0, bisected: 0, orphanFallbacks: 0, createBatches: 0, createdInBatches: 0, createMismatches: 0, createMemoryHits: 0, createSharedInflight: 0, writeRetries: 0,
    noBatchTrips: 0, peakQueue: 0, truncatedFails: 0, heavyUsers: 0, peakStartsPerSec: 0,
    startsByClass: { token: 0, read: 0, write: 0 } as Record<Klass, number>,
    batchSizes: [] as number[], queueWaitMs: [] as number[],
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.concurrency = Number(env?.GATE_CONCURRENCY) || 3;
    this.longPollMs = Number(env?.GATE_LONGPOLL_MS) || LONGPOLL_MS;
    this.baseGapMs = this.gapMs = Number(env?.GATE_START_GAP_MS) || 250;   // ship at today's pace, then ramp down
    this.writeTimeoutMs = Number(env?.GATE_WRITE_TIMEOUT_MS) || WRITE_TIMEOUT_MS;
    this.createMemoryMs = env?.CREATE_MEMORY_MS !== undefined ? Number(env.CREATE_MEMORY_MS) : CREATE_MEMORY_MS;
  }

  getMapSizes() { return { heavy: this.heavy.size, noBatch: this.noBatchUntil.size, orphanStrikes: this.orphanStrikes.size }; }
  getStats() {
    const { batchSizes, queueWaitMs, ...rest } = this.s;
    const sorted = [...queueWaitMs].sort((a, b) => a - b);
    return { ...rest, gapMs: this.gapMs, queued: this.waitq.length, active: this.active, buckets: this.buckets.size,
      meanBatch: batchSizes.length ? +(batchSizes.reduce((a, b) => a + b, 0) / batchSizes.length).toFixed(1) : 0,
      queueWaitP50: sorted[Math.floor(sorted.length / 2)] ?? 0, queueWaitMax: sorted.at(-1) ?? 0,
      // ms. wait = permit requested -> granted; hold = granted -> released (for ticketed calls this is the caller's whole Lark call).
      permits: Object.fromEntries((["token", "read", "write"] as Klass[]).map((k) => [k, { wait: summary(this.m.waitMs[k]), hold: summary(this.m.holdMs[k]) }])),
      lark: Object.fromEntries((["search", "batchCreate", "create", "other"] as CallType[]).map((t) => [t, summary(this.m.larkMs[t])])) };
  }
  private sample(arr: number[], value: number) { arr.push(value); if (arr.length > STAT_SAMPLES) arr.splice(0, arr.length - STAT_SAMPLES); }

  // ---- gate -------------------------------------------------------------
  private acquireSlot(klass: Klass, since = Date.now()): Slot {
    let entry!: SlotEntry;
    const requestedAt = Date.now();
    const promise = new Promise<Grant>((grant) => { entry = { grant, cancelled: false, order: since + CLASS_OFFSET[klass], klass, requestedAt }; });
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
      this.sample(this.m.waitMs[head.klass], now - head.requestedAt);
      head.grant({ klass: head.klass, at: now });
    }
  }

  private releaseSlot(limited: boolean, retryAfterMs = 0, grant: Grant | null = null): void {
    if (grant) this.sample(this.m.holdMs[grant.klass], Date.now() - grant.at);
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
  private async fetchOnce(input: SearchBatchInput, grant: Grant | null, timeoutMs: number): Promise<{ result: SearchBatchResult; limited: boolean }> {
    this.s.upstream++;
    const startedAt = Date.now();
    const type = callType(input);
    try {
      const response = await fetch(input.url, {
        method: input.method || "POST", headers: input.headers, body: input.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.text();
      let parsed: any = null;
      try { parsed = JSON.parse(body); } catch { /* HTTP status only */ }
      const limited = isRateLimited(response.status, parsed);
      if (limited) console.warn("Lark rate limit", JSON.stringify({ httpStatus: response.status, code: parsed?.code, retryAfter: response.headers.get("Retry-After"), gapMs: this.gapMs }));
      this.sample(this.m.larkMs[type], Date.now() - startedAt);
      this.releaseSlot(limited, Number(response.headers.get("Retry-After")) * 1000 || 0, grant);
      const result: SearchBatchResult = { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body };
      if (response.status >= 500) upstreamFailures.add(result);
      return { limited, result };
    } catch (error) {
      this.sample(this.m.larkMs[type], Date.now() - startedAt);
      this.releaseSlot(false, 0, grant);
      const result = failure(504, String((error as Error)?.message || error));
      upstreamFailures.add(result);
      return { limited: false, result };
    }
  }

  // `held` is a slot the caller already holds (used for the first attempt only); null = acquire one.
  private async fetchPage(input: SearchBatchInput, held: Grant | null, since: number, deadline: number, klass: Klass = "read"): Promise<SearchBatchResult> {
    for (let attempt = 0; ; attempt++) {
      let grant = held;
      held = null;
      if (!grant) {
        if (Date.now() >= deadline) { this.s.expiredDropped++; return failure(504, "Lark search deadline exceeded in queue."); }
        grant = await this.acquireSlot(klass, since).promise;   // a retried write keeps WRITE priority
      }
      if (Date.now() >= deadline) { this.s.expiredDropped++; this.releaseSlot(false, 0, grant); return failure(504, "Lark search deadline exceeded in queue."); }
      const { result, limited } = await this.fetchOnce(input, grant, klass === "write" ? this.writeTimeoutMs : UPSTREAM_TIMEOUT_MS);
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
      created.granted = slot.promise.then((grant) => {
        created.ticket = this.issueTicket(grant);
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
    let granted: Grant | null = null;
    void slot.promise.then((grant) => { granted = grant; });
    const timedOut = await Promise.race([slot.promise.then(() => false), sleep(LEGACY_WAIT_MS).then(() => true)]);
    if (timedOut && !granted) { slot.cancel(); return { ticket: null, retryAfterMs: 100 }; }
    return { ticket: this.issueTicket(granted ?? await slot.promise), retryAfterMs: 0 };
  }
  private issueTicket(grant: Grant): string {
    const ticket = crypto.randomUUID();
    this.tickets.set(ticket, {
      timer: setTimeout(() => { const t = this.tickets.get(ticket); if (t && this.tickets.delete(ticket)) this.releaseSlot(false, 0, t.grant); }, PERMIT_LEASE_MS),
      grant,
    });
    return ticket;
  }
  async release(ticket: string, rateLimited = false, retryAfterMs = 0): Promise<void> {
    const t = this.tickets.get(ticket);
    if (!t) return;
    clearTimeout(t.timer); this.tickets.delete(ticket);
    this.releaseSlot(rateLimited, retryAfterMs, t.grant);
  }
  async penalize(retryAfterMs = 0): Promise<void> {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + Math.min(MAX_COOLDOWN_MS, Math.max(1_000, retryAfterMs)));
  }

  // ---- RPC: searches ------------------------------------------------------
  async searchBatch(input: SearchBatchInput): Promise<SearchBatchResult> {
    const expiresAt = Number(input.expiresAt) || Date.now() + 40_000;
    let body: any;
    try { body = JSON.parse(input.body || "{}"); } catch { return this.single(input, expiresAt); }
    // A request that already carries a page_token is the CALLER following an unbatched reply's
    // has_more. Merging it would restart at page 1 and hand back rows it already has.
    try { if (new URL(input.url).searchParams.has("page_token")) return this.single(input, expiresAt); } catch { return this.single(input, expiresAt); }
    if (++this.pruneCounter % 50 === 0) this.pruneExpired();
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
    const noBatch = this.noBatchUntil.get(baseKey);
    if (noBatch !== undefined) {
      if (noBatch > now) return this.single(input, expiresAt);                                    // kill switch tripped
      this.noBatchUntil.delete(baseKey);                                                          // expired: forget it
    }
    const heavyUntil = this.heavy.get(baseKey + "|" + username);
    if (heavyUntil !== undefined && heavyUntil <= now) this.heavy.delete(baseKey + "|" + username);
    const isHeavy = heavyUntil !== undefined && heavyUntil > now;
    const key = isHeavy ? `${baseKey}#solo#${username}` : baseKey;

    return new Promise<SearchBatchResult>((resolve) => {
      const waiter: Waiter = { input, body, usernameField: String(userConds[0].field_name), username, expiresAt, enqueuedAt: now, resolve };
      let bucket = this.buckets.get(key);
      if (!bucket) { bucket = { key, baseKey, waiters: [], createdAt: now }; this.buckets.set(key, bucket); void this.runBucket(bucket); }
      bucket.waiters.push(waiter);
    });
  }

  // ---- RPC: record creation, coalesced into batch_create ---------------------
  // Lark documents neither atomicity nor result ORDER for batch_create, so every returned
  // record is matched to its caller by the columns that caller sent (never by position).
  // Anything that does not map one-to-one fails closed: callers get an error, and a retried
  // lookup reuses any blank row that did land (it never creates a second one).
  async createBatch(input: SearchBatchInput): Promise<SearchBatchResult> {
    const expiresAt = Number(input.expiresAt) || Date.now() + 40_000;
    let parsed: any;
    try { parsed = JSON.parse(input.body || "{}"); } catch { return this.singleWrite(input, expiresAt); }
    const url = new URL(input.url);
    const supported = parsed && typeof parsed.fields === "object" && parsed.fields && Object.keys(parsed).length === 1
      && /\/tables\/[^/]+\/records$/.test(url.pathname) && (input.method || "POST").toUpperCase() === "POST";
    if (!supported) return this.singleWrite(input, expiresAt);
    const headers = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const key = JSON.stringify([url.origin, url.pathname, headers.authorization || ""]);

    // Identical creates (same table, same fields) get ONE Lark row and the SAME record id: a concurrent repeat shares the
    // in-flight create, a near-simultaneous repeat (within CREATE_MEMORY_MS) is answered from memory with no Lark call.
    // Only creates that carry a chat link are merged: the link is what identifies the chat, so two creates without one
    // could be two different chats of the same player and must stay two rows.
    const mergeKey = this.createMemoryMs > 0 && fieldText((parsed.fields as any).link)
      ? JSON.stringify([url.origin, url.pathname, canonicalFields(parsed.fields)]) : "";
    if (mergeKey) {
      this.pruneCreates();
      const remembered = this.recentCreates.get(mergeKey);
      if (remembered && Date.now() - remembered.at <= this.createMemoryMs) { this.s.createMemoryHits++; return okRecord(remembered.record); }
      const pending = this.pendingCreates.get(mergeKey);
      if (pending) { this.s.createSharedInflight++; return pending; }
    }
    const run = new Promise<SearchBatchResult>((resolve) => {
      const waiter: CreateWaiter = { input, fields: parsed.fields, expiresAt, enqueuedAt: Date.now(), resolve };
      let bucket = this.createBuckets.get(key);
      if (!bucket) { bucket = { key, waiters: [], createdAt: Date.now() }; this.createBuckets.set(key, bucket); void this.runCreateBucket(bucket); }
      bucket.waiters.push(waiter);
    });
    if (!mergeKey) return run;
    const tracked = run.then((result) => {
      this.pendingCreates.delete(mergeKey);
      const record = createdRecord(result);
      if (record) { this.recentCreates.set(mergeKey, { record, at: Date.now() }); this.recordIndex.set(String(record.record_id), mergeKey); }
      return result;
    });
    this.pendingCreates.set(mergeKey, tracked);
    return tracked;
  }

  // The Pages side calls this when it deletes or updates a row it created, so a later identical create can never be
  // answered with a row that has since been removed or completed.
  async forgetCreated(recordId: string): Promise<void> {
    const key = this.recordIndex.get(String(recordId));
    if (key === undefined) return;
    this.recordIndex.delete(String(recordId));
    this.recentCreates.delete(key);
  }

  private pruneCreates(): void {
    const now = Date.now();
    // Entries are inserted in time order, so the expired ones are at the front of the map.
    for (const [key, entry] of this.recentCreates) { if (now - entry.at <= this.createMemoryMs) break; this.dropCreate(key); }
    while (this.recentCreates.size > CREATE_MEMORY_MAX) this.dropCreate(this.recentCreates.keys().next().value as string);
  }
  private dropCreate(key: string): void {
    const entry = this.recentCreates.get(key);
    this.recentCreates.delete(key);
    if (entry) this.recordIndex.delete(String(entry.record.record_id));
  }

  private async singleWrite(input: SearchBatchInput, expiresAt: number): Promise<SearchBatchResult> {
    const since = Date.now();
    if (since >= expiresAt) { this.s.expiredDropped++; return failure(504, "Lark write deadline exceeded in queue."); }
    const grant = await this.acquireSlot("write", since).promise;
    return this.fetchPage(input, grant, since, expiresAt, "write");
  }

  private async runCreateBucket(bucket: CreateBucket): Promise<void> {
    if (bucket.createdAt) {
      const wait = bucket.createdAt + MIN_WINDOW_MS - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const since = Math.min(...bucket.waiters.map((w) => w.enqueuedAt), Date.now());
    const grant = await this.acquireSlot("write", since).promise;      // stays open (batching) until the slot is granted
    if (this.createBuckets.get(bucket.key) === bucket) this.createBuckets.delete(bucket.key);
    const now = Date.now();
    const live: CreateWaiter[] = [];
    for (const w of bucket.waiters) {
      if (w.expiresAt <= now) { this.s.expiredDropped++; w.resolve(failure(504, "Lark write deadline exceeded in queue.")); } else live.push(w);
    }
    if (!live.length) { this.releaseSlot(false, 0, grant); return; }
    const batch = live.slice(0, MAX_CREATE_BATCH);
    const leftover = live.slice(MAX_CREATE_BATCH);
    if (leftover.length) {
      let next = this.createBuckets.get(bucket.key);
      if (next) next.waiters.unshift(...leftover);
      else { next = { key: bucket.key, waiters: leftover, createdAt: 0 }; this.createBuckets.set(bucket.key, next); void this.runCreateBucket(next); }
    }
    await this.executeCreates(batch, since, grant);
  }

  // A create (single or batch) carries a client_token so Lark treats a repeat as the same request. A timeout / transport
  // error / 5xx is retried ONCE with the same token: if the first attempt did write, the retry returns that result
  // instead of making a second row.
  private async writeWithToken(input: SearchBatchInput, grant: Grant, since: number, deadline: number): Promise<SearchBatchResult> {
    const url = new URL(input.url);
    if (!url.searchParams.has("client_token")) url.searchParams.set("client_token", crypto.randomUUID());
    const withToken: SearchBatchInput = { ...input, url: url.toString() };
    let result = await this.fetchPage(withToken, grant, since, deadline, "write");
    for (let retry = 0; retry < WRITE_RETRIES && upstreamFailures.has(result) && Date.now() < deadline - 1_000; retry++) {
      this.s.writeRetries++;
      result = await this.fetchPage(withToken, null, since, deadline, "write");
    }
    return result;
  }

  private async executeCreates(batch: CreateWaiter[], since: number, grant: Grant): Promise<void> {
    const deadline = Math.max(...batch.map((w) => w.expiresAt));
    for (const w of batch) this.sample(this.s.queueWaitMs, Date.now() - w.enqueuedAt);
    if (batch.length === 1) {                            // a lone create stays an ordinary create
      batch[0].resolve(await this.writeWithToken(batch[0].input, grant, since, deadline));
      return;
    }
    this.s.createBatches++;
    const url = new URL(batch[0].input.url);
    url.pathname = url.pathname.replace(/\/records$/, "/records/batch_create");
    const result = await this.writeWithToken({
      ...batch[0].input, url: url.toString(), method: "POST",
      body: JSON.stringify({ records: batch.map((w) => ({ fields: w.fields })) }),
    }, grant, since, deadline);
    let parsed: any = null;
    try { parsed = JSON.parse(result.body); } catch { /* handled below */ }
    if (result.status < 200 || result.status >= 300 || !parsed || parsed.code !== 0) {
      for (const w of batch) w.resolve(result);          // callers see Lark's own error; nothing is guessed
      return;
    }
    const returned: any[] = Array.isArray(parsed.data?.records) ? [...parsed.data.records] : [];
    const assigned: Array<any | undefined> = new Array(batch.length);
    // Match by content, not position. Callers are matched in arrival order, so two identical
    // requests simply take two identical rows.
    batch.forEach((w, i) => {
      const at = returned.findIndex((rec) => rec && rec.record_id && Object.entries(w.fields).every(([k, v]) => fieldText(rec.fields?.[k]) === fieldText(v)));
      if (at >= 0) assigned[i] = returned.splice(at, 1)[0];
    });
    if (batch.some((_, i) => !assigned[i]) || returned.length) {   // explicit loop: .some() skips holes in a sparse array
      this.s.createMismatches++;
      const miss = failure(502, "batch_create result could not be matched one-to-one to its callers; retry the lookup (an existing blank row is reused).");
      for (const w of batch) w.resolve(miss);
      return;
    }
    this.s.createdInBatches += batch.length;
    batch.forEach((w, i) => w.resolve({
      status: 200, statusText: "OK", headers: [["content-type", "application/json"]],
      body: JSON.stringify({ code: 0, data: { record: assigned[i] } }),
    }));
  }

  private async single(input: SearchBatchInput, expiresAt: number): Promise<SearchBatchResult> {
    const since = Date.now();
    if (since >= expiresAt) { this.s.expiredDropped++; return failure(504, "Lark search deadline exceeded in queue."); }
    return this.fetchPage(input, null, since, expiresAt);
  }

  private async runBucket(bucket: Bucket): Promise<void> {
    if (bucket.createdAt) {                              // collection window happens BEFORE taking a slot
      const wait = bucket.createdAt + MIN_WINDOW_MS - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const since = Math.min(...bucket.waiters.map((w) => w.enqueuedAt), Date.now());
    const grant = await this.acquireSlot("read", since).promise;       // bucket stays open (in this.buckets) until now
    if (this.buckets.get(bucket.key) === bucket) this.buckets.delete(bucket.key);   // close: later arrivals open a new bucket

    const now = Date.now();
    const live: Waiter[] = [];
    for (const w of bucket.waiters) {
      if (w.expiresAt <= now) { this.s.expiredDropped++; w.resolve(failure(504, "Lark search deadline exceeded in queue.")); } else live.push(w);
    }
    if (!live.length) { this.releaseSlot(false, 0, grant); return; }

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
    await this.execute(bucket.baseKey, [...byUser.entries()], since, 0, grant);
  }

  private requeue(from: Bucket, waiters: Waiter[]): void {
    let bucket = this.buckets.get(from.key);
    if (bucket) { bucket.waiters.unshift(...waiters); return; }
    bucket = { key: from.key, baseKey: from.baseKey, waiters, createdAt: 0 };
    this.buckets.set(from.key, bucket);
    void this.runBucket(bucket);
  }

  // The first page uses the slot runBucket (or executeAfterSlot) already holds.
  private async execute(baseKey: string, chunk: Array<[string, Waiter[]]>, since: number, depth: number, grant: Grant | null): Promise<void> {
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
      if (Date.now() >= deadline) {
        for (const w of allWaiters) w.resolve(failure(504, "Lark search deadline exceeded.")); this.s.expiredDropped += allWaiters.length;
        if (page === 0 && grant) this.releaseSlot(false, 0, grant);   // the caller's slot was never used: give it back (it used to leak)
        return;
      }
      const pageUrl = new URL(baseUrl);
      pageUrl.searchParams.delete("page_token");
      if (pageToken) pageUrl.searchParams.set("page_token", pageToken);
      const result = await this.fetchPage({ ...first.input, url: pageUrl.toString(), body: merged }, page === 0 ? grant : null, since, deadline);
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
          const halfGrant = await this.acquireSlot("read", since).promise;
          return this.execute(baseKey, half, since, depth + 1, halfGrant);
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

  // Entries are removed when read after expiry, and swept here every 50 searches so keys that
  // are never read again cannot accumulate for the life of the object.
  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, until] of this.heavy) if (until <= now) this.heavy.delete(key);
    for (const [key, until] of this.noBatchUntil) if (until <= now) this.noBatchUntil.delete(key);
    for (const [key, entry] of this.orphanStrikes) if (now - entry.first > ORPHAN_WINDOW_MS) this.orphanStrikes.delete(key);
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
