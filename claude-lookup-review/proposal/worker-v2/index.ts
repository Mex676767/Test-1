import { DurableObject } from "cloudflare:workers";

type Env = { MY_DURABLE_OBJECT: DurableObjectNamespace<MyDurableObject> } & Record<string, unknown>;
type Klass = "token" | "read" | "write";
type PermitResult = { ticket: string | null; retryAfterMs: number };
type SearchBatchInput = { url: string; method: string; headers: Record<string, string>; body: string; expiresAt?: number; requestStartedAt?: number; label?: string };
type CachedCallInput = SearchBatchInput & { cacheKey: string; ttlMs: number; staleMs?: number; force?: boolean };
type SearchBatchResult = { status: number; statusText: string; headers: [string, string][]; body: string };
type Waiter = {
  input: SearchBatchInput; body: any; usernameField: string; username: string;
  expiresAt: number; enqueuedAt: number; since: number; timed: boolean; resolve: (r: SearchBatchResult) => void;
};
type Bucket = { key: string; baseKey: string; waiters: Waiter[]; createdAt: number };
type CreateWaiter = { input: SearchBatchInput; fields: Record<string, unknown>; expiresAt: number; enqueuedAt: number; since: number; timed: boolean; resolve: (r: SearchBatchResult) => void };
type CreateBucket = { key: string; waiters: CreateWaiter[]; createdAt: number };
type Grant = { klass: Klass; at: number };
type SlotEntry = { grant: (g: Grant) => void; cancelled: boolean; order: number; klass: Klass; requestedAt: number };
type CallType = "search" | "batchCreate" | "batchUpdate" | "create" | "get" | "update" | "delete" | "list" | "fields" | "other";
const CALL_TYPES: CallType[] = ["search", "batchCreate", "batchUpdate", "create", "get", "update", "delete", "list", "fields", "other"];
type Slot = { promise: Promise<Grant>; cancel: () => void };
type Poll = { slot: Slot; granted: Promise<void>; ticket: string | null; idle: ReturnType<typeof setTimeout> | null };
type Ticket = { timer: ReturnType<typeof setTimeout>; grant: Grant };

const MAX_USERNAMES = 50;
const PAGE_SIZE = 500;
const MAX_PAGES = 20;
const MAX_BISECT_DEPTH = 6;
const MIN_WINDOW_MS = 15;
const UPSTREAM_TIMEOUT_MS = 6_000;
const WRITE_TIMEOUT_MS = 15_000;
const CREATE_MEMORY_MS = 120_000;
const CREATE_MEMORY_MAX = 2_000;
const WRITE_RETRIES = 1;
const CACHE_MAX_ENTRIES = 50;
const MAX_LABELS = 24;
const MINUTE_MS = 60_000;
const RING_MINUTES = 24 * 60;
const MINUTE_WAIT_SAMPLES = 200;
const MAX_REPORT_NAMES = 64;
const TOKEN_CONCURRENCY = 4;
const BURST_OFF_MS = 60_000;
const MAX_BURST = 10;
const TOKEN_GAP_MS = 50;
const RECORD_LEVEL_UPDATE_CODES = new Set<number>([1254006, 1254015, 1254043, 1254044, 1254045, 1254060, 1254061, 1254062, 1254063, 1254064,
  1254065, 1254066, 1254067, 1254068, 1254069, 1254072, 1254074, 1254130]);
const MAX_UPDATE_BATCH = 100;
const MAX_429_RETRIES = 2;
const MAX_COOLDOWN_MS = 5_000;
const PERMIT_LEASE_MS = 8_000;
const LONGPOLL_MS = 5_000;
const MAX_CREATE_BATCH = 100;
const LEGACY_WAIT_MS = 150;
const POLL_IDLE_MS = 10_000;
const WRITE_AGING_MS = 3_000;
const HEAVY_MEMORY_MS = 10 * 60_000;
const ORPHAN_STRIKES = 3;
const ORPHAN_WINDOW_MS = 60_000;
const NO_BATCH_MS = 5 * 60_000;
const STAT_SAMPLES = 2_000;
const CLASS_OFFSET: Record<Klass, number> = { token: -1e9, read: 0, write: WRITE_AGING_MS };

const scrubSecrets = (text: unknown): string => String(text ?? "")
  .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [token]")
  .replace(/\b[tu]-[A-Za-z0-9_-]{20,}\b/g, "[token]");
const failure = (status: number, msg: string): SearchBatchResult => ({
  status, statusText: "", headers: [["content-type", "application/json"]],
  body: JSON.stringify({ code: -1, msg: scrubSecrets(msg) }),
});
const upstreamFailures = new WeakSet<SearchBatchResult>();
const callType = (input: SearchBatchInput): CallType => {
  let path = "";
  try { path = new URL(input.url).pathname; } catch { }
  const method = (input.method || "POST").toUpperCase();
  if (/\/records\/batch_create$/.test(path)) return "batchCreate";
  if (/\/records\/batch_update$/.test(path)) return "batchUpdate";
  if (/\/records\/search$/.test(path)) return "search";
  if (/\/records$/.test(path)) return method === "POST" ? "create" : "list";
  if (/\/records\/[^/]+$/.test(path)) return method === "GET" ? "get" : method === "DELETE" ? "delete" : "update";
  if (/\/fields$/.test(path)) return "fields";
  return "other";
};
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0, p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0, max: sorted.at(-1) ?? 0 };
};
const recordIdOf = (url: string): string => { try { return (new URL(url).pathname.match(/\/records\/([^/]+)$/) || [])[1] || ""; } catch { return ""; } };
const putFields = (body?: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(body || "");
    return parsed && typeof parsed.fields === "object" && parsed.fields && !Array.isArray(parsed.fields) && Object.keys(parsed).length === 1 ? parsed.fields : null;
  } catch { return null; }
};
const earlier = (a?: number, b?: number): number | undefined => (a && b ? Math.min(a, b) : a || b);
type PutJob = { input: SearchBatchInput; fields: Record<string, unknown>; waiters: Array<(r: SearchBatchResult) => void> };
type MinuteRow = { t: number; starts: number; limited: number; waitP95: number; peakQueue: number; searchP95: number; updateP95: number; tokenStarts: number; isolates: number;
  totalStarts: number; limitedSearch: number; limitedWrite: number; limitedOther: number; maxStartsPerSec: number };
