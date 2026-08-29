const { getFieldOptionMap, ESCALATION_BASE_TOKEN, TABLE_ESCALATION } = require("./lib/lark");

// Populates the Escalation Ticket section's 4 dropdowns (Brand, Queries,
// Payment Gateway, VIP Level) straight from that field's own Single Select
// options on the escalation table, same getFieldOptionMap pattern as Agent
// Name/Brand elsewhere in this app — so the list always matches whatever
// options actually exist there, no redeploy needed when the other team
// adds a new Query type or Brand code.
exports.handler = async function () {
  try {
    if (!ESCALATION_BASE_TOKEN || !TABLE_ESCALATION) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, brand: [], queries: [], paymentGateway: [], vipLevel: [] }) };
    }
    const [brandMap, queriesMap, pgMap, vipMap] = await Promise.all([
      getFieldOptionMap(TABLE_ESCALATION, "Brand", ESCALATION_BASE_TOKEN),
      getFieldOptionMap(TABLE_ESCALATION, "QUERIES", ESCALATION_BASE_TOKEN),
      getFieldOptionMap(TABLE_ESCALATION, "PG", ESCALATION_BASE_TOKEN),
      getFieldOptionMap(TABLE_ESCALATION, "VIP LEVEL", ESCALATION_BASE_TOKEN),
    ]);
    const names = (m) => Array.from(m.values()).filter(Boolean);
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        brand: names(brandMap),
        queries: names(queriesMap),
        paymentGateway: names(pgMap),
        vipLevel: names(vipMap),
      }),
    };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, brand: [], queries: [], paymentGateway: [], vipLevel: [], error: err.message }) };
  }
};
