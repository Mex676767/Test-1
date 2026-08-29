const { updateRecord, TABLE_CUSTOMER_APPROACHING } = require("./lib/lark");

// "Released amount" is a Number field in Lark. The frontend's display
// string (e.g. "LTV - Test: Pass RM18") isn't usable directly — sending it
// causes NumberFieldConvFail, and worse, label text like "Top 10 P&L - Test"
// carries digits of its own that a naive number-extraction would grab
// instead of the real amount. So the frontend also sends releasedAmountRaw
// (just the source's display value, e.g. "Pass RM18", no label prefix) —
// pull the number from that. No number found (no bonus claimed, or a
// non-numeric status like "Claimed") -> write null so the field stays blank.
function extractAmount(str) {
  const match = String(str || "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

// Lark Date fields expect a millisecond epoch number over the API, not a
// "YYYY-MM-DD" string (same category of mismatch as the earlier
// NumberFieldConvFail/UserFieldConvFail issues on this table) — the card's
// <input type="date"> gives "YYYY-MM-DD", so convert it here.
function toEpochMs(dateStr) {
  if (!dateStr) return null;
  const ms = Date.parse(dateStr + "T00:00:00Z");
  return Number.isNaN(ms) ? null : ms;
}

exports.handler = async function (event) {
  try {
    var body = JSON.parse(event.body || "{}");
    var recordId = body.recordId;
    var agentName = body.agentName || body.picName || "";
    var brand = body.brand || "";
    var inquiry = body.inquiry;
    var status = body.status;
    var releasedAmount = body.releasedAmount;
    var releasedAmountRaw = body.releasedAmountRaw;
    var claimSecret = body.claimSecret;
    var chatLink = body.chatLink;
    var dob = body.dob;
    var telegram = body.telegram;

    if (!recordId || !inquiry || !inquiry.length || !status) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Missing required fields" }) };
    }

    var fields = {
      "Agent Name": agentName,
      "Brand": brand,
      "Inquiry": inquiry,
      "Status": status,
      "Released amount": extractAmount(releasedAmountRaw !== undefined ? releasedAmountRaw : releasedAmount),
      "Claim Secret": !!claimSecret,
      // Field is named exactly "link" (lowercase) on Customer Approaching,
      // and is Lark's Link field type — NOT plain text, so it needs the
      // {link, text} object shape or Lark rejects it, same as the earlier
      // Number/Select field-type mismatches on this table. chatLink comes
      // from activeChats[].link, which app.js only fills in once
      // livechat-chat-status.js resolves the real chat_id via list_chats
      // (~2s after a chat opens) — null if recorded before that resolves.
      "link": chatLink ? { link: chatLink, text: chatLink } : null,
      // Plain field on Customer Approaching itself, filled in by CS directly
      // (not a Lookup from anywhere) — dob is a "YYYY-MM-DD" string from the
      // card's date input, or "" if left blank.
      "Player D.O.B": toEpochMs(dob),
      // Was previously a UI-only toggle with no write path at all — the
      // card's Telegram switch (auto-detected, but CS-editable) now actually
      // reaches this Checkbox field on submit.
      "Telegram": !!telegram
    };

    var record = await updateRecord(TABLE_CUSTOMER_APPROACHING, recordId, fields);
    return { statusCode: 200, body: JSON.stringify({ ok: true, record: record }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
