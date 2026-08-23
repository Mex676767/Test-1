// Shared Lark Bitable client. All secrets come from Netlify environment
// variables (Site settings -> Environment variables) — never hardcode them
// here, and this file never ships to the browser since it only runs inside
// Netlify Functions.
//
// Required env vars:
//   LARK_APP_ID                  - from Lark Developer Console credentials
//   LARK_APP_SECRET              - from Lark Developer Console credentials
//   LARK_BASE_APP_TOKEN          - the JP test base's token (from its URL)
//   LARK_TABLE_CUSTOMER_APPROACHING - tbl6gqRDSlpuvdSC
//   LARK_TABLE_ANG_PAO           - tblxxz5EUdRbR4qk
//   LARK_TABLE_REDEEM_CODE       - tbl6cMG2f036Bn5E

const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const BASE_APP_TOKEN = process.env.LARK_BASE_APP_TOKEN;

const TABLE_CUSTOMER_APPROACHING = process.env.LARK_TABLE_CUSTOMER_APPROACHING;
const TABLE_ANG_PAO = process.env.LARK_TABLE_ANG_PAO;
const TABLE_REDEEM_CODE = process.env.LARK_TABLE_REDEEM_CODE;

// Cached in-memory per warm function instance — avoids re-authenticating on
// every call within the same instance's lifetime (tokens last ~2 hours).
let cachedToken = null;
let cachedExpiry = 0;

async function getTenantToken() {
  const now = Date.now();
  if (cachedToken && now < cachedExpiry - 60_000) return cachedToken;

  if (!APP_ID || !APP_SECRET) {
    throw new Error("LARK_APP_ID / LARK_APP_SECRET not set in Netlify environment variables.");
  }

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
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ filter: { conjunction: "and", conditions } }),
    }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark search failed on table ${tableId}: ${data.msg}`);
  return data.data.items || [];
}

async function updateRecord(tableId, recordId, fields) {
  const token = await getTenantToken();
  const res = await fetch(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records/${recordId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields }),
    }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark update failed on table ${tableId}: ${data.msg}`);
  return data.data.record;
}

async function createRecord(tableId, fields) {
  const token = await getTenantToken();
  const res = await fetch(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields }),
    }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark create failed on table ${tableId}: ${data.msg}`);
  return data.data.record;
}

module.exports = {
  getTenantToken,
  searchRecords,
  updateRecord,
  createRecord,
  TABLE_CUSTOMER_APPROACHING,
  TABLE_ANG_PAO,
  TABLE_REDEEM_CODE,
};
