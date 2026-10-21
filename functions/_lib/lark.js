let APP_ID, APP_SECRET, BASE_APP_TOKEN;
let TABLE_CUSTOMER_APPROACHING, TABLE_REDEEM_CODE, TABLE_PNL;
let TABLE_GRACE_PERIOD, TABLE_TOP_PNL_NIGHT, TABLE_LTV_DAY, TABLE_RISK_PLAYER, TABLE_SPECIAL_RELOAD, TABLE_VIP_BOOSTER;
let ESCALATION_BASE_TOKEN, TABLE_ESCALATION;
let TABLE_TELEGRAM28;
let TABLE_MOONCAKE;
let TABLE_VS96_FEEDBACK;
let TABLE_BONUS_CONFIG;
let TABLE_AGENT_LOGINS;
let TABLE_UNRECORDED;
import { AsyncLocalStorage } from "node:async_hooks";
import { queueStubFrom } from "./queue-stub.js";
let LARK_SEARCH_QUEUE;
let QUEUE_ENV = {};
const queueStub = () => queueStubFrom(LARK_SEARCH_QUEUE, QUEUE_ENV);
let LARK_QUEUE_LONGPOLL = false;
let LARK_BATCH_CREATE = false;
let LARK_BATCH_UPDATE = false;

export function initEnv(env) {
  LARK_SEARCH_QUEUE = env.LARK_SEARCH_QUEUE;
  QUEUE_ENV = { LARK_QUEUE_NAME: env.LARK_QUEUE_NAME, LARK_QUEUE_LOCATION_HINT: env.LARK_QUEUE_LOCATION_HINT };
  LARK_QUEUE_LONGPOLL = String(env.LARK_QUEUE_PROTOCOL || "") === "v2";
  LARK_BATCH_CREATE = LARK_QUEUE_LONGPOLL && String(env.LARK_BATCH_CREATE || "") === "1";
  LARK_BATCH_UPDATE = LARK_QUEUE_LONGPOLL && String(env.LARK_BATCH_UPDATE || "") === "1";
  APP_ID = env.LARK_APP_ID;
  APP_SECRET = env.LARK_APP_SECRET;
  BASE_APP_TOKEN = env.LARK_BASE_APP_TOKEN;

  TABLE_CUSTOMER_APPROACHING = env.LARK_TABLE_CUSTOMER_APPROACHING;
  TABLE_REDEEM_CODE = env.LARK_TABLE_REDEEM_CODE;
  TABLE_PNL = env.LARK_TABLE_PNL;

  TABLE_GRACE_PERIOD = env.LARK_TABLE_GRACE_PERIOD;
  TABLE_TOP_PNL_NIGHT = env.LARK_TABLE_TOP_PNL_NIGHT;
  TABLE_LTV_DAY = env.LARK_TABLE_LTV_DAY;
  TABLE_RISK_PLAYER = env.LARK_TABLE_RISK_PLAYER;
  TABLE_SPECIAL_RELOAD = env.LARK_TABLE_SPECIAL_RELOAD;
  TABLE_VIP_BOOSTER = env.LARK_TABLE_VIP_BOOSTER;

  ESCALATION_BASE_TOKEN = env.LARK_ESCALATION_BASE_TOKEN;
  TABLE_ESCALATION = env.LARK_ESCALATION_TABLE;

  TABLE_TELEGRAM28 = env.LARK_TABLE_TELEGRAM28;

  TABLE_MOONCAKE = env.LARK_TABLE_MOONCAKE;

  TABLE_VS96_FEEDBACK = env.LARK_TABLE_VS96_FEEDBACK;
  TABLE_BONUS_CONFIG = env.LARK_TABLE_BONUS_CONFIG;
  TABLE_AGENT_LOGINS = env.LARK_TABLE_AGENT_LOGINS;
  TABLE_UNRECORDED = env.LARK_TABLE_UNRECORDED;
}

const requestContext = new AsyncLocalStorage();
let requestSeq = 0;
export function runWithRequestStart(fn, startedAt = Date.now()) {
  if (requestContext.getStore()) return fn();
  return requestContext.run({ startedAt, id: ++requestSeq }, fn);
}
const currentRequestStart = () => requestContext.getStore()?.startedAt;
const startForQueue = () => { const startedAt = currentRequestStart(); if (startedAt === undefined) noteCounter("noRequestStart"); return startedAt; };

const larkQueueResponses = new WeakMap();
const LARK_QUEUE_RPC_TIMEOUT_MS = 250;
const LARK_QUEUE_LONGPOLL_RPC_TIMEOUT_MS = 6_000;
const LARK_QUEUE_RELEASE_WAIT_MS = 250;
const LARK_UPSTREAM_TIMEOUT_MS = 6_000;
const LARK_DEFAULT_UPSTREAM_TIMEOUT_MS = 15_000;
const LARK_SEARCH_QUEUE_TIMEOUT_MS = 60_000;
const LARK_SEARCH_CALLER_DEADLINE_MS = 40_000;
const MAX_SEARCH_PAGES = 10;
export const larkClientStats = { rateLimited: 0, failOpen: 0, batchFallbacks: 0, queueCallFallbacks: 0, ownershipFallbacks: 0, ownershipFallbackReasons: {}, tokenRefreshRetries: 0 };

