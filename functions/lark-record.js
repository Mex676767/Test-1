import { adapt } from "./_lib/adapt.js";
import { updateRecord, TABLE_CUSTOMER_APPROACHING } from "./_lib/lark.js";
import { readOwnershipMerged, ownedBy } from "./_lib/ca-row.js";
import { runWithRequestStart } from "./_lib/lark.js";

function extractAmount(str) {
  const s = String(str || "");
  const rmMatch = s.match(/RM\s*(-?\d+(?:\.\d+)?)/i);
  if (rmMatch) return Number(rmMatch[1]);
  const match = s.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function toEpochMs(dateStr) {
  if (!dateStr) return null;
  const ms = Date.parse(dateStr + "T00:00:00Z");
  return Number.isNaN(ms) ? null : ms;
}

export function handler(event) { return runWithRequestStart(() => recordHandler(event)); }

async function recordHandler(event) {
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
    var vs96FeedbackQuery1 = String(body.vs96FeedbackQuery1 || "").trim();
    var vs96FeedbackQuery2 = String(body.vs96FeedbackQuery2 || "").trim();

    if (!recordId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "recordId is required" }) };
    }
    if (!String(agentName).trim()) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "agentName is required" }) };
    }
    var ownership = await readOwnershipMerged(recordId, body.username, agentName);
    if (!ownedBy(ownership.owner, agentName)) {
      return { statusCode: 409, body: JSON.stringify({ ok: false, notOwner: true, owner: ownership.owner,
        error: "This case is logged under " + ownership.owner + " — not changed. Press Look up to log your own record." }) };
    }

    if (body.unclaim) {
      if (!recordId) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: "recordId is required" }) };
      }
      var cleared = await updateRecord(TABLE_CUSTOMER_APPROACHING, recordId, {
        "Inquiry": [],
        "Status": null,
        "Released amount": null,
        "Claim Secret": false
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, record: cleared }) };
    }

    if (body.linkOnly) {
      if (!recordId || !chatLink) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: "recordId and chatLink are required" }) };
      }
      var linked = await updateRecord(TABLE_CUSTOMER_APPROACHING, recordId, {
        "link": { link: chatLink, text: chatLink }
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, record: linked }) };
    }

    if (!recordId || !inquiry || !inquiry.length || !status) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Missing required fields" }) };
    }
    if (inquiry.includes("VS96 Feedback bonus") && String(status).trim().toLowerCase() === "given"
      && (!vs96FeedbackQuery1 || !vs96FeedbackQuery2)) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Both VS96 feedback answers are required before claiming" }) };
    }

    var fields = {
      "Agent Name": agentName,
      "Brand": brand,
      "Inquiry": inquiry,
      "Status": status,
      "Released amount": extractAmount(releasedAmountRaw !== undefined ? releasedAmountRaw : releasedAmount),
      "Claim Secret": !!claimSecret,
      "link": chatLink ? { link: chatLink, text: chatLink } : null,
      "Player D.O.B": toEpochMs(dob),
      "Telegram": !!telegram,
      "Query 1 Feedback (VS96 Feedback)": vs96FeedbackQuery1 || null,
      "Query 2 Feedback (VS96 Feedback)": vs96FeedbackQuery2 || null
    };

    var record = await updateRecord(TABLE_CUSTOMER_APPROACHING, recordId, fields);
    return { statusCode: 200, body: JSON.stringify({ ok: true, record: record }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
}

export const onRequest = adapt(handler);
