const { updateRecord, TABLE_REDEEM_CODE, TABLE_SPECIAL_RELOAD, TABLE_TELEGRAM28 } = require("./lib/lark");

// Called the instant CS clicks Claim on a red (special) ticket — writes
// straight to the matched record so it happens immediately, not deferred to
// the final "Record to Lark Base" submit. Regular (gold) tickets don't call
// this — they're read-only source-table rows, only logged at submit time.
exports.handler = async function (event) {
  try {
    const { source, recordId, chatLink } = JSON.parse(event.body || "{}");
    if (!source || !recordId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "source and recordId are required" }) };
    }

    // "Live Chat Link" is a URL-type field on both tables (confirmed by a
    // real URLFieldConvFail on Special Reload's own claim) -- Lark's API
    // wants the {link, text} object shape for those, not a plain string,
    // same as Customer Approaching's own "link" field in lark-record.js.
    const liveChatLinkField = chatLink ? { link: chatLink, text: chatLink } : null;

    if (source === "telegram28") {
      // Confirmed FieldNameNotFound on a real claim (2026-09-11) — unlike
      // Special Reload/Telegram28's own other columns, this table's link
      // field is just plain "Link", not "Live Chat Link" (matches the
      // original screenshot of its real columns: ...Redeem Code, Last
      // Modified Date, Modified By, Created By, Remark, Link).
      await updateRecord(TABLE_TELEGRAM28, recordId, {
        "Link": liveChatLinkField,
        "Status": "Claimed",
      });
    } else if (source === "redeemCode") {
      await updateRecord(TABLE_REDEEM_CODE, recordId, { "Status": "Claimed" });
    } else if (source === "specialReload") {
      // Same "Click Here" button precedent as Ang Pao — Special Reload
      // Event's own table has an identical manual claim button, replicated
      // here the same way.
      await updateRecord(TABLE_SPECIAL_RELOAD, recordId, {
        "Live Chat Link": liveChatLinkField,
        "Status": "Claimed",
      });
    } else {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Unknown source: " + source }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
