const { getFieldOptionMap, TABLE_CUSTOMER_APPROACHING } = require("./lib/lark");

// Agent Name is now a Single Option field directly on Customer Approaching
// (previously a separate Agent List table, kept in sync by hand). Reusing
// getFieldOptionMap (same helper Tier resolution uses, already caches for
// 10 min) means the dropdown here always matches whatever options exist on
// that field in Lark — add/rename an option there and it shows up on next
// load, no separate table or LARK_TABLE_AGENT_LIST env var to maintain.
exports.handler = async function () {
  try {
    const optionMap = await getFieldOptionMap(TABLE_CUSTOMER_APPROACHING, "Agent Name");
    const names = Array.from(optionMap.values()).filter(Boolean).sort();
    return { statusCode: 200, body: JSON.stringify({ ok: true, pics: names }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, pics: [] }) };
  }
};
