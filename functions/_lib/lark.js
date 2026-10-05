// Lark API helpers -- field-by-field the same logic that's been fixed
// against real Lark data over many rounds.
//
// These used to be `const X = process.env.Y` read once at module-load time
// -- confirmed broken (2026-09-18, real "LARK_APP_ID / LARK_APP_SECRET not
// set" error on a live deploy with the env vars genuinely bound in
// Cloudflare's dashboard): a Worker/Pages Function's module evaluates once,
// BEFORE any request's actual handler runs, so process.env is still empty
// at that point no matter what env vars are bound -- there's no way to
// read them from a top-level const in time. Fixed with `let` + initEnv(),
// called at the start of every request (see adapt.js). ES module named
// exports are live bindings, not copied snapshots, so every file that
// imports e.g. TABLE_PNL still sees the update after initEnv() runs, with
// zero changes needed to any of those files.
let APP_ID, APP_SECRET, BASE_APP_TOKEN;
let TABLE_CUSTOMER_APPROACHING, TABLE_REDEEM_CODE, TABLE_PNL;
let TABLE_GRACE_PERIOD, TABLE_TOP_PNL_NIGHT, TABLE_LTV_DAY, TABLE_RISK_PLAYER, TABLE_SPECIAL_RELOAD, TABLE_VIP_BOOSTER;
let ESCALATION_BASE_TOKEN, TABLE_ESCALATION;
let TABLE_TELEGRAM28;
let TABLE_MOONCAKE;
let TABLE_VS96_FEEDBACK;
let TABLE_BONUS_CONFIG;
let LARK_SEARCH_QUEUE;

export function initEnv(env) {
  LARK_SEARCH_QUEUE = env.LARK_SEARCH_QUEUE;
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
}

const larkQueueResponses = new WeakMap();
const LARK_QUEUE_RPC_TIMEOUT_MS = 250;

function bestEffortQueueCall(stub, method, ...args) {
  try {
    void Promise.resolve(stub[method](...args)).catch(() => {});
  } catch {
    // A broken coordinator must not break the request it was meant to guard.
  }
}

function callQueueAcquire(stub, signal) {
  const pending = Promise.resolve().then(() => stub.acquire());
  let abandoned = false;
  // If the RPC eventually grants a permit after the local request has timed
  // out, return that lease so a slow coordinator cannot strand capacity.
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
    }, LARK_QUEUE_RPC_TIMEOUT_MS);
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

async function acquireSharedLarkPermit(signal) {
  if (!LARK_SEARCH_QUEUE) return null;
  const stub = LARK_SEARCH_QUEUE.get(LARK_SEARCH_QUEUE.idFromName("lark-api-global"));
  while (!signal?.aborted) {
    let permit;
    try {
      permit = await callQueueAcquire(stub, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      // The local semaphore remains the fallback if the shared coordinator
      // is unhealthy. Do not let a hung RPC hold up the lookup.
      return null;
    }
    if (permit?.ticket) return { stub, ticket: permit.ticket };
    await waitForLarkPermit(Math.min(250, Math.max(50, Number(permit?.retryAfterMs) || 100)), signal);
  }
  throw abortError(signal);
}

async function larkFetch(url, init = {}) {
  const permit = await acquireSharedLarkPermit(init.signal);
  try {
    const response = await fetch(url, init);
    if (permit) {
      larkQueueResponses.set(response, permit.stub);
      // Releases are best-effort. The lease expires automatically if the RPC
      // fails, while waiting here could outlive the Lark response itself.
      bestEffortQueueCall(permit.stub, "release", permit.ticket, response.status === 429,
        Number(response.headers.get("Retry-After")) * 1000 || 0);
    }
    return response;
  } catch (error) {
    if (permit) bestEffortQueueCall(permit.stub, "release", permit.ticket, false, 0);
    throw error;
  }
}

export function reportSharedLarkRateLimit(response, retryAfterMs = 0) {
  const stub = larkQueueResponses.get(response);
  if (stub) bestEffortQueueCall(stub, "penalize", Number(retryAfterMs) || 0);
}

let cachedToken = null;
let cachedExpiry = 0;
// De-dupes concurrent callers on a cold cache -- lark-search.js fires ~9
// parallel Lark calls (P&L, Top 10 P&L, LTV, Grace Period, Risk Player, VIP
// Booster, Special Reload, Telegram28, Redeem Code), each needing a tenant
// token. Without this, every one of them would race to fetch its own token
// the moment cachedToken is empty (e.g. a cold function instance), firing
// up to 9 simultaneous auth requests at Lark -- confirmed live as a likely
// cause of an intermittent "record created but response wasn't valid JSON"
// failure (2026-09-19): the resulting rate-limit/slowdown stalled the whole
// request past Cloudflare's own function time limit, which serves its own
// HTML error page in place of our JSON, well after the record had already
// been created earlier in the same handler. Every caller now awaits the
// same in-flight request instead of starting a new one.
let inFlightTokenRequest = null;

// Keep one lookup (which fans out across many tables) from sending a burst
// of concurrent search requests through a warm Worker isolate. This is a
// per-isolate guard; Lark still enforces app-wide limits across isolates.
const MAX_CONCURRENT_LARK_SEARCHES = 3;
let activeLarkSearches = 0;
let larkSearchQueue = [];
let larkSearchCooldownUntil = 0;
const inFlightLarkSearches = new Map();

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
    // Recheck after listener registration so an abort cannot leave a dead
    // waiter occupying the queue indefinitely.
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
    next.resolve(); // Transfer this slot directly to the next live waiter.
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
        signal: AbortSignal.timeout(6_000),
        body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
      });
      const data = await res.json();
      if (data.code !== 0) throw new Error("Lark auth failed: " + data.msg);
      cachedToken = data.tenant_access_token;
      cachedExpiry = Date.now() + data.expire * 1000;
      return cachedToken;
    } finally {
      inFlightTokenRequest = null;
    }
  })();
  return inFlightTokenRequest;
}