const pendingCounters = new Map();
const counterName = (name) => String(name).replace(/[^A-Za-z0-9:_.-]+/g, "_").slice(0, 48);
export function noteCounter(name, n = 1) {
  const key = counterName(name);
  if (pendingCounters.size < 200 || pendingCounters.has(key)) pendingCounters.set(key, (pendingCounters.get(key) || 0) + n);
}
const DO_RESET_REASONS = [
  ["codeUpdated", /code (?:was|has been) updated/i],
  ["connectionLost", /network connection lost|connection lost|disconnected/i],
  ["reset", /durable object.{0,40}reset|\bwas reset\b|reset because/i],
];
const DO_RETRY_METHODS = new Set(["acquire", "searchBatch", "larkCall", "updateBatch", "cachedCall"]);
export function doResetReason(error) {
  if (error?.overloaded) return "";
  const text = String(error?.message || error);
  for (const [name, pattern] of DO_RESET_REASONS) if (pattern.test(text)) return name;
  return error?.retryable === true && error?.remote === true ? "retryable" : "";
}
const DO_RETRY_DELAY_MS = [300, 500];
async function doRpc(stub, method, ...args) {
  const attempt = () => Promise.resolve().then(() => stub[method](...args));
  const failed = (error) => { if (!NO_QUEUE_METHOD.test(String(error?.message || error))) noteCounter(`doFailed:${method}`); };
  try { return await attempt(); }
  catch (error) {
    const reason = DO_RETRY_METHODS.has(method) && !(method === "larkCall" && String(args[0]?.method || "").toUpperCase() === "DELETE") ? doResetReason(error) : "";
    if (!reason) { failed(error); throw error; }
    noteCounter(`doRetry:${reason}`);
    await new Promise((resolve) => setTimeout(resolve, DO_RETRY_DELAY_MS[0] + Math.floor(Math.random() * (DO_RETRY_DELAY_MS[1] - DO_RETRY_DELAY_MS[0]))));
    try { return await attempt(); } catch (second) { failed(second); throw second; }
  }
}
let isolateId = "";
const getIsolateId = () => isolateId || (isolateId = crypto.randomUUID());
let lastHeartbeatAt = 0;
export async function flushCounters({ heartbeat = false } = {}) {
  if (!pendingCounters.size && !heartbeat) return;
  const report = Object.fromEntries(pendingCounters);
  pendingCounters.clear();
  if (!LARK_SEARCH_QUEUE) return;
  let timer;
  try {
    const stub = queueStub();
    await Promise.race([Promise.resolve(stub.reportCounters(report, getIsolateId())), new Promise((resolve) => { timer = setTimeout(resolve, 1_000); })]);
  } catch (_) { } finally { clearTimeout(timer); }
}
export function flushCountersThrottled() {
  const now = Date.now();
  if (pendingCounters.size) { lastHeartbeatAt = now; return flushCounters(); }
  if (now - lastHeartbeatAt < 5_000) return Promise.resolve();
  lastHeartbeatAt = now;
  return flushCounters({ heartbeat: true });
}

export function isLarkRateLimited(status, data) {
  const code = Number(data?.code);
  return status === 429 || code === 99991400 || code === 1254290
    || /too ?many ?requests?|rate.?limit/i.test(String(data?.msg || ""));
}

function bestEffortQueueCall(stub, method, ...args) {
  try {
    return Promise.resolve(stub[method](...args)).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

async function releaseQueuePermit(stub, ticket, rateLimited = false, retryAfterMs = 0) {
  let timer;
  await Promise.race([
    bestEffortQueueCall(stub, "release", ticket, rateLimited, retryAfterMs),
    new Promise((resolve) => { timer = setTimeout(resolve, LARK_QUEUE_RELEASE_WAIT_MS); }),
  ]);
  clearTimeout(timer);
}

function labelFor(url, method = "GET") {
  const text = String(url);
  const m = String(method).toUpperCase();
  if (text.includes("tenant_access_token")) return "token";
  if (text.includes("/records/search")) return "search";
  if (text.includes("/fields")) return "fields";
  if (/\/records\/[^/?]+(\?|$)/.test(text)) return m === "GET" ? "record-get" : m === "DELETE" ? "delete" : "update";
  if (/\/records(\?|$)/.test(text)) return m === "POST" ? "create" : "list";
  return "other";
}

function callQueueAcquire(stub, signal, kind, waiterId, label) {
  const rpcTimeoutMs = LARK_QUEUE_LONGPOLL ? LARK_QUEUE_LONGPOLL_RPC_TIMEOUT_MS : LARK_QUEUE_RPC_TIMEOUT_MS;
  const pending = Promise.resolve().then(() => (LARK_QUEUE_LONGPOLL ? doRpc(stub, "acquire", kind, waiterId, startForQueue(), label) : doRpc(stub, "acquire")));
  let abandoned = false;
  pending.then((permit) => {
    if (abandoned && permit?.ticket) bestEffortQueueCall(stub, "release", permit.ticket);
  }, () => {});

  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      abandoned = true;
      cleanup();
      reject(abortError(signal));
    };
    timer = setTimeout(() => {
      abandoned = true;
      cleanup();
      reject(new Error("Lark queue coordinator timed out."));
    }, rpcTimeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    pending.then((permit) => {
      if (abandoned) return;
      cleanup();
      resolve(permit);
    }, (error) => {
      if (abandoned) return;
      cleanup();
      reject(error);
    });
  });
}

