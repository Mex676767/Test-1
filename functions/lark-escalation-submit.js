import { adapt } from "./_lib/adapt.js";
import { createRecord, ESCALATION_BASE_TOKEN, TABLE_ESCALATION } from "./_lib/lark.js";

export async function handler(event) {
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
}

export const onRequest = adapt(handler);
