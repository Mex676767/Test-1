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

export function initEnv(env) {
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

export async function getTenantToken() {
  const now = Date.now();
  if (cachedToken && now < cachedExpiry - 60_000) return cachedToken;
  if (inFlightTokenRequest) return inFlightTokenRequest;
  if (!APP_ID || !APP_SECRET) throw new Error("LARK_APP_ID / LARK_APP_SECRET not set.");
  inFlightTokenRequest = (async () => {
    try {
      const res = await fetch("https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

export async function searchRecords(tableId, conditions, baseToken) {
  if (!tableId) throw new Error("Missing table ID — check env vars.");
  // Retries once (2 attempts total, brief pause between) before giving up.
  // lark-search.js runs ~9 of these in parallel per Look Up, each behind
  // its own .catch(() => null) so one bonus's failure doesn't break the
  // whole lookup -- but that also meant a transient blip (network hiccup,
  // momentary 5xx, Lark rate-limiting under 9x the concurrent load since
  // parallelizing those calls) silently dropped that one bonus from the
  // response with zero indication anything went wrong. Confirmed live: the
  // same player's Telegram RM28 ticket intermittently not showing up on a
  // re-lookup with no underlying data change in between.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const token = await getTenantToken();
      const res = await fetch(
        `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseToken || BASE_APP_TOKEN}/tables/${tableId}/records/search`,
        { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ filter: { conjunction: "and", conditions } }) }
      );
      const data = await res.json();
      if (data.code !== 0) throw new Error(`Lark search failed on table ${tableId}: ${data.msg}`);
      return data.data.items || [];
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastErr;
}

export async function getRecord(tableId, recordId) {
  const token = await getTenantToken();
  const res = await fetch(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records/${recordId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark getRecord failed: ${data.msg}`);
  return data.data.record;
}

export async function updateRecord(tableId, recordId, fields, baseToken) {
  const token = await getTenantToken();
  const res = await fetch(
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
  const res = await fetch(
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
  const res = await fetch(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseToken || BASE_APP_TOKEN}/tables/${tableId}/records/${recordId}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark delete failed on table ${tableId}: ${data.msg}`);
  return true;
}

export async function listRecords(tableId, pageSize = 500) {
  const token = await getTenantToken();
  const res = await fetch(
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
  const res = await fetch(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseToken || BASE_APP_TOKEN}/tables/${tableId}/fields?page_size=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark listFields failed on table ${tableId}: ${data.msg}`);
  return data.data.items || [];
}

const fieldOptionMapCache = new Map(); // key -> { map, expiry }

export async function getFieldOptionMap(tableId, fieldName, baseToken) {
  const key = (baseToken || BASE_APP_TOKEN) + "::" + tableId + "::" + fieldName;
  const cached = fieldOptionMapCache.get(key);
  if (cached && Date.now() < cached.expiry) return cached.map;

  const fields = await listFields(tableId, baseToken);
  const field = fields.find((f) => f.field_name === fieldName);
  const options = field && field.property && field.property.options;
  const map = new Map((options || []).map((o) => [o.id, o.name]));
  fieldOptionMapCache.set(key, { map, expiry: Date.now() + 10 * 60_000 });
  return map;
}

function findTimeOfInspection(fields, dateFieldName) {
  if (dateFieldName) return fields[dateFieldName] ?? 0;
  const key = Object.keys(fields).find((k) => k.trim().toLowerCase() === "time of inspection");
  return key ? fields[key] : 0;
}

export async function findOldestClaimableRow(tableId, username, brand, isClaimable, baseToken, { usernameField, dateField, newest } = {}) {
  if (!tableId) return null;
  const matches = await searchRecords(tableId, [
    { field_name: usernameField || "Username/UID", operator: "is", value: [username] },
    { field_name: "Brand", operator: "is", value: [brand] },
  ], baseToken);
  const claimable = matches.filter((r) => isClaimable(r.fields));
  if (!claimable.length) return null;
  claimable.sort((a, b) => (findTimeOfInspection(a.fields, dateField) || 0) - (findTimeOfInspection(b.fields, dateField) || 0));
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
};
