const { createRecord, ESCALATION_BASE_TOKEN, TABLE_ESCALATION } = require("./lib/lark");

// Writes straight to the C9MYR CS-PYM ESCALATION table -- CS never touches
// the actual Lark Form (per the request: "we will not be filling this
// ticket, instead we will be filling in the actual table"). Field names
// confirmed from the real table's own columns (not the form's labels,
// which don't all match 1:1 -- e.g. the form says "AMOUNT" but the column
// is "Bonus Amount", "TRANSACTION ID" vs "TRX ID", "REMARKS (CS - PYM)" vs
// "REMARK (CS - PYM)"). Ticket No. is a formula/auto field on that table
// and is never written here. Attachment is intentionally not included yet
// -- file upload needs a separate Lark attachment-upload step this doesn't
// do. "PIC" (Created By) is a Lark system field that always reflects the
// API caller's identity (the app's own bot, not the individual agent) --
// "PIC Name" is the separate Single Option field the agent actually
// controls, always set to the same name chosen in Settings.
exports.handler = async function (event) {
  try {
    if (!ESCALATION_BASE_TOKEN || !TABLE_ESCALATION) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: "Escalation ticket table isn't configured on this site yet." }) };
    }
    const body = JSON.parse(event.body || "{}");
    const memberUserId = (body.memberUserId || "").trim();
    const brand = (body.brand || "").trim();
    const queries = (body.queries || "").trim();
    const transactionId = (body.transactionId || "").trim();
    const paymentGateway = (body.paymentGateway || "").trim();
    const remarks = (body.remarks || "").trim();
    const vipLevel = (body.vipLevel || "").trim();
    const amount = body.amount;
    const picName = (body.picName || "").trim();

    if (!memberUserId || !brand || !queries) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Member/User ID, Brand, and Queries are required" }) };
    }

    const amountNum = amount !== undefined && amount !== null && amount !== ""
      ? Number(amount)
      : null;

    const fields = {
      "MEMBER USERID": memberUserId,
      "Brand": brand,
      "QUERIES": queries,
      "TRX ID": transactionId,
      "PG": paymentGateway,
      "REMARK (CS - PYM)": remarks,
      "VIP LEVEL": vipLevel,
      "Bonus Amount": Number.isFinite(amountNum) ? amountNum : null,
      "PIC Name": picName,
    };

    const record = await createRecord(TABLE_ESCALATION, fields, ESCALATION_BASE_TOKEN);
    return { statusCode: 200, body: JSON.stringify({ ok: true, record }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