// opts.pageSize: Lark's search defaults to only 20 rows per page -- fine for
// the per-username lookups everywhere else, too few for a table-wide sweep
// (see lark-stale-records.js). opts.automaticFields adds created_time etc.
export function searchRecords(tableId, conditions, baseToken, opts = {}) {
  if (!tableId) throw new Error("Missing table ID — check env vars.");
  const cacheKey = JSON.stringify({
    baseToken: baseToken || BASE_APP_TOKEN,
    tableId,
    conditions,
    pageSize: opts.pageSize || null,
    automaticFields: !!opts.automaticFields,
    fieldNames: opts.fieldNames || null,
  });
  const existing = inFlightLarkSearches.get(cacheKey);
  if (existing) return existing;
  const request = performSearchRecords(tableId, conditions, baseToken, opts);
  inFlightLarkSearches.set(cacheKey, request);
  request.then(
    () => { if (inFlightLarkSearches.get(cacheKey) === request) inFlightLarkSearches.delete(cacheKey); },
    () => { if (inFlightLarkSearches.get(cacheKey) === request) inFlightLarkSearches.delete(cacheKey); },
  );
  return request;
}

async function performSearchRecords(tableId, conditions, baseToken, opts) {
  // Each lookup fans out across many Lark tables. Repeating a slow/throttled
  // request several times made one unavailable bonus hold the whole panel
  // open; bound each request and return that source as unavailable instead.
  let lastErr;
  // Retry one time for transient errors and throttles. The shared queue and
  // bounded cooldown spread that retry across isolates instead of making the
  // agent repeat the entire lookup manually.
  const requestedAttempts = Number(opts.maxAttempts ?? 2);
  const maxAttempts = Math.max(1, Math.min(2, Number.isFinite(requestedAttempts) ? requestedAttempts : 2));
  const timeoutMs = opts.timeoutMs || 5_000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let hasSlot = false;
    try {
      // The timeout includes time waiting for a local slot and the shared
      // token request; previously it only started after the slot was granted.
      await acquireLarkSearchSlot(controller.signal);
      hasSlot = true;
      await waitForLarkSearchCooldown(controller.signal);
      const token = await awaitWithSignal(getTenantToken(), controller.signal);
      const res = await larkFetch(
        `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseToken || BASE_APP_TOKEN}/tables/${tableId}/records/search`
          + (opts.pageSize ? `?page_size=${opts.pageSize}` : ""),
        { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          signal: controller.signal,
          body: JSON.stringify({
            filter: { conjunction: "and", conditions },
            ...(opts.automaticFields ? { automatic_fields: true } : {}),
            ...(opts.fieldNames?.length ? { field_names: opts.fieldNames } : {}),
          }) }
      );
      const data = await res.json();
      if (data.code !== 0) {
        const limited = res.status === 429 || Number(data.code) === 99991400 || /too many requests|rate.?limit/i.test(String(data.msg || ""));
        const err = new Error(limited
          ? `Lark is rate-limiting searches (table ${tableId}): ${data.msg || "Too many requests"}`
          : `Lark search failed on table ${tableId}: ${data.msg}`);
        err.rateLimited = limited;
        // Lark may return schema/permission errors in an HTTP 200 response.
        // A 429 is surfaced immediately instead of retrying every bonus table
        // in the same request and worsening app-wide contention.
        err.retryable = limited || (
          res.status === 408 || res.status >= 500
          || /internal|temporar|timeout|server error|system busy/i.test(String(data.msg || ""))
        );
        err.retryAfterMs = Number(res.headers.get("Retry-After")) * 1000 || 0;
        if (limited) reportSharedLarkRateLimit(res, err.retryAfterMs);
        throw err;
      }
      return data.data.items || [];
    } catch (err) {
      if (controller.signal.aborted) {
        lastErr = new Error(`Lark search timed out after ${Math.round(timeoutMs / 1000)} seconds (table ${tableId}).`);
        lastErr.retryable = true;
      } else {
        lastErr = err;
      }
      if (lastErr.rateLimited) {
        // Retry-After can be tens of seconds. Honor it as a short shared
        // backoff only; each request reports the throttle so the UI can show
        // a partial result and agents can retry manually after the load eases.
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

// Same as searchRecords, but follows Lark's page_token across up to
// maxPages pages of 500 -- for scans that can outgrow a single page.
export async function searchAllRecords(tableId, conditions, { maxPages = 5, automaticFields = false } = {}) {
  if (!tableId) throw new Error("Missing table ID — check env vars.");
  const token = await getTenantToken();
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
        }) }
    );
    const data = await res.json();
    if (data.code !== 0) throw new Error(`Lark search failed on table ${tableId}: ${data.msg}`);
    all.push(...(data.data.items || []));
    if (!data.data.has_more || !data.data.page_token) break;
    pageToken = data.data.page_token;
  }
  return all;
}

