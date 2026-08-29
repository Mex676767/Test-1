const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const BASE_APP_TOKEN = process.env.LARK_BASE_APP_TOKEN;

const TABLE_CUSTOMER_APPROACHING = process.env.LARK_TABLE_CUSTOMER_APPROACHING;
const TABLE_ANG_PAO = process.env.LARK_TABLE_ANG_PAO;
const TABLE_REDEEM_CODE = process.env.LARK_TABLE_REDEEM_CODE;
// Source table for Customer Approaching's "Tier" Lookup field. Lark doesn't
// mirror the Single Select option list onto the Lookup field itself, so
// resolving option IDs to display text ("Tier V") requires reading the
// option list straight off this table's own "Tier" field. Also now queried
// directly (by Username + Brand) for Tier itself — see lark-search.js.
const TABLE_PNL = process.env.LARK_TABLE_PNL;

// Each of these is its own bonus-program table (2026-08-29 rearchitecture —
// previously all 5 were read as Lookup columns on Customer Approaching,
// which took 15-30s to resolve on a big base; now queried directly by
// Username/UID + Brand, which is immediate). Every brand technically lives
// in its own "sheet" (a Lark view) within each table, but every record also
// carries a plain Brand field, so filtering on Username/UID + Brand together
// scopes to exactly that brand's rows without needing a view ID.
const TABLE_GRACE_PERIOD = process.env.LARK_TABLE_GRACE_PERIOD;
const TABLE_TOP_PNL_NIGHT = process.env.LARK_TABLE_TOP_PNL_NIGHT;
const TABLE_LTV_DAY = process.env.LARK_TABLE_LTV_DAY;
const TABLE_RISK_PLAYER = process.env.LARK_TABLE_RISK_PLAYER;
const TABLE_SPECIAL_RELOAD = process.env.LARK_TABLE_SPECIAL_RELOAD;
const TABLE_VIP_BOOSTER = process.env.LARK_TABLE_VIP_BOOSTER;

// Escalation tickets (C9MYR CS-PYM ESCALATION) live on an entirely separate
// Lark base from everything above — a different department's base, granted
// to this same app as a collaborator (2026-08-30). Every function below
// that touches a specific base now takes an optional baseToken override,
// defaulting to BASE_APP_TOKEN, so this second base doesn't need its own
// copy of every helper.
const ESCALATION_BASE_TOKEN = process.env.LARK_ESCALATION_BASE_TOKEN;
const TABLE_ESCALATION = process.env.LARK_ESCALATION_TABLE;

let cachedToken = null;
let cachedExpiry = 0;

async function getTenantToken() {
  const now = Date.now();
  if (cachedToken && now < cachedExpiry - 60_000) return cachedToken;
  if (!APP_ID || !APP_SECRET) throw new Error("LARK_APP_ID / LARK_APP_SECRET not set.");
  const res = await fetch("https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error("Lark auth failed: " + data.msg);
  cachedToken = data.tenant_access_token;
  cachedExpiry = now + data.expire * 1000;
  return cachedToken;
}

async function searchRecords(tableId, conditions) {
  if (!tableId) throw new Error("Missing table ID — check Netlify env vars.");
  const token = await getTenantToken();
  const res = await fetch(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records/search`,
    { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ filter: { conjunction: "and", conditions } }) }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark search failed on table ${tableId}: ${data.msg}`);
  return data.data.items || [];
}

async function getRecord(tableId, recordId) {
  const token = await getTenantToken();
  const res = await fetch(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records/${recordId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark getRecord failed: ${data.msg}`);
  return data.data.record;
}

async function updateRecord(tableId, recordId, fields) {
  const token = await getTenantToken();
  const res = await fetch(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records/${recordId}`,
    { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields }) }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark update failed on table ${tableId}: ${data.msg}`);
  return data.data.record;
}

async function createRecord(tableId, fields, baseToken) {
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

async function listRecords(tableId, pageSize = 500) {
  const token = await getTenantToken();
  const res = await fetch(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records?page_size=${pageSize}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark listRecords failed: ${data.msg}`);
  return data.data.items || [];
}

// Lark returns Lookup/Formula/Link/Person fields as nested objects/arrays.
// This recursively unwraps any shape down to a plain display string.
// Pass optionMap (from getFieldOptionMap below) when the field is a Lookup
// over a Single/Multi Select column — Lark hands back the option's raw ID
// (e.g. "optp2Z4fis") instead of its display text in that shape, unlike a
// Select field on the record's own table, which already comes as plain text.
function toDisplay(v, optionMap) {
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

async function listFields(tableId, baseToken) {
  const token = await getTenantToken();
  const res = await fetch(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseToken || BASE_APP_TOKEN}/tables/${tableId}/fields?page_size=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark listFields failed on table ${tableId}: ${data.msg}`);
  return data.data.items || [];
}

// Caches id -> name maps per (baseToken, tableId, fieldName) for 10 minutes
// — option lists rarely change, and this avoids an extra API round trip on
// every poll.
const fieldOptionMapCache = new Map(); // key -> { map, expiry }

// Returns the full option list (id -> name) for any Single/Multi Select
// field. Most callers only want the plain names (Array.from(map.values())),
// but the map form is also what resolves a Lookup's raw option ID back to
// its display text (see toDisplay/resolveOption above).
async function getFieldOptionMap(tableId, fieldName, baseToken) {
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

// Finds the single claimable row for a per-brand bonus table (Risk Player,
// Grace Period, Top 10 P&L, LTV, 12hour VIP Booster, Special Reload Event).
// Multiple claimable rows can exist at once (e.g. several day-tiers still
// unclaimed, or several unclaimed nights) but only the OLDEST one (by "Time
// of Inspection") should ever surface, so CS works through them in order
// instead of always seeing the newest. isClaimable receives the record's
// raw fields object and decides whether that row counts at all.
// "Time of Inspection" isn't spelled consistently across tables (confirmed:
// Grace Period(Day) actually has "Time of inspection", lowercase "i") — look
// it up case-insensitively per row instead of hardcoding one casing, since a
// silent no-match here doesn't error, it just makes the sort a no-op and can
// let an actually-expired row (returned in unpredictable order by the search
// API) get picked over the real claimable one.
function findTimeOfInspection(fields) {
  const key = Object.keys(fields).find((k) => k.trim().toLowerCase() === "time of inspection");
  return key ? fields[key] : 0;
}

async function findOldestClaimableRow(tableId, username, brand, isClaimable) {
  if (!tableId) return null;
  const matches = await searchRecords(tableId, [
    { field_name: "Username/UID", operator: "is", value: [username] },
    { field_name: "Brand", operator: "is", value: [brand] },
  ]);
  const claimable = matches.filter((r) => isClaimable(r.fields));
  if (!claimable.length) return null;
  claimable.sort((a, b) => (findTimeOfInspection(a.fields) || 0) - (findTimeOfInspection(b.fields) || 0));
  return claimable[0];
}

module.exports = {
  getTenantToken, searchRecords, getRecord, updateRecord, createRecord,
  listRecords, toDisplay, listFields, getFieldOptionMap, findOldestClaimableRow,
  TABLE_CUSTOMER_APPROACHING, TABLE_ANG_PAO, TABLE_REDEEM_CODE, TABLE_PNL,
  TABLE_GRACE_PERIOD, TABLE_TOP_PNL_NIGHT, TABLE_LTV_DAY, TABLE_RISK_PLAYER,
  TABLE_SPECIAL_RELOAD, TABLE_VIP_BOOSTER,
  ESCALATION_BASE_TOKEN, TABLE_ESCALATION,
};
