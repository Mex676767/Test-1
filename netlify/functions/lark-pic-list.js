const { getTenantToken, toDisplay } = require("./lib/lark");
const BASE_APP_TOKEN = process.env.LARK_BASE_APP_TOKEN;
const TABLE_CA = process.env.LARK_TABLE_CUSTOMER_APPROACHING;
exports.handler = async function () {
  try {
    if (!BASE_APP_TOKEN || !TABLE_CA) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, pics: [] }) };
    }
    const token = await getTenantToken();
    const res = await fetch(
      "https://open.larksuite.com/open-apis/bitable/v1/apps/" + BASE_APP_TOKEN + "/tables/" + TABLE_CA + "/records?page_size=500",
      { headers: { Authorization: "Bearer " + token } }
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
    return { statusCode: 200, body: JSON.stringify({ ok: true, pics: [...seen].sort() }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, pics: [] }) };
  }
};
