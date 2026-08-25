const { getTenantToken, toDisplay } = require("./lib/lark");
const BASE_APP_TOKEN = process.env.LARK_BASE_APP_TOKEN;
const TABLE_AGENT = process.env.LARK_TABLE_AGENT_LIST;
exports.handler = async function () {
  try {
    if (!BASE_APP_TOKEN || !TABLE_AGENT) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, pics: [] }) };
    }
    const token = await getTenantToken();
    const res = await fetch(
      "https://open.larksuite.com/open-apis/bitable/v1/apps/" + BASE_APP_TOKEN + "/tables/" + TABLE_AGENT + "/records?page_size=500",
      { headers: { Authorization: "Bearer " + token } }
    );
    const data = await res.json();
    if (data.code !== 0) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, pics: [] }) };
    }
    var names = [];
    for (var i = 0; i < (data.data.items || []).length; i++) {
      var name = toDisplay(data.data.items[i].fields["Agent Name"]);
      if (name) names.push(name);
    }
    names.sort();
    return { statusCode: 200, body: JSON.stringify({ ok: true, pics: names }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, pics: [] }) };
  }
};
