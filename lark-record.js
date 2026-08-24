const { updateRecord, TABLE_CUSTOMER_APPROACHING } = require("./lib/lark");

// Called on "Record to Lark Base". Look Up already created the row, so this
// UPDATES it with the fields CS filled in manually.
// PIC = the agent's selected name from settings (passed as picName).
// Hardcoded to "mexha" for testing — once the settings panel is live,
// picName will come from the frontend and replace this.
exports.handler = async function (event) {
  try {
    const body = JSON.parse(event.body || "{}");
    const { recordId, picName, inquiry, status, link, telegram, releasedAmount, claimSecret } = body;

    if (!recordId || !inquiry || !inquiry.length || !status) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Missing required fields" }) };
    }

    const fields = {
      "PIC": picName || "mexha", // temp hardcode for testing — settings panel will supply this
      "Inquiry": inquiry,
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