type Minute = { t: number; starts: number; limited: number; peakQueue: number; waits: number[]; searchMs: number[]; updateMs: number[]; tokenStarts: number; isolates: Set<string>;
  limitedSearch: number; limitedWrite: number; limitedOther: number; maxStartsPerSec: number };
type Throttle = { label: string; httpStatus?: number; code?: unknown; retryAfter?: string | null; ratelimit?: Record<string, string>; table?: string; logId?: string };
const THROTTLE_LABELS = new Set<string>([...CALL_TYPES, "token", "ticket"]);
const WRITE_LABELS = new Set<string>(["create", "batchCreate", "update", "batchUpdate", "delete"]);
const bump = (counts: Record<string, number>, key: string, max = 24): void => {
  if (!(key in counts) && Object.keys(counts).length >= max) key = "other";
  counts[key] = (counts[key] || 0) + 1;
};
const tableIdOf = (url: string): string => { try { return (new URL(url).pathname.match(/\/tables\/([A-Za-z0-9]{1,40})(?:\/|$)/) || [])[1] || ""; } catch { return ""; } };
const throttleHeaders = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => { const key = name.toLowerCase(); if ((key.startsWith("x-ogw-ratelimit") || key === "retry-after") && Object.keys(out).length < 12) out[key] = scrubSecrets(value).slice(0, 64); });
  return out;
};
const p95Of = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : 0; };
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
  private burst = 1;
  private burstOffUntil = 0;
  private lastBurstAt = 0;
  private location: { colo: string; loc: string } | null = null;
  private locating: Promise<void> | null = null;
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
  private pendingCreates = new Map<string, Promise<SearchBatchResult>>();
  private recentCreates = new Map<string, { record: any; at: number }>();
  private recordIndex = new Map<string, string>();
  private writeTimeoutMs: number;
  private createMemoryMs: number;
  private tokenConcurrency: number;
  private tokenGapMs: number;
  private tokenActive = 0;
  private tokenNextStartAt = 0;
  private tokenCooldownUntil = 0;
  private tokenQ: SlotEntry[] = [];
  private tokenTimer: ReturnType<typeof setTimeout> | null = null;
  private m = {
    waitMs: { token: [] as number[], read: [] as number[], write: [] as number[] } as Record<Klass, number[]>,
    holdMs: { token: [] as number[], read: [] as number[], write: [] as number[] } as Record<Klass, number[]>,
    larkMs: Object.fromEntries(CALL_TYPES.map((t) => [t, [] as number[]])) as Record<CallType, number[]>,
  };
  private labels: Record<string, number> = {};
  private recordWrites = new Map<string, { running: boolean; pending: PutJob | null }>();
  private updateBuckets = new Map<string, { ready: Set<string>; running: boolean }>();
  private startedAt = Date.now();
  private ring: MinuteRow[] = [];
  private cur: Minute | null = null;
  private pagesCounters: Record<string, number> = {};
  private cache = new Map<string, { at: number; result: SearchBatchResult }>();
  private cacheInflight = new Map<string, Promise<SearchBatchResult>>();
  private recentStarts: number[] = [];
  private pruneCounter = 0;
  private s = {
    upstream: 0, limited: 0, retries429: 0, batches: 0, expiredDropped: 0, bisected: 0, orphanFallbacks: 0, createBatches: 0, createdInBatches: 0, createMismatches: 0, createMemoryHits: 0, createSharedInflight: 0, writeRetries: 0,
    cacheHits: 0, cacheShared: 0, cacheStaleServed: 0, larkCalls: 0, writesSuperseded: 0, tokenLimited: 0,
    updateBatches: 0, updatedInBatches: 0, updateSplits: 0, updateMismatches: 0, updateRecordRejects: 0, updateWholeCallErrors: 0,
    bucketBursts: 0, throttlesWhileBursting: 0,
    limitedByLabel: {} as Record<string, number>, limitedByCode: {} as Record<string, number>,
    noBatchTrips: 0, peakQueue: 0, truncatedFails: 0, heavyUsers: 0, peakStartsPerSec: 0,
    startsByClass: { token: 0, read: 0, write: 0 } as Record<Klass, number>,
    batchSizes: [] as number[], queueWaitMs: [] as number[],
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.concurrency = Number(env?.GATE_CONCURRENCY) || 3;
    this.longPollMs = Number(env?.GATE_LONGPOLL_MS) || LONGPOLL_MS;
    this.baseGapMs = this.gapMs = Number(env?.GATE_START_GAP_MS) || 250;
    this.writeTimeoutMs = Number(env?.GATE_WRITE_TIMEOUT_MS) || WRITE_TIMEOUT_MS;
    this.createMemoryMs = env?.CREATE_MEMORY_MS !== undefined ? Number(env.CREATE_MEMORY_MS) : CREATE_MEMORY_MS;
    this.burst = Math.max(1, Math.min(MAX_BURST, Math.floor(Number(env?.GATE_BURST)) || 1));
    this.tokenConcurrency = Number(env?.TOKEN_CONCURRENCY) || TOKEN_CONCURRENCY;
    this.tokenGapMs = env?.TOKEN_GAP_MS !== undefined && Number.isFinite(Number(env.TOKEN_GAP_MS)) ? Number(env.TOKEN_GAP_MS) : TOKEN_GAP_MS;
  }

  async locate(): Promise<{ colo: string; loc: string } | null> {
    if (this.location) return this.location;
    if (!this.locating) {
      this.locating = (async () => {
        try {
          const res = await fetch("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(3_000) });
          const text = await res.text();
          const pick = (key: string) => new RegExp(`^${key}=([A-Za-z0-9-]{1,16})\\s*$`, "m").exec(text)?.[1];
          const colo = pick("colo");
          if (colo) this.location = { colo, loc: pick("loc") || "" };
        } catch { } finally { this.locating = null; }
      })();
    }
    await this.locating;
    return this.location;
  }
  getMapSizes() { return { heavy: this.heavy.size, noBatch: this.noBatchUntil.size, orphanStrikes: this.orphanStrikes.size }; }
  getStats() {
    const { batchSizes, queueWaitMs, ...rest } = this.s;
    const sorted = [...queueWaitMs].sort((a, b) => a - b);
    return { ...rest, gapMs: this.gapMs, queued: this.waitq.length, active: this.active, buckets: this.buckets.size,
      meanBatch: batchSizes.length ? +(batchSizes.reduce((a, b) => a + b, 0) / batchSizes.length).toFixed(1) : 0,
      queueWaitP50: sorted[Math.floor(sorted.length / 2)] ?? 0, queueWaitMax: sorted.at(-1) ?? 0,
      permits: Object.fromEntries((["token", "read", "write"] as Klass[]).map((k) => [k, { wait: summary(this.m.waitMs[k]), hold: summary(this.m.holdMs[k]) }])),
      lark: Object.fromEntries(CALL_TYPES.map((t) => [t, summary(this.m.larkMs[t])])),
      limitedByLabel: { ...this.s.limitedByLabel }, limitedByCode: { ...this.s.limitedByCode },
      burst: { size: this.burst, effective: this.burstCapacity(Date.now()), offUntil: this.burstOffUntil > Date.now() ? new Date(this.burstOffUntil).toISOString() : null },
      location: this.location,
      labels: { ...this.labels }, cacheEntries: this.cache.size,
      tokenLane: { concurrency: this.tokenConcurrency, gapMs: this.tokenGapMs, active: this.tokenActive, queued: this.tokenQ.length },
      startedAt: new Date(this.startedAt).toISOString(), uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      pagesCounters: { ...this.pagesCounters },
      perMinute: this.perMinute() };
  }
  async reportCounters(counters: Record<string, number>, isolateId?: string): Promise<void> {
    if (typeof isolateId === "string" && /^[A-Za-z0-9-]{8,64}$/.test(isolateId)) { const mm = this.minuteNow(); if (mm.isolates.size < 500) mm.isolates.add(isolateId); }
    if (!counters || typeof counters !== "object") return;
    for (const [name, raw] of Object.entries(counters)) {
      const n = Math.min(Number(raw), 1_000_000);
      if (!/^[A-Za-z0-9:_.-]{1,48}$/.test(name) || !Number.isFinite(n) || n <= 0) continue;
      const key = name in this.pagesCounters || Object.keys(this.pagesCounters).length < MAX_REPORT_NAMES ? name : "other";
      this.pagesCounters[key] = (this.pagesCounters[key] || 0) + n;
    }
  }
  private minuteNow(): Minute {
    const t = Math.floor(Date.now() / MINUTE_MS);
    if (!this.cur || this.cur.t !== t) {
      this.closeMinute();
      this.cur = { t, starts: 0, limited: 0, peakQueue: 0, waits: [], searchMs: [], updateMs: [], tokenStarts: 0, isolates: new Set(), limitedSearch: 0, limitedWrite: 0, limitedOther: 0, maxStartsPerSec: 0 };
    }
    return this.cur;
  }
  private rowOf(m: Minute): MinuteRow {
    return { t: m.t, starts: m.starts, limited: m.limited, waitP95: p95Of(m.waits), peakQueue: m.peakQueue,
      searchP95: p95Of(m.searchMs), updateP95: p95Of(m.updateMs), tokenStarts: m.tokenStarts, isolates: m.isolates.size,
      totalStarts: m.starts + m.tokenStarts, limitedSearch: m.limitedSearch, limitedWrite: m.limitedWrite, limitedOther: m.limitedOther, maxStartsPerSec: m.maxStartsPerSec };
  }
  private closeMinute(): void {
    if (!this.cur) return;
    this.ring.push(this.rowOf(this.cur));
    this.trimRing();
    this.cur = null;
  }
  private trimRing(): void {
    const oldest = Math.floor(Date.now() / MINUTE_MS) - RING_MINUTES;
    while (this.ring.length > RING_MINUTES || (this.ring.length && this.ring[0].t <= oldest)) this.ring.shift();
  }
  private sampleMinute(type: CallType, ms: number): void {
    const mm = this.minuteNow();
    const into = type === "search" ? mm.searchMs : type === "update" || type === "batchUpdate" ? mm.updateMs : null;
    if (into && into.length < MINUTE_WAIT_SAMPLES) into.push(ms);
  }
  private perMinute() {
    this.trimRing();
    const rows = [...this.ring];
    if (this.cur) rows.push(this.rowOf(this.cur));
    return { minutes: rows.map((r) => r.t), starts: rows.map((r) => r.starts), limited: rows.map((r) => r.limited),
      waitP95: rows.map((r) => r.waitP95), peakQueue: rows.map((r) => r.peakQueue),
      searchP95: rows.map((r) => r.searchP95), updateP95: rows.map((r) => r.updateP95),
      tokenStarts: rows.map((r) => r.tokenStarts), isolates: rows.map((r) => r.isolates),
      totalStarts: rows.map((r) => r.totalStarts), limitedSearch: rows.map((r) => r.limitedSearch),
      limitedWrite: rows.map((r) => r.limitedWrite), limitedOther: rows.map((r) => r.limitedOther),
      maxStartsPerSec: rows.map((r) => r.maxStartsPerSec) };
  }
  private countLabel(label: unknown): void {
    const name = typeof label === "string" && /^[a-z0-9-]{1,24}$/.test(label) ? label : "other";
    if (!(name in this.labels) && Object.keys(this.labels).length >= MAX_LABELS) { this.labels.other = (this.labels.other || 0) + 1; return; }
    this.labels[name] = (this.labels[name] || 0) + 1;
  }
  private sample(arr: number[], value: number) { arr.push(value); if (arr.length > STAT_SAMPLES) arr.splice(0, arr.length - STAT_SAMPLES); }

  private acquireTokenSlot(): Slot {
    let entry!: SlotEntry;
    const requestedAt = Date.now();
    const promise = new Promise<Grant>((grant) => { entry = { grant, cancelled: false, order: requestedAt, klass: "token", requestedAt }; });
    this.tokenQ.push(entry);
    promise.then(() => { this.s.startsByClass.token++; });
    this.pumpToken();
    return { promise, cancel: () => { entry.cancelled = true; } };
  }
  private pumpToken(): void {
    if (this.tokenTimer) { clearTimeout(this.tokenTimer); this.tokenTimer = null; }
    while (this.tokenQ.length && this.tokenActive < this.tokenConcurrency) {
      const head = this.tokenQ[0];
      if (head.cancelled) { this.tokenQ.shift(); continue; }
      const now = Date.now();
      const at = Math.max(this.tokenNextStartAt, this.tokenCooldownUntil);
      if (at > now) { this.tokenTimer = setTimeout(() => { this.tokenTimer = null; this.pumpToken(); }, at - now); return; }
      this.tokenQ.shift();
      this.tokenActive++;
      this.tokenNextStartAt = now + this.tokenGapMs;
      this.sample(this.m.waitMs.token, now - head.requestedAt);
      this.minuteNow().tokenStarts++;
      head.grant({ klass: "token", at: now });
    }
  }

  private acquireSlot(klass: Klass, since = Date.now(), aged = true): Slot {
    if (klass === "token") return this.acquireTokenSlot();
    let entry!: SlotEntry;
    const requestedAt = Date.now();
    const offset = klass === "write" && !aged ? 0 : CLASS_OFFSET[klass];
    const promise = new Promise<Grant>((grant) => { entry = { grant, cancelled: false, order: since + offset, klass, requestedAt }; });
    let at = this.waitq.length;
    while (at > 0 && this.waitq[at - 1].order > entry.order) at--;
    this.waitq.splice(at, 0, entry);
    this.s.peakQueue = Math.max(this.s.peakQueue, this.waitq.length);
    { const mm = this.minuteNow(); mm.peakQueue = Math.max(mm.peakQueue, this.waitq.length); }
    promise.then(() => { this.s.startsByClass[klass]++; });
    this.pump();
    return { promise, cancel: () => { entry.cancelled = true; } };
  }

  private burstCapacity(now: number): number { return now < this.burstOffUntil ? 1 : this.burst; }

  private pump(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    while (this.waitq.length && this.active < this.concurrency) {
      const head = this.waitq[0];
      if (head.cancelled) { this.waitq.shift(); continue; }
      const now = Date.now();
      const capacity = this.burstCapacity(now);
      const at = Math.max(this.nextStartAt - (capacity - 1) * this.gapMs, this.cooldownUntil);
      if (at > now) { this.timer = setTimeout(() => { this.timer = null; this.pump(); }, at - now); return; }
      this.waitq.shift();
      this.active++;
      if (now < this.nextStartAt) { this.s.bucketBursts++; this.lastBurstAt = now; }
      this.nextStartAt = Math.max(this.nextStartAt, now) + this.gapMs;
      this.recentStarts.push(now);
      while (this.recentStarts.length && now - this.recentStarts[0] >= 1000) this.recentStarts.shift();
      this.s.peakStartsPerSec = Math.max(this.s.peakStartsPerSec, this.recentStarts.length);
      this.sample(this.m.waitMs[head.klass], now - head.requestedAt);
      { const mm = this.minuteNow(); mm.starts++; mm.maxStartsPerSec = Math.max(mm.maxStartsPerSec, this.recentStarts.length); if (mm.waits.length < MINUTE_WAIT_SAMPLES) mm.waits.push(now - head.requestedAt); }
      head.grant({ klass: head.klass, at: now });
    }
  }

  private noteThrottle(info: Throttle): void {
    const label = THROTTLE_LABELS.has(info.label) ? info.label : "other";
    bump(this.s.limitedByLabel, label);
    const code = info.code !== undefined && info.code !== null && info.code !== "" ? String(info.code) : info.httpStatus ? `http${info.httpStatus}` : "unknown";
    bump(this.s.limitedByCode, /^[A-Za-z0-9]{1,12}$/.test(code) ? code : "other", 16);
    const mm = this.minuteNow();
    if (label === "search") mm.limitedSearch++; else if (WRITE_LABELS.has(label)) mm.limitedWrite++; else mm.limitedOther++;
    console.warn("Lark rate limit", scrubSecrets(JSON.stringify({ label, httpStatus: info.httpStatus, code: info.code, retryAfter: info.retryAfter ?? null,
      ratelimit: info.ratelimit && Object.keys(info.ratelimit).length ? info.ratelimit : undefined, table: info.table || undefined, logId: info.logId || undefined,
      gapMs: this.gapMs, baseGapMs: this.baseGapMs, active: this.active, queued: this.waitq.length, startsLastSecond: this.recentStarts.length, tokenActive: this.tokenActive })));
  }

  private releaseSlot(limited: boolean, retryAfterMs = 0, grant: Grant | null = null, info?: Throttle): void {
    if (grant) this.sample(this.m.holdMs[grant.klass], Date.now() - grant.at);
    if (grant?.klass === "token") {
      this.tokenActive = Math.max(0, this.tokenActive - 1);
      if (limited) {
        this.s.tokenLimited++;
        this.tokenCooldownUntil = Math.max(this.tokenCooldownUntil, Date.now() + Math.min(MAX_COOLDOWN_MS, Math.max(1_000, retryAfterMs)));
        this.noteThrottle(info ?? { label: "token", retryAfter: retryAfterMs ? String(retryAfterMs / 1000) : null });
      }
      this.pumpToken();
      return;
    }
    this.active = Math.max(0, this.active - 1);
    if (limited) {
      this.s.limited++;
      this.minuteNow().limited++;
      if (this.burst > 1) {
        const t = Date.now();
        if (t - this.lastBurstAt < 5_000) this.s.throttlesWhileBursting++;
        this.burstOffUntil = t + BURST_OFF_MS;
        this.nextStartAt = Math.max(this.nextStartAt, t);
      }
      this.okStreak = 0;
      this.gapMs = Math.min(500, this.gapMs * 2);
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + Math.min(MAX_COOLDOWN_MS, Math.max(1_000, retryAfterMs)));
      this.noteThrottle(info ?? { label: "ticket", retryAfter: retryAfterMs ? String(retryAfterMs / 1000) : null });
    } else if (++this.okStreak >= 20) {
      this.okStreak = 0;
      this.gapMs = Math.max(this.baseGapMs, Math.floor(this.gapMs * 0.8));
    }
    this.pump();
  }

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
      try { parsed = JSON.parse(body); } catch { }
      const limited = isRateLimited(response.status, parsed);
      this.sample(this.m.larkMs[type], Date.now() - startedAt);
      this.sampleMinute(type, Date.now() - startedAt);
      this.releaseSlot(limited, Number(response.headers.get("Retry-After")) * 1000 || 0, grant, limited ? {
        label: type, httpStatus: response.status, code: parsed?.code, retryAfter: response.headers.get("Retry-After"),
        ratelimit: throttleHeaders(response.headers), table: tableIdOf(input.url), logId: response.headers.get("x-tt-logid") || undefined } : undefined);
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

  private async fetchPage(input: SearchBatchInput, held: Grant | null, since: number, deadline: number, klass: Klass = "read", aged = true, timeoutMs?: number): Promise<SearchBatchResult> {
    for (let attempt = 0; ; attempt++) {
      let grant = held;
      held = null;
      if (!grant) {
        if (Date.now() >= deadline) { this.s.expiredDropped++; return failure(504, "Lark search deadline exceeded in queue."); }
        grant = await this.acquireSlot(klass, since, aged).promise;
      }
      if (Date.now() >= deadline) { this.s.expiredDropped++; this.releaseSlot(false, 0, grant); return failure(504, "Lark search deadline exceeded in queue."); }
      const { result, limited } = await this.fetchOnce(input, grant, timeoutMs ?? (klass === "write" ? this.writeTimeoutMs : UPSTREAM_TIMEOUT_MS));
      if (!limited || attempt >= MAX_429_RETRIES) return result;
      this.s.retries429++;
    }
  }

  async acquire(kind?: Klass, waiterId?: string, requestStartedAt?: number, label?: string): Promise<PermitResult> {
    if (kind === undefined && waiterId === undefined) return this.acquireLegacy();
    kind = kind ?? "write";
    let poll = waiterId ? this.polls.get(waiterId) : undefined;
    if (!poll) {
      const startedAt = Number(requestStartedAt) || 0;
      this.countLabel(label);
      const slot = this.acquireSlot(kind === "token" || kind === "read" ? kind : "write", startedAt || Date.now(), !startedAt);
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
      current.idle = setTimeout(() => {
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

  async searchBatch(input: SearchBatchInput): Promise<SearchBatchResult> {
    const expiresAt = Number(input.expiresAt) || Date.now() + 40_000;
    let body: any;
    try { body = JSON.parse(input.body || "{}"); } catch { return this.single(input, expiresAt); }
    try { if (new URL(input.url).searchParams.has("page_token")) return this.single(input, expiresAt); } catch { return this.single(input, expiresAt); }
    if (++this.pruneCounter % 50 === 0) this.pruneExpired();
    const conds = body?.filter?.conditions;
    if (!Array.isArray(conds) || body?.filter?.conjunction === "or") return this.single(input, expiresAt);
    const userConds = conds.filter((c: any) => c?.operator === "is" && /^(username(?:\/uid)?|uid)$/i.test(String(c.field_name || ""))
      && Array.isArray(c.value) && c.value.length === 1);
    const others = conds.filter((c: any) => !userConds.includes(c));
    const brandOnly = others.every((c: any) => c?.operator === "is" && /^brand$/i.test(String(c.field_name || "")));
    const simpleOps = others.every((c: any) => ["is", "isEmpty", "isNotEmpty"].includes(String(c?.operator || "")));
    const selective = brandOnly || (simpleOps && Array.isArray(body.field_names) && body.field_names.length > 0);
    if (userConds.length !== 1 || !selective || !String(userConds[0].value[0] ?? "")) return this.single(input, expiresAt);

    const username = String(userConds[0].value[0]);
    const url = new URL(input.url);
    const headers = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const baseKey = JSON.stringify([url.origin, url.pathname, headers.authorization || "", String(userConds[0].field_name),
      !!body.field_names?.length]);
    const now = Date.now();
    const noBatch = this.noBatchUntil.get(baseKey);
    if (noBatch !== undefined) {
      if (noBatch > now) return this.single(input, expiresAt);
      this.noBatchUntil.delete(baseKey);
    }
    const heavyUntil = this.heavy.get(baseKey + "|" + username);
    if (heavyUntil !== undefined && heavyUntil <= now) this.heavy.delete(baseKey + "|" + username);
    const isHeavy = heavyUntil !== undefined && heavyUntil > now;
    const key = isHeavy ? `${baseKey}#solo#${username}` : baseKey;

    return new Promise<SearchBatchResult>((resolve) => {
      const startedAt = Number(input.requestStartedAt) || 0;
      this.countLabel(input.label || "search");
      const waiter: Waiter = { input, body, usernameField: String(userConds[0].field_name), username, expiresAt, enqueuedAt: now, since: startedAt || now, timed: !!startedAt, resolve };
      let bucket = this.buckets.get(key);
      if (!bucket) { bucket = { key, baseKey, waiters: [], createdAt: now }; this.buckets.set(key, bucket); void this.runBucket(bucket); }
      bucket.waiters.push(waiter);
    });
  }

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
      const startedAt = Number(input.requestStartedAt) || 0;
      this.countLabel(input.label || "create");
      const waiter: CreateWaiter = { input, fields: parsed.fields, expiresAt, enqueuedAt: Date.now(), since: startedAt || Date.now(), timed: !!startedAt, resolve };
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

  async forgetCreated(recordId: string): Promise<void> { this.dropRecord(recordId); }
  private dropRecord(recordId: string): void {
    const key = this.recordIndex.get(String(recordId));
    if (key === undefined) return;
    this.recordIndex.delete(String(recordId));
    this.recentCreates.delete(key);
  }

  private pruneCreates(): void {
    const now = Date.now();
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

  async larkCall(input: SearchBatchInput): Promise<SearchBatchResult> {
    const method = (input.method || "GET").toUpperCase();
    const klass: Klass = method === "GET" ? "read" : "write";
    const startedAt = Number(input.requestStartedAt) || 0;
    const since = startedAt || Date.now();
    const expiresAt = Number(input.expiresAt) || Date.now() + 40_000;
    this.s.larkCalls++;
    this.countLabel(input.label || callType(input));
    if (method === "PUT") {
      const fields = putFields(input.body);
      if (fields && recordIdOf(input.url)) return this.coalescePut(new URL(input.url).pathname, input, fields);
    }
    return this.runLarkCall(input);
  }

  private coalescePut(key: string, input: SearchBatchInput, fields: Record<string, unknown>): Promise<SearchBatchResult> {
    return new Promise<SearchBatchResult>((resolve) => {
      let state = this.recordWrites.get(key);
      if (!state) { state = { running: false, pending: null }; this.recordWrites.set(key, state); }
      if (state.pending) {
        const job = state.pending;
        job.fields = { ...job.fields, ...fields };
        job.input = { ...input, requestStartedAt: earlier(job.input.requestStartedAt, input.requestStartedAt), expiresAt: Math.max(Number(job.input.expiresAt) || 0, Number(input.expiresAt) || 0) || undefined };
        job.waiters.push(resolve);
        this.s.writesSuperseded++;
        return;
      }
      state.pending = { input, fields, waiters: [resolve] };
      if (!state.running) void this.drainRecordWrites(key);
    });
  }
  private async drainRecordWrites(key: string): Promise<void> {
    const state = this.recordWrites.get(key);
    if (!state) return;
    state.running = true;
    try {
      while (state.pending) {
        const first = state.pending;
        const startedAt = Number(first.input.requestStartedAt) || 0;
        const grant = await this.acquireSlot("write", startedAt || Date.now(), !startedAt).promise;
        const job = state.pending ?? first;
        state.pending = null;
        let result: SearchBatchResult;
        try { result = await this.runLarkCall({ ...job.input, body: JSON.stringify({ fields: job.fields }) }, grant); }
        catch (error) { result = failure(502, String((error as Error)?.message || error)); }
        for (const waiter of job.waiters) waiter(result);
      }
    } finally { state.running = false; this.recordWrites.delete(key); }
  }

  async updateBatch(input: SearchBatchInput): Promise<SearchBatchResult> {
    const fields = putFields(input.body);
    const id = recordIdOf(input.url);
    if ((input.method || "PUT").toUpperCase() !== "PUT" || !fields || !id) return this.larkCall(input);
    this.countLabel(input.label || "update");
    const pathKey = new URL(input.url).pathname;
    const tableKey = pathKey.replace(/\/[^/]+$/, "");
    return new Promise<SearchBatchResult>((resolve) => {
      let state = this.recordWrites.get(pathKey);
      if (!state) { state = { running: false, pending: null }; this.recordWrites.set(pathKey, state); }
      if (state.pending) {
        const job = state.pending;
        job.fields = { ...job.fields, ...fields };
        job.input = { ...input, requestStartedAt: earlier(job.input.requestStartedAt, input.requestStartedAt), expiresAt: Math.max(Number(job.input.expiresAt) || 0, Number(input.expiresAt) || 0) || undefined };
        job.waiters.push(resolve);
        this.s.writesSuperseded++;
        return;
      }
      state.pending = { input, fields, waiters: [resolve] };
      if (state.running) return;
      let bucket = this.updateBuckets.get(tableKey);
      if (!bucket) { bucket = { ready: new Set(), running: false }; this.updateBuckets.set(tableKey, bucket); }
      bucket.ready.add(pathKey);
      if (!bucket.running) void this.runUpdateBucket(tableKey);
    });
  }

  private async runUpdateBucket(tableKey: string): Promise<void> {
    const bucket = this.updateBuckets.get(tableKey);
    if (!bucket) return;
    bucket.running = true;
    try {
      await sleep(MIN_WINDOW_MS);
      while (bucket.ready.size) {
        let since = Infinity, timed = true;
        for (const key of bucket.ready) {
          const pending = this.recordWrites.get(key)?.pending;
          if (!pending) continue;
          const startedAt = Number(pending.input.requestStartedAt) || 0;
          since = Math.min(since, startedAt || Date.now());
          if (!startedAt) timed = false;
        }
        if (!Number.isFinite(since)) { bucket.ready.clear(); break; }
        const grant = await this.acquireSlot("write", since, !timed).promise;
        const taken: Array<{ key: string; id: string; job: PutJob }> = [];
        for (const key of [...bucket.ready]) {
          if (taken.length >= MAX_UPDATE_BATCH) break;
          bucket.ready.delete(key);
          const state = this.recordWrites.get(key);
          if (!state || !state.pending || state.running) continue;
          taken.push({ key, id: recordIdOf(state.pending.input.url), job: state.pending });
          state.pending = null;
          state.running = true;
        }
        if (!taken.length) { this.releaseSlot(false, 0, grant); continue; }
        try { await this.executeUpdates(taken, grant, since, timed); }
        catch (error) { const failed = failure(502, String((error as Error)?.message || error)); for (const t of taken) for (const w of t.job.waiters) w(failed); }
        for (const { key } of taken) {
          const state = this.recordWrites.get(key);
          if (!state) continue;
          state.running = false;
          if (state.pending) bucket.ready.add(key); else this.recordWrites.delete(key);
        }
      }
    } finally {
      bucket.running = false;
      if (!bucket.ready.size) this.updateBuckets.delete(tableKey);
    }
  }

  private async executeUpdates(items: Array<{ id: string; job: PutJob }>, grant: Grant | null, since: number, timed: boolean): Promise<void> {
    const single = (item: { id: string; job: PutJob }, held: Grant | null) =>
      this.runLarkCall({ ...item.job.input, body: JSON.stringify({ fields: item.job.fields }) }, held);
    if (items.length === 1) {
      const result = await single(items[0], grant);
      for (const w of items[0].job.waiters) w(result);
      return;
    }
    this.s.updateBatches++;
    const base = items[0].job.input;
    const url = new URL(base.url);
    url.pathname = url.pathname.replace(/\/records\/[^/]+$/, "/records/batch_update");
    const deadline = Math.max(...items.map((i) => Number(i.job.input.expiresAt) || Date.now() + 90_000));
    const input: SearchBatchInput = { ...base, url: url.toString(), method: "POST",
      body: JSON.stringify({ records: items.map((i) => ({ record_id: i.id, fields: i.job.fields })) }) };
    let result = await this.fetchPage(input, grant, since, deadline, "write", !timed, this.writeTimeoutMs);
    if (upstreamFailures.has(result) && Date.now() < deadline - 1_000) {
      this.s.writeRetries++;
      result = await this.fetchPage(input, null, since, deadline, "write", !timed, this.writeTimeoutMs);
    }
    let parsed: any = null;
    try { parsed = JSON.parse(result.body); } catch { }
    if (result.status >= 200 && result.status < 300 && parsed && parsed.code === 0) {
      const byId = new Map<string, any>();
      for (const rec of Array.isArray(parsed.data?.records) ? parsed.data.records : []) if (rec?.record_id) byId.set(String(rec.record_id), rec);
      const missed: Array<{ id: string; job: PutJob }> = [];
      for (const item of items) {
        const rec = byId.get(item.id);
        if (!rec) { missed.push(item); continue; }
        this.dropRecord(item.id);
        this.s.updatedInBatches++;
        const answer = okRecord(rec);
        for (const w of item.job.waiters) w(answer);
      }
      this.s.updateMismatches += missed.length;
      await Promise.all(missed.map(async (item) => { const r = await single(item, null); for (const w of item.job.waiters) w(r); }));
      return;
    }
    const limited = result.status === 429 || Number(parsed?.code) === 1254290 || Number(parsed?.code) === 99991400;
    if (upstreamFailures.has(result) || limited || items.length === 1) {
      for (const item of items) for (const w of item.job.waiters) w(result);
      return;
    }
    const code = Number(parsed?.code);
    if (!RECORD_LEVEL_UPDATE_CODES.has(code)) {
      this.s.updateWholeCallErrors++;
      for (const item of items) for (const w of item.job.waiters) w(result);
      return;
    }
    if (code === 1254043) {
      const named = /id\s*=\s*([A-Za-z0-9_-]+)/.exec(String(parsed?.msg || ""))?.[1];
      const at = named ? items.findIndex((i) => i.id === named) : -1;
      if (at >= 0) {
        this.s.updateRecordRejects++;
        for (const w of items[at].job.waiters) w(result);
        const rest = items.filter((_, i) => i !== at);
        const g = await this.acquireSlot("write", since, !timed).promise;
        return this.executeUpdates(rest, g, since, timed);
      }
    }
    this.s.updateSplits++;
    const mid = Math.ceil(items.length / 2);
    await Promise.all([items.slice(0, mid), items.slice(mid)].map(async (half) => {
      const g = await this.acquireSlot("write", since, !timed).promise;
      return this.executeUpdates(half, g, since, timed);
    }));
  }

  private async runLarkCall(input: SearchBatchInput, held: Grant | null = null): Promise<SearchBatchResult> {
    const method = (input.method || "GET").toUpperCase();
    const klass: Klass = method === "GET" ? "read" : "write";
    const startedAt = Number(input.requestStartedAt) || 0;
    const since = startedAt || Date.now();
    const expiresAt = Number(input.expiresAt) || Date.now() + 40_000;
    let result = await this.fetchPage(input, held, since, expiresAt, klass, !startedAt, this.writeTimeoutMs);
    if (method !== "DELETE" && upstreamFailures.has(result) && Date.now() < expiresAt - 1_000) {
      this.s.writeRetries++;
      result = await this.fetchPage(input, null, since, expiresAt, klass, !startedAt, this.writeTimeoutMs);
    }
    if (method !== "GET" && result.status >= 200 && result.status < 300) {
      const id = (new URL(input.url).pathname.match(/\/records\/([^/]+)$/) || [])[1];
      if (id) this.dropRecord(id);
    }
    return result;
  }

  async cachedCall(input: CachedCallInput): Promise<SearchBatchResult> {
    const key = String(input.cacheKey || "");
    if (!key) return this.larkCall(input);
    const now = Date.now();
    const hit = this.cache.get(key);
    if (!input.force && hit && now - hit.at < input.ttlMs) { this.s.cacheHits++; return hit.result; }
    const pending = this.cacheInflight.get(key);
    if (pending) { this.s.cacheShared++; return pending; }
    const run = this.larkCall(input).then((result) => {
      let ok = false;
      try { ok = result.status >= 200 && result.status < 300 && JSON.parse(result.body)?.code === 0; } catch { }
      if (ok) {
        this.cache.set(key, { at: Date.now(), result });
        while (this.cache.size > CACHE_MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
        return result;
      }
      if (hit && input.staleMs && Date.now() - hit.at < input.staleMs) { this.s.cacheStaleServed++; return hit.result; }
      return result;
    }).finally(() => { this.cacheInflight.delete(key); });
    this.cacheInflight.set(key, run);
    return run;
  }

  private async runCreateBucket(bucket: CreateBucket): Promise<void> {
    if (bucket.createdAt) {
      const wait = bucket.createdAt + MIN_WINDOW_MS - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const since = Math.min(...bucket.waiters.map((w) => w.since), Date.now());
    const aged = bucket.waiters.some((w) => !w.timed);
    const grant = await this.acquireSlot("write", since, aged).promise;
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
    if (batch.length === 1) {
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
    try { parsed = JSON.parse(result.body); } catch { }
    if (result.status < 200 || result.status >= 300 || !parsed || parsed.code !== 0) {
      for (const w of batch) w.resolve(result);
      return;
    }
    const returned: any[] = Array.isArray(parsed.data?.records) ? [...parsed.data.records] : [];
    const assigned: Array<any | undefined> = new Array(batch.length);
    batch.forEach((w, i) => {
      const at = returned.findIndex((rec) => rec && rec.record_id && Object.entries(w.fields).every(([k, v]) => fieldText(rec.fields?.[k]) === fieldText(v)));
      if (at >= 0) assigned[i] = returned.splice(at, 1)[0];
    });
    if (batch.some((_, i) => !assigned[i]) || returned.length) {
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
    if (bucket.createdAt) {
      const wait = bucket.createdAt + MIN_WINDOW_MS - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const since = Math.min(...bucket.waiters.map((w) => w.since), Date.now());
    const grant = await this.acquireSlot("read", since).promise;
    if (this.buckets.get(bucket.key) === bucket) this.buckets.delete(bucket.key);

    const now = Date.now();
    const live: Waiter[] = [];
    for (const w of bucket.waiters) {
      if (w.expiresAt <= now) { this.s.expiredDropped++; w.resolve(failure(504, "Lark search deadline exceeded in queue.")); } else live.push(w);
    }
    if (!live.length) { this.releaseSlot(false, 0, grant); return; }

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
        if (page === 0 && grant) this.releaseSlot(false, 0, grant);
        return;
      }
      const pageUrl = new URL(baseUrl);
      pageUrl.searchParams.delete("page_token");
      if (pageToken) pageUrl.searchParams.set("page_token", pageToken);
      const result = await this.fetchPage({ ...first.input, url: pageUrl.toString(), body: merged }, page === 0 ? grant : null, since, deadline);
      let parsed: any = null;
      try { parsed = JSON.parse(result.body); } catch { }
      if (result.status < 200 || result.status >= 300 || !parsed || parsed.code !== 0) {
        for (const w of allWaiters) w.resolve(result);
        return;
      }
      rows.push(...(parsed.data?.items || []));
      more = !!parsed.data?.has_more && !!parsed.data?.page_token;
      if (!more) break;
      const total = Number(parsed.data?.total);
      if (page === 0 && Number.isFinite(total) && total > MAX_PAGES * PAGE_SIZE) break;
      pageToken = String(parsed.data.page_token);
    }
    if (more) {
      this.s.truncatedFails++;
      if (chunk.length > 1 && depth < MAX_BISECT_DEPTH) {
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