function waitForLarkPermit(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(25, ms));
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function acquireSharedLarkPermit(signal, kind = "write", label = "other") {
  if (!LARK_SEARCH_QUEUE) return null;
  const stub = queueStub();
  const waiterId = crypto.randomUUID();
  while (!signal?.aborted) {
    let permit;
    try {
      permit = await callQueueAcquire(stub, signal, kind, waiterId, label);
    } catch (error) {
      if (signal?.aborted) throw error;
      larkClientStats.failOpen++;
      noteCounter("failOpen");
      console.warn("Lark queue fail-open", JSON.stringify({ kind, error: String(error?.message || error).slice(0, 80) }));
      return null;
    }
    if (permit?.ticket) return { stub, ticket: permit.ticket };
    await waitForLarkPermit(Math.min(250, Math.max(50, Number(permit?.retryAfterMs) || 100)), signal);
  }
  throw abortError(signal);
}

async function larkFetch(url, init = {}) {
  const { queueSignal, upstreamTimeoutMs = LARK_DEFAULT_UPSTREAM_TIMEOUT_MS, expiresAt, ...fetchInit } = init;
  if (LARK_SEARCH_QUEUE && String(url).includes("/records/search")) {
    const stub = queueStub();
    try {
      const headers = Object.fromEntries(new Headers(fetchInit.headers || {}).entries());
      let batchBody = typeof fetchInit.body === "string" ? fetchInit.body : "";
      try {
        const payload = JSON.parse(batchBody || "{}");
        if (Array.isArray(payload.field_names) && Array.isArray(payload.filter?.conditions)) {
          payload.field_names = [...new Set([
            ...payload.field_names,
            ...payload.filter.conditions.map((condition) => condition.field_name).filter(Boolean),
          ])];
          batchBody = JSON.stringify(payload);
        }
      } catch (_) { }
      const pending = doRpc(stub, "searchBatch", {
        url: String(url),
        method: fetchInit.method || "GET",
        headers,
        body: batchBody,
        expiresAt,
        requestStartedAt: startForQueue(),
        label: "search",
      });
      const result = queueSignal || fetchInit.signal
        ? await awaitWithSignal(pending, queueSignal || fetchInit.signal)
        : await pending;
      return new Response(result.body, { status: result.status, statusText: result.statusText, headers: result.headers });
    } catch (error) {
      if (queueSignal?.aborted || fetchInit.signal?.aborted) throw error;
      larkClientStats.batchFallbacks++;
      noteCounter("batchFallback");
    }
  }
  const permitKind = String(url).includes("tenant_access_token") ? "token"
    : String(fetchInit.method || "GET").toUpperCase() === "GET" || String(url).includes("/records/search") ? "read" : "write";
  const permit = await acquireSharedLarkPermit(queueSignal || fetchInit.signal, permitKind, labelFor(url, fetchInit.method));
  let upstreamTimer;
  let upstreamController;
  if (upstreamTimeoutMs > 0) {
    upstreamController = new AbortController();
    upstreamTimer = setTimeout(() => {
      upstreamController.abort(Object.assign(new Error(`Lark upstream request timed out after ${Math.round(upstreamTimeoutMs / 1000)} seconds.`), { retryable: true }));
    }, upstreamTimeoutMs);
    fetchInit.signal = fetchInit.signal
      ? AbortSignal.any([fetchInit.signal, upstreamController.signal])
      : upstreamController.signal;
  }
  try {
    const response = await fetch(url, fetchInit);
    if (permit) {
      larkQueueResponses.set(response, permit.stub);
      let limited = response.status === 429;
      if (!limited && !String(url).includes("/records/search")) {
        try { limited = isLarkRateLimited(response.status, await response.clone().json()); } catch (_) { }
      }
      await releaseQueuePermit(permit.stub, permit.ticket, limited,
        Number(response.headers?.get?.("Retry-After")) * 1000 || 0);
    }
    return response;
  } catch (error) {
    if (permit) await releaseQueuePermit(permit.stub, permit.ticket, false, 0);
    if (upstreamController?.signal.aborted && fetchInit.signal?.reason?.retryable) {
      throw fetchInit.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(upstreamTimer);
  }
}

const LARK_WRITE_CALLER_DEADLINE_MS = 90_000;
const NO_QUEUE_METHOD = /does not implement|not a function|no such method|is not a function/i;
function rpcResult(result) {
  let data;
  try { data = JSON.parse(result.body); } catch (_) { data = { code: -1, msg: `HTTP ${result.status}` }; }
  return { res: { status: result.status, headers: new Headers(result.headers || []) }, data };
}
async function queueCall(method, input, waitMs) {
  if (!(LARK_SEARCH_QUEUE && LARK_QUEUE_LONGPOLL)) return null;
  const stub = queueStub();
  let timer;
  try {
    const pending = doRpc(stub, method, input);
    pending.catch(() => {});
    const result = await Promise.race([
      pending,
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Lark queue did not answer in time."), { retryable: true })), waitMs); }),
    ]);
    return rpcResult(result);
  } catch (error) {
    if (NO_QUEUE_METHOD.test(String(error?.message || error))) { larkClientStats.queueCallFallbacks++; noteCounter("queueCallFallback"); return null; }
    throw error;
  } finally { clearTimeout(timer); }
}
function callInput(url, init, extra = {}) {
  return {
    url, method: init.method || "GET", headers: Object.fromEntries(new Headers(init.headers || {}).entries()),
    ...(typeof init.body === "string" ? { body: init.body } : {}),
    label: labelFor(url, init.method), requestStartedAt: startForQueue(), ...extra,
  };
}
async function sharedCachedRead(cacheKey, url, init, { ttlMs, staleMs = 0, force = false }) {
  return queueCall("cachedCall", callInput(url, init, { cacheKey, ttlMs, staleMs, force, expiresAt: Date.now() + 20_000 }), 20_000);
}

export function reportSharedLarkRateLimit(response, retryAfterMs = 0) {
  const stub = larkQueueResponses.get(response);
  if (stub) bestEffortQueueCall(stub, "penalize", Number(retryAfterMs) || 0);
}

export const TOKEN_INVALID_CODES = new Set([99991663]);
export const AUTH_BUG_CODES = new Set([99991661, 99991664, 99991665, 99991671]);

export function scrubSecrets(text) {
  return String(text ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, "Bearer [token]")
    .replace(/\b[tu]-[A-Za-z0-9_-]{20,}\b/g, "[token]");
}
function clearCachedToken(bad) {
  if (cachedToken && cachedToken === bad) { cachedToken = null; cachedExpiry = 0; }
}
async function withToken(fn) {
  const token = await getTenantToken();
  try { return await fn(token); }
  catch (error) {
    if (!error?.tokenInvalid) throw error;
    clearCachedToken(token);
    larkClientStats.tokenRefreshRetries++;
    noteCounter("tokenRefreshRetry");
    return fn(await getTenantToken());
  }
}

function larkApiError(message, res, data) {
  const err = new Error(scrubSecrets(message));
  err.code = Number(data?.code);
  err.larkMsg = scrubSecrets(String(data?.msg || ""));
  err.tokenInvalid = TOKEN_INVALID_CODES.has(err.code);
  if (AUTH_BUG_CODES.has(err.code)) noteCounter(`authBug:${err.code}`);
  err.httpStatus = res?.status;
  const limited = isLarkRateLimited(res?.status, data);
  const transient = limited || res?.status === 408 || res?.status >= 500 || /internal|temporar|timeout|server error|system busy/i.test(err.larkMsg);
  err.rateLimited = limited;
  if (transient) err.retryable = true;
  err.retryAfterMs = Number(res?.headers?.get?.("Retry-After")) * 1000 || 0;
  if (limited) {
    reportSharedLarkRateLimit(res, err.retryAfterMs);
    larkClientStats.rateLimited++;
    console.warn("Lark rate limit", JSON.stringify({ httpStatus: res?.status, code: data?.code, retryAfter: res?.headers?.get?.("Retry-After") ?? null }));
  }
  return err;
}

let cachedToken = null;
let cachedExpiry = 0;
let inFlightTokenRequest = null;

const MAX_CONCURRENT_LARK_SEARCHES = 3;
let activeLarkSearches = 0;
let larkSearchQueue = [];
let larkSearchCooldownUntil = 0;
const inFlightLarkSearches = new Map();
const ABANDONED_SEARCH_MS = 120_000;
function forgetAbandonedSearches() {
  const cutoff = Date.now() - ABANDONED_SEARCH_MS;
  for (const [key, entry] of inFlightLarkSearches) if (entry.at < cutoff) inFlightLarkSearches.delete(key);
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("Lark request cancelled.");
}

function acquireLarkSearchSlot(signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  if (activeLarkSearches < MAX_CONCURRENT_LARK_SEARCHES && larkSearchQueue.length === 0) {
    activeLarkSearches++;
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, onAbort: null };
    waiter.onAbort = () => {
      const index = larkSearchQueue.indexOf(waiter);
      if (index >= 0) larkSearchQueue.splice(index, 1);
      signal.removeEventListener("abort", waiter.onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    if (signal.aborted) waiter.onAbort();
    else larkSearchQueue.push(waiter);
  });
}

function releaseLarkSearchSlot() {
  while (larkSearchQueue.length) {
    const next = larkSearchQueue.shift();
    next.signal.removeEventListener("abort", next.onAbort);
    if (next.signal.aborted) {
      next.reject(abortError(next.signal));
      continue;
    }
    next.resolve();
    return;
  }
  activeLarkSearches = Math.max(0, activeLarkSearches - 1);
}

function awaitWithSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

async function waitForLarkSearchCooldown(signal) {
  const waitMs = larkSearchCooldownUntil - Date.now();
  if (waitMs <= 0) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(done, waitMs);
    function done() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function getTenantToken() {
  const now = Date.now();
  if (cachedToken && now < cachedExpiry - 60_000) return cachedToken;
  if (inFlightTokenRequest) return inFlightTokenRequest;
  if (!APP_ID || !APP_SECRET) throw new Error("LARK_APP_ID / LARK_APP_SECRET not set.");
  inFlightTokenRequest = (async () => {
    try {
      const res = await larkFetch("https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(LARK_SEARCH_QUEUE_TIMEOUT_MS),
        queueSignal: AbortSignal.timeout(LARK_SEARCH_QUEUE_TIMEOUT_MS),
        upstreamTimeoutMs: LARK_UPSTREAM_TIMEOUT_MS,
        body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
      });
      const data = await res.json();
      if (data.code !== 0) throw new Error(scrubSecrets("Lark auth failed: " + data.msg));
      cachedToken = data.tenant_access_token;
      cachedExpiry = Date.now() + data.expire * 1000;
      return cachedToken;
    } finally {
      inFlightTokenRequest = null;
    }
  })();
  return inFlightTokenRequest;
}

function isFieldNameProblem(error) {
  const message = String(error?.message || "");
  return !error?.rateLimited && /field|column/i.test(message) && /not found|invalid|unknown|does not exist|unsupported|illegal/i.test(message);
}
export function searchRecords(tableId, conditions, baseToken, opts = {}) {
  if (!tableId) throw new Error("Missing table ID — check env vars.");
  if (opts.fieldNames?.length && !opts.noProjectionFallback) {
    const { fieldNames, ...withoutProjection } = opts;
    return searchRecordsOnce(tableId, conditions, baseToken, opts).catch((error) => {
      if (!isFieldNameProblem(error)) throw error;
      console.warn("Lark search projection rejected; retrying without it", tableId, String(error.message).slice(0, 120));
      return searchRecordsOnce(tableId, conditions, baseToken, withoutProjection);
    });
  }
  return searchRecordsOnce(tableId, conditions, baseToken, opts);
}
function searchRecordsOnce(tableId, conditions, baseToken, opts = {}) {
  const cacheKey = JSON.stringify({
    baseToken: baseToken || BASE_APP_TOKEN,
    tableId,
    conditions,
    pageSize: opts.pageSize || null,
    maxRows: opts.maxRows || null,
    automaticFields: !!opts.automaticFields,
    fieldNames: opts.fieldNames || null,
    request: requestContext.getStore()?.id ?? 0,
  });
  const existing = inFlightLarkSearches.get(cacheKey);
  if (existing) return existing.request;
  forgetAbandonedSearches();
  const request = performSearchRecords(tableId, conditions, baseToken, opts);
  const entry = { request, at: Date.now() };
  inFlightLarkSearches.set(cacheKey, entry);
  const done = () => { if (inFlightLarkSearches.get(cacheKey) === entry) inFlightLarkSearches.delete(cacheKey); };
  request.then(done, done);
  return request;
}

async function performSearchRecords(tableId, conditions, baseToken, opts) {
  let lastErr;
  const requestedAttempts = Number(opts.maxAttempts ?? 1);
  const maxAttempts = Math.max(1, Math.min(2, Number.isFinite(requestedAttempts) ? requestedAttempts : 1));
  const timeoutMs = opts.timeoutMs || LARK_SEARCH_QUEUE_TIMEOUT_MS;
  const upstreamTimeoutMs = opts.upstreamTimeoutMs ?? LARK_UPSTREAM_TIMEOUT_MS;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let hasSlot = false;
    try {
      if (!(LARK_SEARCH_QUEUE && LARK_QUEUE_LONGPOLL)) {
        await acquireLarkSearchSlot(controller.signal);
        hasSlot = true;
        await waitForLarkSearchCooldown(controller.signal);
      }
      let token = await awaitWithSignal(getTenantToken(), controller.signal);
      let tokenRetried = false;
      const maxRows = Math.max(0, Math.floor(Number(opts.maxRows) || 0));
      const pageSize = maxRows ? Math.min(maxRows, 500) : (Number(opts.pageSize) || 500);
      const collected = [];
      let pageToken = "";
      let batched = false;
      let more = false;
      for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
        const res = await larkFetch(
          `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseToken || BASE_APP_TOKEN}/tables/${tableId}/records/search`
            + `?page_size=${pageSize}` + (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""),
          { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            signal: controller.signal,
            queueSignal: controller.signal,
            expiresAt: Date.now() + Math.min(timeoutMs, LARK_SEARCH_CALLER_DEADLINE_MS),
            upstreamTimeoutMs,
            body: JSON.stringify({
              filter: { conjunction: "and", conditions },
              ...(opts.automaticFields ? { automatic_fields: true } : {}),
              ...(opts.fieldNames?.length ? { field_names: opts.fieldNames } : {}),
            }) }
        );
        const data = await res.json();
        if (data.code !== 0 && TOKEN_INVALID_CODES.has(Number(data.code)) && !tokenRetried) {
          tokenRetried = true;
          clearCachedToken(token);
          larkClientStats.tokenRefreshRetries++;
          noteCounter("tokenRefreshRetry");
          token = await awaitWithSignal(getTenantToken(), controller.signal);
          page--;
          continue;
        }
        if (data.code !== 0) {
          const limited = isLarkRateLimited(res.status, data);
          const err = new Error(limited
            ? `Lark is rate-limiting searches (table ${tableId}): ${scrubSecrets(data.msg || "Too many requests")}`
            : `Lark search failed on table ${tableId}: ${scrubSecrets(data.msg)}`);
          err.code = Number(data.code);
          if (AUTH_BUG_CODES.has(err.code)) noteCounter(`authBug:${err.code}`);
          err.rateLimited = limited;
          err.retryable = limited || (
            res.status === 408 || res.status >= 500
            || /internal|temporar|timeout|server error|system busy/i.test(String(data.msg || ""))
          );
          err.retryAfterMs = Number(res.headers.get("Retry-After")) * 1000 || 0;
          if (limited) {
            reportSharedLarkRateLimit(res, err.retryAfterMs);
            larkClientStats.rateLimited++;
            console.warn("Lark rate limit", JSON.stringify({ table: tableId, httpStatus: res.status, code: data.code, retryAfter: res.headers.get("Retry-After") }));
          }
          throw err;
        }
        collected.push(...(data.data.items || []));
        batched = batched || res.headers?.get?.("x-lark-batched") === "1";
        more = !!data.data.has_more && !!data.data.page_token;
        if (maxRows) { more = false; break; }
        if (!more) break;
        pageToken = String(data.data.page_token);
      }
      if (more) {
        const err = new Error(`Lark search on table ${tableId} returned more than ${MAX_SEARCH_PAGES * pageSize} rows; refusing to return a partial result.`);
        err.retryable = false;
        throw err;
      }
      const seenIds = new Set();
      const unique = collected.filter((record) => {
        const id = record && record.record_id;
        if (!id) return true;
        if (seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
      });
      const rows = batched ? unique.filter((record) => matchesLarkSearchConditions(record, conditions)) : unique;
      return maxRows ? rows.slice(0, maxRows) : rows;
    } catch (err) {
      if (controller.signal.aborted) {
        lastErr = new Error(`Lark search timed out after ${Math.round(timeoutMs / 1000)} seconds (table ${tableId}).`);
        lastErr.retryable = true;
      } else {
        lastErr = err;
      }
      if (lastErr.rateLimited) {
        const retryMs = Math.min(5_000, lastErr.retryAfterMs || 1_000);
        larkSearchCooldownUntil = Math.max(larkSearchCooldownUntil, Date.now() + retryMs);
      }
      if (lastErr.retryable === false) throw lastErr;
    } finally {
      clearTimeout(timeoutId);
      if (hasSlot) releaseLarkSearchSlot();
    }
    if (attempt < maxAttempts - 1) {
      const baseDelay = 250 * (2 ** attempt);
      const jitter = Math.floor(Math.random() * Math.min(700, baseDelay * 0.25));
      await new Promise((resolve) => setTimeout(resolve, Math.max(baseDelay, larkSearchCooldownUntil - Date.now()) + jitter));
    }
  }
  throw lastErr;
}

