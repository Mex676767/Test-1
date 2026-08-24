const { getTenantToken } = require("./lib/lark");

const BASE_APP_TOKEN = process.env.LARK_BASE_APP_TOKEN;
const TABLE_CA = process.env.LARK_TABLE_CUSTOMER_APPROACHING;

function toDisplay(v) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(toDisplay).filter(Boolean).join(", ");
  if (typeof v === "object") {
    if ("value" in v) return toDisplay(v.value);
    if ("text" in v) return String(v.text);
    if ("name" in v) return String(v.name);
    return "";
  }
  return String(v).trim();
}

exports.handler = async function () {
  try {
    if (!BASE_APP_TOKEN || !TABLE_CA) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, pics: [] }) };
    }
    const token = await getTenantToken();
    const res = await fetch(
      `https://open.larksuite.com/open-apis/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${TABLE_CA}/records?page_size=500`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    if (data.code !== 0) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, pics: [] }) };
    }
    const seen = new Set();
    for (const record of (data.data.items || [])) {
      const pic = toDisplay(record.fields["PIC"]);
      if (pic) seen.add(pic);
    }
    const pics = [...seen].sort();
    return { statusCode: 200, body: JSON.stringify({ ok: true, pics }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, pics: [], error: err.message }) };
  }
};
