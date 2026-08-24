const { updateRecord, TABLE_ANG_PAO, TABLE_REDEEM_CODE } = require("./lib/lark");

// Called the instant CS clicks Claim on a red (special) ticket — writes
// straight to the matched record so it happens immediately, not deferred to
// the final "Record to Lark Base" submit. Regular (gold) tickets don't call
// this — they're read-only lookup columns, only logged at submit time.
exports.handler = async function (event) {
  try {
    const { source, recordId, chatLink } = JSON.parse(event.body || "{}");
    if (!source || !recordId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "source and recordId are required" }) };
    }

    if (source === "angPao") {
      // Live Chat Link + Status="Claimed" — replicates what the "Click Here"
      // button used to do. This fires the backoffice-approval workflow since
      // its trigger was switched from "button clicked" to "Status -> Claimed".
      await updateRecord(TABLE_ANG_PAO, recordId, {
        "Live Chat Link": chatLink || "",
        "Status": "Claimed",
      });
    } else if (source === "redeemCode") {
      await updateRecord(TABLE_REDEEM_CODE, recordId, { "Status": "Claimed" });
    } else {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Unknown source: " + source }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
