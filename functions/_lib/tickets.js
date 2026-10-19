const DEFAULT_BASE_URL = "https://tickets.96ghq.com/api/v1";

// reads: the key for the polling reads (ticket list, one ticket, the agent roster). TICKETS_API_KEY_READS, when set, is a second key of the same kind
// used only for those, because the ticket system's limit (120 calls a minute) is per key: with reads on their own key, agents polling for news can
// never use up the calls a claim, an edit or a comment needs. Unset: everything uses TICKETS_API_KEY as before.
// TICKETS_API_KEY_READS may hold several keys separated by commas: the agents are spread over them by a stable hash of their email (one agent
// always uses the same key, so their reads stay cached together), so every key carries a share of the polling and the total limit is the sum.
function readKeyFor(env, path = "") {
  const keys = String(env.TICKETS_API_KEY_READS || "").split(",").map((key) => key.trim()).filter(Boolean);
  if (!keys.length) return "";
  if (keys.length === 1) return keys[0];
  const who = new URLSearchParams(String(path).split("?")[1] || "").get("onBehalfOf") || "";
  let hash = 5381;
  for (const character of who.toLowerCase()) hash = ((hash * 33) ^ character.charCodeAt(0)) >>> 0;
  return keys[hash % keys.length];
}
function config(env = {}, { reads = false, path = "" } = {}) {
  const apiKey = String((reads && readKeyFor(env, path)) || env.TICKETS_API_KEY || "").trim();
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
const rateLimitedUntil = new Map(); // api key -> time until which this isolate stops calling with it (each key has its own limit)
export function resetTicketRateLimit() { rateLimitedUntil.clear(); }

function busyError(seconds) {
  const wait = Math.max(1, Math.ceil(seconds));
  const error = new Error(`The ticket system is busy (request limit reached). Try again in ${wait} s.`);
  error.statusCode = 429;
  error.retryAfter = wait;
  return error;
}

export async function ticketRequest(env, path, options = {}) {
  const { reads = false, ...callOptions } = options;
  const { apiKey, baseUrl } = config(env, { reads, path });
  if (!apiKey) throw new Error("Ticket API key is not configured");
  const pausedUntil = rateLimitedUntil.get(apiKey) || 0;
  if (pausedUntil > Date.now()) throw busyError((pausedUntil - Date.now()) / 1000);
  const isMultipart = typeof FormData !== "undefined" && callOptions.body instanceof FormData;
  const { timeoutMs, signal: callerSignal, ...fetchOptions } = callOptions;
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
    rateLimitedUntil.set(apiKey, Date.now() + wait * 1000);
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
    // An update (PATCH) answers with a machine-readable code and, when it has several problems or a failed expect, their details.
    if (data.code) error.ticketCode = String(data.code);
    if (data.problems && typeof data.problems === "object") error.problems = data.problems;
    if (Array.isArray(data.mismatched)) error.mismatched = data.mismatched;
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
  const { apiKey, baseUrl } = config(env, { reads: true, path });
  const key = `${baseUrl}|${apiKey}|${path}`;
  const stored = readCache.get(key);
  if (!fresh && ttlMs > 0 && stored && Date.now() - stored.at < ttlMs) return stored.data;
  if (readsInFlight.has(key)) return readsInFlight.get(key);
  const pending = ticketRequest(env, path, { reads: true })
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
  return json(status >= 400 && status < 600 ? status : 500, {
    ok: false, error: err.message, ...(err.duplicateOf ? { duplicateOf: err.duplicateOf } : {}),
    ...(err.ticketCode ? { code: err.ticketCode } : {}), ...(err.problems ? { problems: err.problems } : {}), ...(err.mismatched ? { mismatched: err.mismatched } : {}),
  },
    retryAfter > 0 ? { "Retry-After": String(retryAfter) } : undefined);
}
