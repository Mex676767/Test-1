const DEFAULT_BASE_URL = "https://tickets.96ghq.com/api/v1";

function config(env = {}) {
  const apiKey = String(env.TICKETS_API_KEY || "").trim();
  const baseUrl = String(env.TICKETS_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  return { apiKey, baseUrl };
}

// The key and base URL, for the one call that is not JSON (a picture; see ticket-attachment.js).
export function ticketCredentials(env = {}) { return config(env); }

export function ticketSettings(env = {}) {
  const { apiKey } = config(env);
  const departmentId = Number(env.TICKETS_TO_DEPARTMENT_ID);
  const marketId = env.TICKETS_MARKET_ID === undefined || env.TICKETS_MARKET_ID === ""
    ? null
    : Number(env.TICKETS_MARKET_ID);

  return {
    configured: Boolean(apiKey),
    departmentId: Number.isInteger(departmentId) && departmentId > 0 ? departmentId : null,
    marketId: Number.isInteger(marketId) && marketId > 0 ? marketId : null,
  };
}

// A hung ticket service must not hang the function. JSON calls get 15 s; multipart (attachment uploads) 30 s.
// A caller-provided signal is still honoured alongside the deadline.
const TICKET_TIMEOUT_MS = 15_000;
const TICKET_UPLOAD_TIMEOUT_MS = 30_000;

// The ticket API allows each key 120 requests a minute, shared by every agent, and answers 429 with Retry-After (seconds to the next
// minute). After a 429 this isolate stops calling for that long: more calls would only be refused too and push the count up again.
const DEFAULT_RETRY_AFTER_S = 20;
let rateLimitedUntil = 0;
export function resetTicketRateLimit() { rateLimitedUntil = 0; }

function busyError(seconds) {
  const wait = Math.max(1, Math.ceil(seconds));
  const error = new Error(`The ticket system is busy (request limit reached). Try again in ${wait} s.`);
  error.statusCode = 429;
  error.retryAfter = wait;
  return error;
}

export async function ticketRequest(env, path, options = {}) {
  const { apiKey, baseUrl } = config(env);
  if (!apiKey) throw new Error("Ticket API key is not configured");
  if (rateLimitedUntil > Date.now()) throw busyError((rateLimitedUntil - Date.now()) / 1000);
  const isMultipart = typeof FormData !== "undefined" && options.body instanceof FormData;
  const { timeoutMs, signal: callerSignal, ...fetchOptions } = options;
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : (isMultipart ? TICKET_UPLOAD_TIMEOUT_MS : TICKET_TIMEOUT_MS);
  const deadline = AbortSignal.timeout(limit);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;

  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...fetchOptions,
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(options.body && !isMultipart ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    if (deadline.aborted && !callerSignal?.aborted) {
      const timedOut = new Error(`Ticket service did not answer within ${Math.round(limit / 1000)} seconds`);
      timedOut.statusCode = 504;
      throw timedOut;
    }
    throw error;
  }

  if (response.status === 429) {
    const seconds = Number(response.headers?.get?.("retry-after"));
    const wait = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 120) : DEFAULT_RETRY_AFTER_S;
    rateLimitedUntil = Date.now() + wait * 1000;
    throw busyError(wait);
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error(`Ticket service returned HTTP ${response.status}`);
  }

  if (!response.ok || !data.ok) {
    const error = new Error(data.error || `Ticket service returned HTTP ${response.status}`);
    error.statusCode = response.status;
    if (data.duplicateOf) error.duplicateOf = String(data.duplicateOf);
    throw error;
  }
  return data;
}

// Reads (a ticket, the inbox list) repeat constantly: every agent's widget re-reads open tickets every 30 s. A copy up to `ttlMs` old
// is shared by every agent on this isolate and identical reads in flight at once become one call, which keeps the shared 120 a minute
// for what is new. `fresh: true` (an agent pressing Refresh or searching) skips the stored copy but still shares an in-flight read.
const MAX_CACHED_READS = 300;
const readCache = new Map(); // key -> { at, data }
const readsInFlight = new Map(); // key -> Promise
export function resetTicketReadCache() { readCache.clear(); readsInFlight.clear(); }

export async function ticketGet(env, path, { ttlMs = 0, fresh = false } = {}) {
  const { apiKey, baseUrl } = config(env);
  const key = `${baseUrl}|${apiKey}|${path}`;
  const stored = readCache.get(key);
  if (!fresh && ttlMs > 0 && stored && Date.now() - stored.at < ttlMs) return stored.data;
  if (readsInFlight.has(key)) return readsInFlight.get(key);
  const pending = ticketRequest(env, path)
    .then((data) => {
      if (ttlMs > 0) {
        readCache.set(key, { at: Date.now(), data });
        if (readCache.size > MAX_CACHED_READS) readCache.delete(readCache.keys().next().value);
      }
      return data;
    })
    .finally(() => readsInFlight.delete(key));
  readsInFlight.set(key, pending);
  return pending;
}

// A read as the signed-in agent: the ticket API takes the person's email as onBehalfOf on any GET (keys that act for others require it
// on every request). It is part of the path, so each person's reads are cached on their own.
export function withOnBehalf(path, email) {
  return email ? `${path}${path.includes("?") ? "&" : "?"}onBehalfOf=${encodeURIComponent(email)}` : path;
}

export function json(statusCode, body, headers) {
  return { statusCode, body: JSON.stringify(body), ...(headers ? { headers } : {}) };
}

export function ticketError(err) {
  const status = Number(err.statusCode);
  const retryAfter = Number(err.retryAfter);
  return json(status >= 400 && status < 600 ? status : 500, { ok: false, error: err.message, ...(err.duplicateOf ? { duplicateOf: err.duplicateOf } : {}) },
    retryAfter > 0 ? { "Retry-After": String(retryAfter) } : undefined);
}