export async function getRecord(tableId, recordId) {
  const token = await getTenantToken();
  const res = await larkFetch(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records/${recordId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark getRecord failed: ${data.msg}`);
  return data.data.record;
}

export async function updateRecord(tableId, recordId, fields, baseToken) {
  const token = await getTenantToken();
  const res = await larkFetch(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseToken || BASE_APP_TOKEN}/tables/${tableId}/records/${recordId}`,
    { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields }) }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark update failed on table ${tableId}: ${data.msg}`);
  return data.data.record;
}

export async function createRecord(tableId, fields, baseToken) {
  const token = await getTenantToken();
  const res = await larkFetch(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseToken || BASE_APP_TOKEN}/tables/${tableId}/records`,
    { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields }) }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark create failed on table ${tableId}: ${data.msg}`);
  return data.data.record;
}

export async function deleteRecord(tableId, recordId, baseToken) {
  const token = await getTenantToken();
  const res = await larkFetch(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseToken || BASE_APP_TOKEN}/tables/${tableId}/records/${recordId}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark delete failed on table ${tableId}: ${data.msg}`);
  return true;
}

export async function listRecords(tableId, pageSize = 500) {
  const token = await getTenantToken();
  const res = await larkFetch(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records?page_size=${pageSize}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark listRecords failed: ${data.msg}`);
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

export async function listFields(tableId, baseToken) {
  const token = await getTenantToken();
  const res = await larkFetch(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseToken || BASE_APP_TOKEN}/tables/${tableId}/fields?page_size=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark listFields failed on table ${tableId}: ${data.msg}`);
  return data.data.items || [];
}

const fieldOptionMapCache = new Map(); // key -> { map, expiry }

// fresh: true skips (and doesn't populate) the 10-min cache -- for the
// dropdown-list endpoints (Agent Name/Brand/Inquiry/Status), which are only
// ever called at boot and on a slow periodic refresh (a handful of times an
// hour, not once per Look Up like Tier resolution below), so there's no
// real cost to always reading Lark's current option list. Confirmed live:
// an agent added a new Agent Name and removed an Inquiry tag in Lark and
// neither change was reflected in the app for up to 10 minutes (or longer,
// since these were previously only ever fetched once at page load).
export async function getFieldOptionMap(tableId, fieldName, baseToken, { fresh = false } = {}) {
  const key = (baseToken || BASE_APP_TOKEN) + "::" + tableId + "::" + fieldName;
  if (!fresh) {
    const cached = fieldOptionMapCache.get(key);
    if (cached && Date.now() < cached.expiry) return cached.map;
  }

  const fields = await listFields(tableId, baseToken);
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

export async function findOldestClaimableRow(tableId, username, brand, isClaimable, baseToken, { usernameField, brandField, dateField, newest, fieldNames } = {}) {
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
      matches = await searchRecords(tableId, conditions, baseToken, { pageSize: 500, automaticFields: true, fieldNames });
      break;
    } catch (err) {
      lastErr = err;
      // A field projection is only an optimization. If this table's schema
      // doesn't contain one of the requested columns, retry without it so an
      // otherwise valid bonus row isn't lost because of projection.
      if (fieldNames?.length && err.retryable === false && !err.rateLimited) {
        try {
          matches = await searchRecords(tableId, conditions, baseToken, { pageSize: 500, automaticFields: true });
          break;
        } catch (fallbackErr) {
          lastErr = fallbackErr;
          err = fallbackErr;
        }
      }
      // Older bonus tables use "Username" while most use "Username/UID".
      // Only try the alternate when Lark explicitly rejects the filter field;
      // a legitimate empty result should stay one request.
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
  // newest: true picks the most recent claimable row instead of the oldest.
  // Grace Period specifically needs this -- it's a recurring weekly
  // challenge, and an old cycle's own row can still read as "claimable"
  // (its SW Check / Activated text doesn't change once written) well after
  // a newer cycle has already started. Picking the oldest one there meant
  // the Reactivate button's expiry check (graceExpiryMs) compared against
  // a stale, already-past cycle's expiry even when a current, still-valid
  // cycle existed -- confirmed live: a genuinely not-yet-expired Grace
  // Period bonus wasn't showing Reactivate at all. Every other bonus table
  // still wants the oldest (FIFO -- give the earliest-earned one first), so
  // this defaults to the old behavior everywhere else.
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
};
