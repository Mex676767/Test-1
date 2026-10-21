import { adapt } from "./_lib/adapt.js";
import { updateRecord, TABLE_REDEEM_CODE, TABLE_SPECIAL_RELOAD, TABLE_TELEGRAM28 } from "./_lib/lark.js";

export async function handler(event) {
  try {
    const { source, recordId, chatLink } = JSON.parse(event.body || "{}");
    if (!source || !recordId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "source and recordId are required" }) };
    }

    const liveChatLinkField = chatLink ? { link: chatLink, text: chatLink } : null;

    if (source === "telegram28") {
      await updateRecord(TABLE_TELEGRAM28, recordId, { "Status": "Claimed" });
    } else if (source === "redeemCode") {
      await updateRecord(TABLE_REDEEM_CODE, recordId, { "Status": "Claimed" });
    } else if (source === "specialReload") {
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
}

export const onRequest = adapt(handler);