function matchesLarkSearchConditions(record, conditions) {
  return (conditions || []).every(({ field_name: fieldName, operator, value = [] }) => {
    const display = toDisplay(record?.fields?.[fieldName]).trim();
    if (operator === "is") return (Array.isArray(value) ? value : [value]).some((expected) => display === toDisplay(expected).trim());
    if (operator === "isEmpty") return !display;
    if (operator === "isNotEmpty") return !!display;
    return true;
  });
}

export async function searchAllRecords(tableId, conditions, { maxPages = 5, automaticFields = false, fieldNames } = {}) {
  if (fieldNames?.length) {
    try { return await searchAllRecordsOnce(tableId, conditions, { maxPages, automaticFields, fieldNames }); }
    catch (error) {
      if (!isFieldNameProblem(error)) throw error;
      console.warn("Lark scan projection rejected; retrying without it", tableId);
    }
  }
  return searchAllRecordsOnce(tableId, conditions, { maxPages, automaticFields });
}
function searchAllRecordsOnce(...args) { return withToken((token) => searchAllRecordsWith(token, ...args)); }
async function searchAllRecordsWith(token, tableId, conditions, { maxPages = 5, automaticFields = false, fieldNames } = {}) {
  if (!tableId) throw new Error("Missing table ID — check env vars.");
  const all = [];
  let pageToken = "";
  for (let page = 0; page < maxPages; page++) {
    const res = await larkFetch(
      `https://open.larksuite.com/open-apis/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records/search?page_size=500`
        + (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""),
      { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          filter: { conjunction: "and", conditions },
          ...(automaticFields ? { automatic_fields: true } : {}),
          ...(fieldNames?.length ? { field_names: fieldNames } : {}),
        }) }
    );
    const data = await res.json();
    if (data.code !== 0) throw larkApiError(`Lark search failed on table ${tableId}: ${data.msg}`, res, data);
    all.push(...(data.data.items || []));
    if (!data.data.has_more || !data.data.page_token) break;
    pageToken = data.data.page_token;
  }
  return all;
}

