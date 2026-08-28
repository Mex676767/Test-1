const { getFieldOptionMap, TABLE_CUSTOMER_APPROACHING } = require("./lib/lark");

// Backs the Brand dropdown with Lark's actual configured option list, so it
// can never drift out of sync with whatever brands are added/renamed on the
// Lark side (unlike a hardcoded list baked into app.js).
exports.handler = async function () {
  try {
    if (!TABLE_CUSTOMER_APPROACHING) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, brands: [] }) };
    }
    const optionMap = await getFieldOptionMap(TABLE_CUSTOMER_APPROACHING, "Brand");
    const brands = Array.from(optionMap.values()).sort();
    return { statusCode: 200, body: JSON.stringify({ ok: true, brands }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, brands: [] }) };
  }
};
