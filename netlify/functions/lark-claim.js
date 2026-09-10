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
      // No link field write here at all (2026-09-11) — both "Live Chat
      // Link" and "Link" came back FieldNameNotFound on real claims, and a
      // real screenshot of this table's columns (Time of Inspection,
      // Username/UID, Brand, Tier, Status, Claimed, Bonus Amount, Redeem
      // Code, ...) shows nothing link-shaped in range either. Same as
      // Redeem Code's own claim below — Status only.
      await updateRecord(TABLE_TELEGRAM28, recordId, { "Status": "Claimed" });
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