export function searchPage(tableId, conditions, opts = {}) { return withToken((token) => searchPageWith(token, tableId, conditions, opts)); }
async function searchPageWith(token, tableId, conditions, { pageSize = 500, pageToken = "", automaticFields = false, fieldNames } = {}) {
  if (!tableId) throw new Error("Missing table ID — check env vars.");
  const res = await larkFetch(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records/search?page_size=${pageSize}`
      + (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""),
    { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        filter: { conjunction: "and", conditions: conditions || [] },
        ...(automaticFields ? { automatic_fields: true } : {}),
        ...(fieldNames?.length ? { field_names: fieldNames } : {}),
      }) }
  );
  const data = await res.json();
  if (data.code !== 0) throw larkApiError(`Lark search failed on table ${tableId}: ${data.msg}`, res, data);
  return { items: data.data.items || [], next: data.data.has_more && data.data.page_token ? String(data.data.page_token) : "" };
}

export function getRecord(...args) { return withToken((token) => getRecordWith(token, ...args)); }
async function getRecordWith(token, tableId, recordId) {
  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records/${recordId}`;
  const init = { headers: { Authorization: `Bearer ${token}` } };
  const queued = await queueCall("larkCall", callInput(url, init, { expiresAt: Date.now() + LARK_SEARCH_CALLER_DEADLINE_MS }), LARK_SEARCH_CALLER_DEADLINE_MS);
  const res = queued ? queued.res : await larkFetch(url, init);
  const data = queued ? queued.data : await res.json();
  if (data.code !== 0) throw larkApiError(`Lark getRecord failed: ${data.msg}`, res, data);
  return data.data.record;
}

async function forgetCreatedRow(tableId, recordId) {
  if (!(LARK_BATCH_CREATE && LARK_SEARCH_QUEUE) || tableId !== TABLE_CUSTOMER_APPROACHING) return;
  try {
    const stub = queueStub();
    let timer;
    await Promise.race([
      Promise.resolve(stub.forgetCreated(String(recordId))),
      new Promise((resolve) => { timer = setTimeout(resolve, 500); }),
    ]).finally(() => clearTimeout(timer));
  } catch (_) { }
}

export function updateRecord(...args) { return withToken((token) => updateRecordWith(token, ...args)); }
async function updateRecordWith(token, tableId, recordId, fields, baseToken) {
  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseToken || BASE_APP_TOKEN}/tables/${tableId}/records/${recordId}`;
  const init = { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ fields }) };
  const input = callInput(url, init, { expiresAt: Date.now() + LARK_WRITE_CALLER_DEADLINE_MS });
  const queued = (LARK_BATCH_UPDATE && await queueCall("updateBatch", input, LARK_WRITE_CALLER_DEADLINE_MS))
    || await queueCall("larkCall", input, LARK_WRITE_CALLER_DEADLINE_MS);
  const res = queued ? queued.res : await larkFetch(url, init);
  const data = queued ? queued.data : await res.json();
  if (data.code !== 0) throw larkApiError(`Lark update failed on table ${tableId}: ${data.msg}`, res, data);
  if (!queued) await forgetCreatedRow(tableId, recordId);
  return data.data.record;
}

export function createRecord(...args) { return withToken((token) => createRecordWith(token, ...args)); }
async function createRecordWith(token, tableId, fields, baseToken) {
  const createUrl = `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseToken || BASE_APP_TOKEN}/tables/${tableId}/records`;
  if (LARK_BATCH_CREATE && LARK_SEARCH_QUEUE && tableId === TABLE_CUSTOMER_APPROACHING) {
    const stub = queueStub();
    try {
      const result = await doRpc(stub, "createBatch", {
        url: createUrl, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fields }), expiresAt: Date.now() + LARK_SEARCH_CALLER_DEADLINE_MS,
        requestStartedAt: startForQueue(), label: "create",
      });
      const data = JSON.parse(result.body);
      if (data.code !== 0) throw larkApiError(`Lark create failed on table ${tableId}: ${data.msg}`, { status: result.status, headers: new Headers(result.headers || []) }, data);
      return data.data.record;
    } catch (error) {
      if (!/does not implement|not a function|no such method/i.test(String(error?.message || error))) throw error;
      console.warn("Lark queue has no createBatch; creating directly");
    }
  }
  const res = await larkFetch(
    createUrl,
    { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields }) }
  );
  const data = await res.json();
  if (data.code !== 0) throw larkApiError(`Lark create failed on table ${tableId}: ${data.msg}`, res, data);
  return data.data.record;
}

export function deleteRecord(...args) { return withToken((token) => deleteRecordWith(token, ...args)); }
async function deleteRecordWith(token, tableId, recordId, baseToken) {
  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseToken || BASE_APP_TOKEN}/tables/${tableId}/records/${recordId}`;
  const init = { method: "DELETE", headers: { Authorization: `Bearer ${token}` } };
  const queued = await queueCall("larkCall", callInput(url, init, { expiresAt: Date.now() + LARK_WRITE_CALLER_DEADLINE_MS }), LARK_WRITE_CALLER_DEADLINE_MS);
  const res = queued ? queued.res : await larkFetch(url, init);
  const data = queued ? queued.data : await res.json();
  if (data.code !== 0) throw larkApiError(`Lark delete failed on table ${tableId}: ${data.msg}`, res, data);
  if (!queued) await forgetCreatedRow(tableId, recordId);
  return true;
}

