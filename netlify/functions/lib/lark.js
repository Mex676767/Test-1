const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const BASE_APP_TOKEN = process.env.LARK_BASE_APP_TOKEN;

const TABLE_CUSTOMER_APPROACHING = process.env.LARK_TABLE_CUSTOMER_APPROACHING;
const TABLE_ANG_PAO = process.env.LARK_TABLE_ANG_PAO;
const TABLE_REDEEM_CODE = process.env.LARK_TABLE_REDEEM_CODE;

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

async function createRecord(tableId, fields) {
  const token = await getTenantToken();
  const res = await fetch(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records`,
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
function toDisplay(v) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(toDisplay).filter(Boolean).join(", ");
  if (typeof v === "object") {
    if ("value" in v) return toDisplay(v.value);
    if ("text" in v) return String(v.text);
    if ("name" in v) return String(v.name);
    if ("link" in v) return String(v.link);
    return JSON.stringify(v);
  }
  return String(v);
}

module.exports = {
  getTenantToken, searchRecords, getRecord, updateRecord, createRecord,
  listRecords, toDisplay,
  TABLE_CUSTOMER_APPROACHING, TABLE_ANG_PAO, TABLE_REDEEM_CODE,
};
