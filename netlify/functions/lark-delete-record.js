const { deleteRecord, TABLE_CUSTOMER_APPROACHING } = require("./lib/lark");

// Used when CS ticks "Unknown" on a chat that already has a placeholder
// Customer Approaching row (lark-search.js creates one on every Look Up,
// even before Inquiry/Status/etc. are filled in) -- e.g. a guessed/wrong
// username was tried before realizing the customer never gave a real one.
// Removes that row so an Unknown-marked chat truly records nothing, since
// unknown players aren't counted toward chat data (see app.js's
// isUnknown handling). Only ever called for a record that hasn't been
// logged yet -- app.js guards that on its side.
exports.handler = async function (event) {
  try {
    const { recordId } = JSON.parse(event.body || "{}");
    if (!recordId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "recordId is required" }) };
    }
    await deleteRecord(TABLE_CUSTOMER_APPROACHING, recordId);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
