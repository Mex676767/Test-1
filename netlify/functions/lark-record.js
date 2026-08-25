const { updateRecord, TABLE_CUSTOMER_APPROACHING } = require("./lib/lark");
exports.handler = async function (event) {
  try {
    var body = JSON.parse(event.body || "{}");
    var recordId = body.recordId;
    var agentName = body.agentName || body.picName || "";
    var inquiry = body.inquiry;
    var status = body.status;
    var link = body.link;
    var telegram = body.telegram;
    var releasedAmount = body.releasedAmount;
    var claimSecret = body.claimSecret;
    if (!recordId || !inquiry || !inquiry.length || !status) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Missing required fields" }) };
    }
    var fields = {
      "Agent Name": agentName,
      "Inquiry": inquiry,
      "Status": status,
      "Released amount": releasedAmount || "",
      "Claim Secret": !!claimSecret
    };
    var record = await updateRecord(TABLE_CUSTOMER_APPROACHING, recordId, fields);
    return { statusCode: 200, body: JSON.stringify({ ok: true, record: record }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
