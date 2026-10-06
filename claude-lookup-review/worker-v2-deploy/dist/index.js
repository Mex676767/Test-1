var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
import { DurableObject } from "cloudflare:workers";
var MAX_USERNAMES = 50;
var PAGE_SIZE = 500;
var MAX_PAGES = 20;
var MAX_BISECT_DEPTH = 6;
var MIN_WINDOW_MS = 15;
var UPSTREAM_TIMEOUT_MS = 6e3;
var MAX_429_RETRIES = 2;
var MAX_COOLDOWN_MS = 5e3;
var PERMIT_LEASE_MS = 8e3;
var LONGPOLL_MS = 5e3;
var MAX_CREATE_BATCH = 100;
var LEGACY_WAIT_MS = 150;
var POLL_IDLE_MS = 1e4;
var WRITE_AGING_MS = 3e3;
var HEAVY_MEMORY_MS = 10 * 6e4;
var ORPHAN_STRIKES = 3;
var ORPHAN_WINDOW_MS = 6e4;
var NO_BATCH_MS = 5 * 6e4;
var STAT_SAMPLES = 2e3;
var CLASS_OFFSET = { token: -1e9, read: 0, write: WRITE_AGING_MS };
var failure = /* @__PURE__ */ __name((status, msg) => ({
  status,
  statusText: "",
  headers: [["content-type", "application/json"]],
  body: JSON.stringify({ code: -1, msg })
}), "failure");
var sleep = /* @__PURE__ */ __name((ms) => new Promise((resolve) => setTimeout(resolve, ms)), "sleep");
var norm = /* @__PURE__ */ __name((value) => value.trim().toLowerCase(), "norm");
var isRateLimited = /* @__PURE__ */ __name((status, parsed) => status === 429 || Number(parsed?.code) === 99991400 || Number(parsed?.code) === 1254290 || /too ?many ?requests?|rate.?limit/i.test(String(parsed?.msg || "")), "isRateLimited");
function fieldText(value) {
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
__name(fieldText, "fieldText");
var MyDurableObject = class extends DurableObject {
  static {
    __name(this, "MyDurableObject");
  }
  concurrency;
  baseGapMs;
  gapMs;
  longPollMs;
  active = 0;
  nextStartAt = 0;
  cooldownUntil = 0;
  okStreak = 0;
  waitq = [];
  timer = null;
  buckets = /* @__PURE__ */ new Map();
  tickets = /* @__PURE__ */ new Map();
  polls = /* @__PURE__ */ new Map();
  heavy = /* @__PURE__ */ new Map();
  orphanStrikes = /* @__PURE__ */ new Map();
  noBatchUntil = /* @__PURE__ */ new Map();
  createBuckets = /* @__PURE__ */ new Map();
  recentStarts = [];
  pruneCounter = 0;
  s = {
    upstream: 0,
    limited: 0,
    retries429: 0,
    batches: 0,
    expiredDropped: 0,
    bisected: 0,
    orphanFallbacks: 0,
    createBatches: 0,
    createdInBatches: 0,
    createMismatches: 0,
    noBatchTrips: 0,
    peakQueue: 0,
    truncatedFails: 0,
    heavyUsers: 0,
    peakStartsPerSec: 0,
    startsByClass: { token: 0, read: 0, write: 0 },
    batchSizes: [],
    queueWaitMs: []
  };
  constructor(ctx, env) {
    super(ctx, env);
    this.concurrency = Number(env?.GATE_CONCURRENCY) || 3;
    this.longPollMs = Number(env?.GATE_LONGPOLL_MS) || LONGPOLL_MS;
    this.baseGapMs = this.gapMs = Number(env?.GATE_START_GAP_MS) || 250;
  }
  getMapSizes() {
    return { heavy: this.heavy.size, noBatch: this.noBatchUntil.size, orphanStrikes: this.orphanStrikes.size };
  }
  getStats() {
    const { batchSizes, queueWaitMs, ...rest } = this.s;
    const sorted = [...queueWaitMs].sort((a, b) => a - b);
    return {
      ...rest,
      gapMs: this.gapMs,
      queued: this.waitq.length,
      active: this.active,
      buckets: this.buckets.size,
      meanBatch: batchSizes.length ? +(batchSizes.reduce((a, b) => a + b, 0) / batchSizes.length).toFixed(1) : 0,
      queueWaitP50: sorted[Math.floor(sorted.length / 2)] ?? 0,
      queueWaitMax: sorted.at(-1) ?? 0
    };
  }
  sample(arr, value) {
    arr.push(value);
    if (arr.length > STAT_SAMPLES) arr.splice(0, arr.length - STAT_SAMPLES);
  }
  // ---- gate -------------------------------------------------------------
  acquireSlot(klass, since = Date.now()) {
    let entry;
    const promise = new Promise((grant) => {
      entry = { grant, cancelled: false, order: since + CLASS_OFFSET[klass] };
    });
    let at = this.waitq.length;
    while (at > 0 && this.waitq[at - 1].order > entry.order) at--;
    this.waitq.splice(at, 0, entry);
    this.s.peakQueue = Math.max(this.s.peakQueue, this.waitq.length);
    promise.then(() => {
      this.s.startsByClass[klass]++;
    });
    this.pump();
    return { promise, cancel: /* @__PURE__ */ __name(() => {
      entry.cancelled = true;
    }, "cancel") };
  }
  pump() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.waitq.length && this.active < this.concurrency) {
      const head = this.waitq[0];
      if (head.cancelled) {
        this.waitq.shift();
        continue;
      }
      const now = Date.now();
      const at = Math.max(this.nextStartAt, this.cooldownUntil);
      if (at > now) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.pump();
        }, at - now);
        return;
      }
      this.waitq.shift();
      this.active++;
      this.nextStartAt = now + this.gapMs;
      this.recentStarts.push(now);
      while (this.recentStarts.length && now - this.recentStarts[0] >= 1e3) this.recentStarts.shift();
      this.s.peakStartsPerSec = Math.max(this.s.peakStartsPerSec, this.recentStarts.length);
      head.grant();
    }
  }
  releaseSlot(limited, retryAfterMs = 0) {
    this.active = Math.max(0, this.active - 1);
    if (limited) {
      this.s.limited++;
      this.okStreak = 0;
      this.gapMs = Math.min(500, this.gapMs * 2);
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + Math.min(MAX_COOLDOWN_MS, Math.max(1e3, retryAfterMs)));
    } else if (++this.okStreak >= 20) {
      this.okStreak = 0;
      this.gapMs = Math.max(this.baseGapMs, Math.floor(this.gapMs * 0.8));
    }
    this.pump();
  }
  // Slot must already be held. Always releases it.
  async fetchOnce(input) {
    this.s.upstream++;
    try {
      const response = await fetch(input.url, {
        method: input.method || "POST",
        headers: input.headers,
        body: input.body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      });
      const body = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
      }
      const limited = isRateLimited(response.status, parsed);
      if (limited) console.warn("Lark rate limit", JSON.stringify({ httpStatus: response.status, code: parsed?.code, retryAfter: response.headers.get("Retry-After"), gapMs: this.gapMs }));
      this.releaseSlot(limited, Number(response.headers.get("Retry-After")) * 1e3 || 0);
      return { limited, result: { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body } };
    } catch (error) {
      this.releaseSlot(false);
      return { limited: false, result: failure(504, String(error?.message || error)) };
    }
  }
  async fetchPage(input, haveSlot, since, deadline, klass = "read") {
    for (let attempt = 0; ; attempt++) {
      if (!haveSlot) {
        if (Date.now() >= deadline) {
          this.s.expiredDropped++;
          return failure(504, "Lark search deadline exceeded in queue.");
        }
        await this.acquireSlot(klass, since).promise;
      }
      haveSlot = false;
      if (Date.now() >= deadline) {
        this.s.expiredDropped++;
        this.releaseSlot(false);
        return failure(504, "Lark search deadline exceeded in queue.");
      }
      const { result, limited } = await this.fetchOnce(input);
      if (!limited || attempt >= MAX_429_RETRIES) return result;
      this.s.retries429++;
    }
  }
  // ---- RPC: permits for non-search calls (token, create, update, fields) -----
  // Long-polls inside the DO. A caller that comes back with the same waiterId
  // (after its RPC timed out) keeps its original place in line.
  async acquire(kind, waiterId) {
    if (kind === void 0 && waiterId === void 0) return this.acquireLegacy();
    kind = kind ?? "write";
    let poll = waiterId ? this.polls.get(waiterId) : void 0;
    if (!poll) {
      const slot = this.acquireSlot(kind === "token" || kind === "read" ? kind : "write");
      const created = { slot, ticket: null, idle: null, granted: Promise.resolve() };
      created.granted = slot.promise.then(() => {
        created.ticket = crypto.randomUUID();
        const ticket = created.ticket;
        this.tickets.set(ticket, setTimeout(() => {
          if (this.tickets.delete(ticket)) this.releaseSlot(false);
        }, PERMIT_LEASE_MS));
      });
      poll = created;
      if (waiterId) this.polls.set(waiterId, poll);
    }
    if (poll.idle) {
      clearTimeout(poll.idle);
      poll.idle = null;
    }
    const timedOut = await Promise.race([poll.granted.then(() => false), sleep(this.longPollMs).then(() => true)]);
    if (timedOut) {
      const current = poll;
      if (!waiterId) {
        current.slot.cancel();
        return { ticket: null, retryAfterMs: 100 };
      }
      current.idle = setTimeout(() => {
        this.polls.delete(waiterId);
        if (!current.ticket) current.slot.cancel();
      }, POLL_IDLE_MS);
      return { ticket: null, retryAfterMs: 0 };
    }
    if (waiterId) this.polls.delete(waiterId);
    return { ticket: poll.ticket, retryAfterMs: 0 };
  }
  async acquireLegacy() {
    const slot = this.acquireSlot("write");
    let granted = false;
    void slot.promise.then(() => {
      granted = true;
    });
    const timedOut = await Promise.race([slot.promise.then(() => false), sleep(LEGACY_WAIT_MS).then(() => true)]);
    if (timedOut && !granted) {
      slot.cancel();
      return { ticket: null, retryAfterMs: 100 };
    }
    return { ticket: this.issueTicket(), retryAfterMs: 0 };
  }
  issueTicket() {
    const ticket = crypto.randomUUID();
    this.tickets.set(ticket, setTimeout(() => {
      if (this.tickets.delete(ticket)) this.releaseSlot(false);
    }, PERMIT_LEASE_MS));
    return ticket;
  }
  async release(ticket, rateLimited = false, retryAfterMs = 0) {
    const t = this.tickets.get(ticket);
    if (!t) return;
    clearTimeout(t);
    this.tickets.delete(ticket);
    this.releaseSlot(rateLimited, retryAfterMs);
  }
  async penalize(retryAfterMs = 0) {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + Math.min(MAX_COOLDOWN_MS, Math.max(1e3, retryAfterMs)));
  }
  // ---- RPC: searches ------------------------------------------------------
  async searchBatch(input) {
    const expiresAt = Number(input.expiresAt) || Date.now() + 4e4;
    let body;
    try {
      body = JSON.parse(input.body || "{}");
    } catch {
      return this.single(input, expiresAt);
    }
    try {
      if (new URL(input.url).searchParams.has("page_token")) return this.single(input, expiresAt);
    } catch {
      return this.single(input, expiresAt);
    }
    if (++this.pruneCounter % 50 === 0) this.pruneExpired();
    const conds = body?.filter?.conditions;
    if (!Array.isArray(conds) || body?.filter?.conjunction === "or") return this.single(input, expiresAt);
    const userConds = conds.filter((c) => c?.operator === "is" && /^(username(?:\/uid)?|uid)$/i.test(String(c.field_name || "")) && Array.isArray(c.value) && c.value.length === 1);
    const others = conds.filter((c) => !userConds.includes(c));
    const brandOnly = others.every((c) => c?.operator === "is" && /^brand$/i.test(String(c.field_name || "")));
    const simpleOps = others.every((c) => ["is", "isEmpty", "isNotEmpty"].includes(String(c?.operator || "")));
    const selective = brandOnly || simpleOps && Array.isArray(body.field_names) && body.field_names.length > 0;
    if (userConds.length !== 1 || !selective || !String(userConds[0].value[0] ?? "")) return this.single(input, expiresAt);
    const username = String(userConds[0].value[0]);
    const url = new URL(input.url);
    const headers = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const baseKey = JSON.stringify([
      url.origin,
      url.pathname,
      headers.authorization || "",
      String(userConds[0].field_name),
      !!body.field_names?.length
    ]);
    const now = Date.now();
    const noBatch = this.noBatchUntil.get(baseKey);
    if (noBatch !== void 0) {
      if (noBatch > now) return this.single(input, expiresAt);
      this.noBatchUntil.delete(baseKey);
    }
    const heavyUntil = this.heavy.get(baseKey + "|" + username);
    if (heavyUntil !== void 0 && heavyUntil <= now) this.heavy.delete(baseKey + "|" + username);
    const isHeavy = heavyUntil !== void 0 && heavyUntil > now;
    const key = isHeavy ? `${baseKey}#solo#${username}` : baseKey;
    return new Promise((resolve) => {
      const waiter = { input, body, usernameField: String(userConds[0].field_name), username, expiresAt, enqueuedAt: now, resolve };
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = { key, baseKey, waiters: [], createdAt: now };
        this.buckets.set(key, bucket);
        void this.runBucket(bucket);
      }
      bucket.waiters.push(waiter);
    });
  }
  // ---- RPC: record creation, coalesced into batch_create ---------------------
  // Lark documents neither atomicity nor result ORDER for batch_create, so every returned
  // record is matched to its caller by the columns that caller sent (never by position).
  // Anything that does not map one-to-one fails closed: callers get an error, and a retried
  // lookup reuses any blank row that did land (it never creates a second one).
  async createBatch(input) {
    const expiresAt = Number(input.expiresAt) || Date.now() + 4e4;
    let parsed;
    try {
      parsed = JSON.parse(input.body || "{}");
    } catch {
      return this.singleWrite(input, expiresAt);
    }
    const url = new URL(input.url);
    const supported = parsed && typeof parsed.fields === "object" && parsed.fields && Object.keys(parsed).length === 1 && /\/tables\/[^/]+\/records$/.test(url.pathname) && (input.method || "POST").toUpperCase() === "POST";
    if (!supported) return this.singleWrite(input, expiresAt);
    const headers = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const key = JSON.stringify([url.origin, url.pathname, headers.authorization || ""]);
    return new Promise((resolve) => {
      const waiter = { input, fields: parsed.fields, expiresAt, enqueuedAt: Date.now(), resolve };
      let bucket = this.createBuckets.get(key);
      if (!bucket) {
        bucket = { key, waiters: [], createdAt: Date.now() };
        this.createBuckets.set(key, bucket);
        void this.runCreateBucket(bucket);
      }
      bucket.waiters.push(waiter);
    });
  }
  async singleWrite(input, expiresAt) {
    const since = Date.now();
    if (since >= expiresAt) {
      this.s.expiredDropped++;
      return failure(504, "Lark write deadline exceeded in queue.");
    }
    await this.acquireSlot("write", since).promise;
    return this.fetchPage(input, true, since, expiresAt, "write");
  }
  async runCreateBucket(bucket) {
    if (bucket.createdAt) {
      const wait = bucket.createdAt + MIN_WINDOW_MS - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const since = Math.min(...bucket.waiters.map((w) => w.enqueuedAt), Date.now());
    await this.acquireSlot("write", since).promise;
    if (this.createBuckets.get(bucket.key) === bucket) this.createBuckets.delete(bucket.key);
    const now = Date.now();
    const live = [];
    for (const w of bucket.waiters) {
      if (w.expiresAt <= now) {
        this.s.expiredDropped++;
        w.resolve(failure(504, "Lark write deadline exceeded in queue."));
      } else live.push(w);
    }
    if (!live.length) {
      this.releaseSlot(false);
      return;
    }
    const batch = live.slice(0, MAX_CREATE_BATCH);
    const leftover = live.slice(MAX_CREATE_BATCH);
    if (leftover.length) {
      let next = this.createBuckets.get(bucket.key);
      if (next) next.waiters.unshift(...leftover);
      else {
        next = { key: bucket.key, waiters: leftover, createdAt: 0 };
        this.createBuckets.set(bucket.key, next);
        void this.runCreateBucket(next);
      }
    }
    await this.executeCreates(batch, since);
  }
  async executeCreates(batch, since) {
    const deadline = Math.max(...batch.map((w) => w.expiresAt));
    for (const w of batch) this.sample(this.s.queueWaitMs, Date.now() - w.enqueuedAt);
    if (batch.length === 1) {
      batch[0].resolve(await this.fetchPage(batch[0].input, true, since, deadline, "write"));
      return;
    }
    this.s.createBatches++;
    const url = new URL(batch[0].input.url);
    url.pathname = url.pathname.replace(/\/records$/, "/records/batch_create");
    const result = await this.fetchPage({
      ...batch[0].input,
      url: url.toString(),
      method: "POST",
      body: JSON.stringify({ records: batch.map((w) => ({ fields: w.fields })) })
    }, true, since, deadline, "write");
    let parsed = null;
    try {
      parsed = JSON.parse(result.body);
    } catch {
    }
    if (result.status < 200 || result.status >= 300 || !parsed || parsed.code !== 0) {
      for (const w of batch) w.resolve(result);
      return;
    }
    const returned = Array.isArray(parsed.data?.records) ? [...parsed.data.records] : [];
    const assigned = new Array(batch.length);
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
      status: 200,
      statusText: "OK",
      headers: [["content-type", "application/json"]],
      body: JSON.stringify({ code: 0, data: { record: assigned[i] } })
    }));
  }
  async single(input, expiresAt) {
    const since = Date.now();
    if (since >= expiresAt) {
      this.s.expiredDropped++;
      return failure(504, "Lark search deadline exceeded in queue.");
    }
    return this.fetchPage(input, false, since, expiresAt);
  }
  async runBucket(bucket) {
    if (bucket.createdAt) {
      const wait = bucket.createdAt + MIN_WINDOW_MS - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const since = Math.min(...bucket.waiters.map((w) => w.enqueuedAt), Date.now());
    await this.acquireSlot("read", since).promise;
    if (this.buckets.get(bucket.key) === bucket) this.buckets.delete(bucket.key);
    const now = Date.now();
    const live = [];
    for (const w of bucket.waiters) {
      if (w.expiresAt <= now) {
        this.s.expiredDropped++;
        w.resolve(failure(504, "Lark search deadline exceeded in queue."));
      } else live.push(w);
    }
    if (!live.length) {
      this.releaseSlot(false);
      return;
    }
    const byUser = /* @__PURE__ */ new Map();
    const rawByNorm = /* @__PURE__ */ new Map();
    const leftover = [];
    for (const w of live) {
      const list = byUser.get(w.username);
      if (list) {
        list.push(w);
        continue;
      }
      const existing = rawByNorm.get(norm(w.username));
      if (byUser.size >= MAX_USERNAMES || existing !== void 0 && existing !== w.username) {
        leftover.push(w);
        continue;
      }
      rawByNorm.set(norm(w.username), w.username);
      byUser.set(w.username, [w]);
    }
    if (leftover.length) this.requeue(bucket, leftover);
    await this.execute(bucket.baseKey, [...byUser.entries()], since, 0);
  }
  requeue(from, waiters) {
    let bucket = this.buckets.get(from.key);
    if (bucket) {
      bucket.waiters.unshift(...waiters);
      return;
    }
    bucket = { key: from.key, baseKey: from.baseKey, waiters, createdAt: 0 };
    this.buckets.set(from.key, bucket);
    void this.runBucket(bucket);
  }
  // The first page uses the slot runBucket (or executeAfterSlot) already holds.
  async execute(baseKey, chunk, since, depth) {
    const first = chunk[0][1][0];
    const usernameField = first.usernameField;
    const usernames = new Set(chunk.map(([u]) => u));
    const allWaiters = chunk.flatMap(([, w]) => w);
    const deadline = Math.max(...allWaiters.map((w) => w.expiresAt));
    const startedAt = Date.now();
    for (const w of allWaiters) this.sample(this.s.queueWaitMs, startedAt - w.enqueuedAt);
    this.s.batches++;
    this.sample(this.s.batchSizes, usernames.size);
    const unionFields = chunk.some(([, ws]) => ws.some((w) => !w.body.field_names?.length)) ? null : [.../* @__PURE__ */ new Set([usernameField, ...allWaiters.flatMap((w) => [
      ...w.body.field_names || [],
      ...(w.body.filter?.conditions || []).map((c) => c.field_name).filter(Boolean)
    ])])];
    const merged = JSON.stringify({
      filter: { conjunction: "or", conditions: [...usernames].map((u) => ({ field_name: usernameField, operator: "is", value: [u] })) },
      automatic_fields: allWaiters.some((w) => !!w.body.automatic_fields),
      ...unionFields ? { field_names: unionFields } : {}
    });
    const baseUrl = new URL(first.input.url);
    baseUrl.searchParams.set("page_size", String(PAGE_SIZE));
    const rows = [];
    let pageToken = "";
    let more = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (Date.now() >= deadline) {
        for (const w of allWaiters) w.resolve(failure(504, "Lark search deadline exceeded."));
        this.s.expiredDropped += allWaiters.length;
        return;
      }
      const pageUrl = new URL(baseUrl);
      pageUrl.searchParams.delete("page_token");
      if (pageToken) pageUrl.searchParams.set("page_token", pageToken);
      const result = await this.fetchPage({ ...first.input, url: pageUrl.toString(), body: merged }, page === 0, since, deadline);
      let parsed = null;
      try {
        parsed = JSON.parse(result.body);
      } catch {
      }
      if (result.status < 200 || result.status >= 300 || !parsed || parsed.code !== 0) {
        for (const w of allWaiters) w.resolve(result);
        return;
      }
      rows.push(...parsed.data?.items || []);
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
          await this.acquireSlot("read", since).promise;
          return this.execute(baseKey, half, since, depth + 1);
        }));
        return;
      }
      if (chunk.length === 1) {
        this.heavy.set(baseKey + "|" + chunk[0][0], Date.now() + HEAVY_MEMORY_MS);
        this.s.heavyUsers++;
      }
      for (const w of allWaiters) w.resolve(failure(502, `Lark search exceeded ${MAX_PAGES * PAGE_SIZE} rows${chunk.length === 1 ? " for one username" : ""}; refusing a partial result.`));
      return;
    }
    const seen = /* @__PURE__ */ new Set();
    const per = /* @__PURE__ */ new Map();
    let orphan = false;
    for (const row of rows) {
      if (row.record_id && seen.has(row.record_id)) continue;
      if (row.record_id) seen.add(row.record_id);
      const text = fieldText(row?.fields?.[usernameField]);
      if (!usernames.has(text)) {
        orphan = true;
        break;
      }
      (per.get(text) || per.set(text, []).get(text)).push(row);
    }
    if (orphan) {
      this.s.orphanFallbacks++;
      this.recordOrphan(baseKey);
      await Promise.all(allWaiters.map(async (w) => w.resolve(await this.single(w.input, w.expiresAt))));
      return;
    }
    const ok = /* @__PURE__ */ __name((items) => ({
      status: 200,
      statusText: "OK",
      headers: [["content-type", "application/json"], ["x-lark-batched", "1"]],
      body: JSON.stringify({ code: 0, data: { items, has_more: false, page_token: "" } })
    }), "ok");
    for (const [username, ws] of chunk) {
      const body = ok(per.get(username) || []);
      for (const w of ws) w.resolve(body);
    }
  }
  // Entries are removed when read after expiry, and swept here every 50 searches so keys that
  // are never read again cannot accumulate for the life of the object.
  pruneExpired() {
    const now = Date.now();
    for (const [key, until] of this.heavy) if (until <= now) this.heavy.delete(key);
    for (const [key, until] of this.noBatchUntil) if (until <= now) this.noBatchUntil.delete(key);
    for (const [key, entry] of this.orphanStrikes) if (now - entry.first > ORPHAN_WINDOW_MS) this.orphanStrikes.delete(key);
  }
  recordOrphan(baseKey) {
    const now = Date.now();
    const entry = this.orphanStrikes.get(baseKey);
    if (!entry || now - entry.first > ORPHAN_WINDOW_MS) {
      this.orphanStrikes.set(baseKey, { n: 1, first: now });
      return;
    }
    entry.n++;
    if (entry.n >= ORPHAN_STRIKES) {
      this.noBatchUntil.set(baseKey, now + NO_BATCH_MS);
      this.orphanStrikes.delete(baseKey);
      this.s.noBatchTrips++;
      console.warn("Lark batching disabled for table after repeated attribution mismatches", baseKey.slice(0, 120));
    }
  }
};
var index_default = {
  async fetch() {
    return new Response("Not found", { status: 404 });
  }
};
export {
  MyDurableObject,
  index_default as default
};
//# sourceMappingURL=index.js.map