export function listRecords(...args) { return withToken((token) => listRecordsWith(token, ...args)); }
async function listRecordsWith(token, tableId, pageSize = 500, { sharedCacheMs = 0, force = false } = {}) {
  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records?page_size=${pageSize}`;
  const init = { headers: { Authorization: `Bearer ${token}` } };
  const shared = sharedCacheMs > 0 ? await sharedCachedRead(`list::${BASE_APP_TOKEN}::${tableId}::${pageSize}`, url, init, { ttlMs: sharedCacheMs, force }) : null;
  const res = shared ? shared.res : await larkFetch(url, init);
  const data = shared ? shared.data : await res.json();
  if (data.code !== 0) throw larkApiError(`Lark listRecords failed: ${data.msg}`, res, data);
  return data.data.items || [];
}

export function toDisplay(v, optionMap) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => toDisplay(x, optionMap)).filter(Boolean).join(", ");
  if (typeof v === "object") {
    if ("value" in v) return toDisplay(v.value, optionMap);
    if ("text" in v) return resolveOption(String(v.text), optionMap);
    if ("name" in v) return String(v.name);
    if ("link" in v) return String(v.link);
    return JSON.stringify(v);
  }
  return resolveOption(String(v), optionMap);
}

function resolveOption(text, optionMap) {
  if (optionMap && optionMap.has(text)) return optionMap.get(text);
  return text;
}

const FIELDS_TTL_MS = 30_000;
const FIELDS_STALE_OK_MS = 6 * 60 * 60_000;
const fieldsCache = new Map();
const fieldsInFlight = new Map();
export async function listFields(tableId, baseToken, { force = false } = {}) {
  const key = (baseToken || BASE_APP_TOKEN) + "::" + tableId;
  const cached = fieldsCache.get(key);
  if (!force && cached && Date.now() - cached.at < FIELDS_TTL_MS) return cached.items;
  const pending = fieldsInFlight.get(key);
  if (pending) return pending;
  const request = (async () => {
    try {
      const items = await withToken(async (token) => {
      const fieldsUrl = `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseToken || BASE_APP_TOKEN}/tables/${tableId}/fields?page_size=100`;
      const fieldsInit = { headers: { Authorization: `Bearer ${token}` }, upstreamTimeoutMs: LARK_UPSTREAM_TIMEOUT_MS, queueSignal: AbortSignal.timeout(15_000) };
      const shared = await sharedCachedRead(`fields::${key}`, fieldsUrl, fieldsInit, { ttlMs: FIELDS_TTL_MS, staleMs: FIELDS_STALE_OK_MS, force });
      const res = shared ? shared.res : await larkFetch(fieldsUrl, fieldsInit);
      const data = shared ? shared.data : await res.json();
      if (data.code !== 0) throw larkApiError(`Lark listFields failed on table ${tableId}: ${data.msg}`, res, data);
      return data.data.items || [];
      });
      fieldsCache.set(key, { items, at: Date.now() });
      return items;
    } catch (error) {
      if (cached && Date.now() - cached.at < FIELDS_STALE_OK_MS) {
        console.warn("Lark listFields failed; serving last good field catalog", tableId, String(error?.message || error).slice(0, 120));
        return cached.items;
      }
      throw error;
    } finally {
      fieldsInFlight.delete(key);
    }
  })();
  fieldsInFlight.set(key, request);
  return request;
}

const fieldOptionMapCache = new Map();

export async function getFieldOptionMap(tableId, fieldName, baseToken, { fresh = false } = {}) {
  const key = (baseToken || BASE_APP_TOKEN) + "::" + tableId + "::" + fieldName;
  if (!fresh) {
    const cached = fieldOptionMapCache.get(key);
    if (cached && Date.now() < cached.expiry) return cached.map;
  }

  const fields = await listFields(tableId, baseToken, { force: fresh });
  const field = fields.find((f) => f.field_name === fieldName);
  const options = field && field.property && field.property.options;
  const map = new Map((options || []).map((o) => [o.id, o.name]));
  if (!fresh) fieldOptionMapCache.set(key, { map, expiry: Date.now() + 10 * 60_000 });
  return map;
}

function findTimeOfInspection(fields, dateFieldName) {
  if (dateFieldName) return fields[dateFieldName] ?? 0;
  const key = Object.keys(fields).find((k) => k.trim().toLowerCase() === "time of inspection");
  return key ? fields[key] : 0;
}

export async function findOldestClaimableRow(tableId, username, brand, isClaimable, baseToken, { usernameField, brandField, dateField, newest, fieldNames, timeoutMs } = {}) {
  if (!tableId) return null;
  const defaultUsernameField = !usernameField;
  const usernameFields = usernameField ? [usernameField] : ["Username/UID", "Username"];
  let matches;
  let lastErr;
  for (const candidateUsernameField of usernameFields) {
    const conditions = [
      { field_name: candidateUsernameField, operator: "is", value: [username] },
      { field_name: brandField || "Brand", operator: "is", value: [brand] },
    ];
    try {
      matches = await searchRecords(tableId, conditions, baseToken, { pageSize: 500, automaticFields: true, fieldNames, timeoutMs, noProjectionFallback: true });
      break;
    } catch (err) {
      lastErr = err;
      if (fieldNames?.length && err.retryable === false && !err.rateLimited) {
        try {
          matches = await searchRecords(tableId, conditions, baseToken, { pageSize: 500, automaticFields: true, timeoutMs });
          break;
        } catch (fallbackErr) {
          lastErr = fallbackErr;
          err = fallbackErr;
        }
      }
      const schemaFieldError = /field|column/i.test(String(err.message || ""))
        && /not found|invalid|unknown|does not exist|unsupported/i.test(String(err.message || ""));
      if (!(defaultUsernameField && candidateUsernameField === "Username/UID" && schemaFieldError)) throw lastErr;
    }
  }
  if (!matches) throw lastErr;
  const claimable = matches.filter((r) => isClaimable(r.fields));
  if (!claimable.length) return null;
  claimable.sort((a, b) => {
    const byInspection = (findTimeOfInspection(a.fields, dateField) || 0) - (findTimeOfInspection(b.fields, dateField) || 0);
    if (byInspection) return byInspection;
    const byCreated = (Number(a.created_time) || 0) - (Number(b.created_time) || 0);
    if (byCreated) return byCreated;
    return String(a.record_id || "").localeCompare(String(b.record_id || ""));
  });
  return newest ? claimable[claimable.length - 1] : claimable[0];
}

export {
  TABLE_CUSTOMER_APPROACHING, TABLE_REDEEM_CODE, TABLE_PNL,
  TABLE_GRACE_PERIOD, TABLE_TOP_PNL_NIGHT, TABLE_LTV_DAY, TABLE_RISK_PLAYER,
  TABLE_SPECIAL_RELOAD, TABLE_VIP_BOOSTER,
  ESCALATION_BASE_TOKEN, TABLE_ESCALATION,
  TABLE_TELEGRAM28,
  TABLE_MOONCAKE,
  TABLE_VS96_FEEDBACK,
  TABLE_BONUS_CONFIG,
  TABLE_AGENT_LOGINS,
  TABLE_UNRECORDED,
};
