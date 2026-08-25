const { getRecord, toDisplay, getFieldOptionMap, TABLE_CUSTOMER_APPROACHING } = require("./lib/lark");

// Called repeatedly by the frontend after lark-search.js creates a case row.
// On a large base, Lark can take 15-30s to resolve a freshly-created row's
// Lookup columns (Name customer, Tier, the 5 bonus programs, etc.) — far
// longer than Netlify's 10s function limit allows in one call. So instead of
// waiting server-side, each poll is a quick, single getRecord and the
// frontend decides when to stop: "Name customer" is itself a Lookup field,
// so it only appears once Lark has finished linking this row — a reliable
// signal that the rest of the row's Lookups are settled too.
const F = {
  pic: "PIC",
  tier: "Tier",
  nameCustomer: "Name customer",
  dob: "Player D.O.B",
  riskPlayer: "Risk Player",
  topPnl: "Top 10 P&L - Test",
  gracePeriod: "Grace Period 0.1",
  ltvTest: "LTV - Test",
  vipBooster: "12h VIP Deposit Booster",
};

exports.handler = async function (event) {
  try {
    const { recordId } = JSON.parse(event.body || "{}");
    if (!recordId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "recordId is required" }) };
    }

    const record = await getRecord(TABLE_CUSTOMER_APPROACHING, recordId);
    const f = record.fields;
    const nameCustomer = toDisplay(f[F.nameCustomer]);

    // Tier is a Lookup over a Single Select column, so Lark hands back the
    // raw option ID (e.g. "optp2Z4fis") instead of "Tier V" — resolve it.
    // Falls back to the raw value if the option list can't be fetched, so a
    // metadata hiccup never blocks the rest of the row from showing.
    let tierMap;
    try {
      tierMap = await getFieldOptionMap(TABLE_CUSTOMER_APPROACHING, F.tier);
    } catch (_) { /* non-fatal — tier just shows the raw id/text below */ }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        ready: !!nameCustomer,
        row: {
          pic: toDisplay(f[F.pic]),
          tier: toDisplay(f[F.tier], tierMap),
          nameCustomer,
          dob: toDisplay(f[F.dob]),
          riskPlayer: toDisplay(f[F.riskPlayer]),
          topPnl: toDisplay(f[F.topPnl]),
          gracePeriod: toDisplay(f[F.gracePeriod]),
          ltvTest: toDisplay(f[F.ltvTest]),
          vipBooster: toDisplay(f[F.vipBooster]),
        },
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
