const DEFAULT_BASE_URL = "https://tickets.96ghq.com/api/v1";

export function readKeys(env = {}) {
  const numbered = Object.keys(env)
    .map((name) => ({ name, match: /^TICKETS_API_KEY(?:_READS_?)?(\d+)$/.exec(name) }))
    .filter(({ match }) => match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]) || a.name.localeCompare(b.name))
    .map(({ name }) => String(env[name] || "").trim());
  const listed = String(env.TICKETS_API_KEY_READS || "").split(",").map((key) => key.trim());
  return [...new Set([...listed, ...numbered].filter(Boolean))];
}
function readKeyFor(env, path = "") {
  const keys = readKeys(env);
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

const TICKET_TIMEOUT_MS = 15_000;
const TICKET_UPLOAD_TIMEOUT_MS = 30_000;

const DEFAULT_RETRY_AFTER_S = 20;
const rateLimitedUntil = new Map();
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
    if (data.code) error.ticketCode = String(data.code);
    if (data.problems && typeof data.problems === "object") error.problems = data.problems;
    if (Array.isArray(data.mismatched)) error.mismatched = data.mismatched;
    throw error;
  }
  return data;
}

const MAX_CACHED_READS = 300;
const readCache = new Map();
const readsInFlight = new Map();
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
