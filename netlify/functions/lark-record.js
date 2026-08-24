const { updateRecord, TABLE_CUSTOMER_APPROACHING } = require("./lib/lark");

// Called on "Record to Lark Base". By this point Look Up has already created
// the row (that's what makes the bonus lookup columns populate) — so this
// UPDATES that same record with the fields CS filled in manually, rather
// than inserting a second row.
exports.handler = async function (event) {
  try {
    const body = JSON.parse(event.body || "{}");
    const { recordId, agentName, inquiry, status, link, telegram, releasedAmount, claimSecret } = body;

    if (!recordId || !inquiry || !inquiry.length || !status) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Missing required fields" }) };
    }

    const fields = {
      "PIC": agentName || "",
      "Inquiry": inquiry, // multi-select field expects an array
      "Status": status,
      "Link": link || "",
      "Telegram": !!telegram,
      "Released amount": releasedAmount || "",
      "Claim Secret": !!claimSecret,
    };

    const record = await updateRecord(TABLE_CUSTOMER_APPROACHING, recordId, fields);
    return { statusCode: 200, body: JSON.stringify({ ok: true, record }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
