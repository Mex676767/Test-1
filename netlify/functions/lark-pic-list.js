const { getTenantToken, toDisplay } = require("./lib/lark");

const BASE_APP_TOKEN = process.env.LARK_BASE_APP_TOKEN;
const TABLE_CA = process.env.LARK_TABLE_CUSTOMER_APPROACHING;

exports.handler = async function () {
  try {
    if (!BASE_APP_TOKEN || !TABLE_CA) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, pics: [] }) };
    }
    const token = await getTenantToken();
    const seen = new Set();
    let pageToken = null;

    // Paginate through ALL records to catch every PIC value
    do {
      const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${TABLE_CA}/records?page_size=500${pageToken ? `&page_token=${pageToken}` : ""}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.code !== 0) break;
      for (const record of (data.data.items || [])) {
        const pic = toDisplay(record.fields["PIC"]);
        if (pic) seen.add(pic);
      }
      pageToken = data.data.has_more ? data.data.page_token : null;
    } while (pageToken);

    const pics = [...seen].sort();
    return { statusCode: 200, body: JSON.stringify({ ok: true, pics }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, pics: [], error: err.message }) };
  }
};
