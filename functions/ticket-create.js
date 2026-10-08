import { adapt } from "./_lib/adapt.js";
import { personalFailure, ticketAccess } from "./_lib/ticket-connection.js";
import { json, ticketError, ticketRequest, ticketSettings } from "./_lib/tickets.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  try {
    const settings = ticketSettings(event.env);
    if (!settings.configured) {
      return json(503, { ok: false, error: "Ticket integration is not configured" });
    }

    const access = await ticketAccess(event);
    if (access.failure) return access.failure;

    let body;
    const attachments = [];
    if (event.formData) {
      const ticketPart = event.formData.get("ticket");
      if (typeof ticketPart !== "string") {
        return json(400, { ok: false, error: "The multipart request needs a ticket JSON part" });
      }
      body = JSON.parse(ticketPart);
      for (const [field, value] of event.formData.entries()) {
        if (field === "ticket" || typeof value === "string") continue;
        attachments.push({ field, file: value });
      }
    } else {
      body = JSON.parse(event.body || "{}");
    }
    if (!body.fields || typeof body.fields !== "object" || Array.isArray(body.fields)) {
      return json(400, { ok: false, error: "Ticket fields are required" });
    }
    if (!String(body.fields.toDepartment || body.fields.Department || body.fields["Send to"] || "").trim()) {
      return json(400, { ok: false, error: "Choose a destination department" });
    }

    const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);
    const counts = new Map();
    let totalSize = 0;
    for (const { field, file } of attachments) {
      counts.set(field, (counts.get(field) || 0) + 1);
      totalSize += Number(file.size) || 0;
      if (counts.get(field) > 6) return json(400, { ok: false, error: `${field} allows at most 6 files` });
      if (!file.size) return json(400, { ok: false, error: `${file.name || "Attachment"} is empty` });
      if (file.size >= 1024 * 1024) return json(400, { ok: false, error: `${file.name || "Attachment"} must be under 1MB` });
      if (!allowedTypes.has(file.type)) return json(400, { ok: false, error: `${file.name || "Attachment"} must be PNG, JPG, WEBP, or PDF` });
    }
    if (totalSize > 10 * 1024 * 1024) return json(413, { ok: false, error: "The complete ticket request must be under 10MB" });

    let requestBody;
    if (attachments.length) {
      requestBody = new FormData();
      requestBody.append("ticket", JSON.stringify({ fields: body.fields }));
      for (const { field, file } of attachments) requestBody.append(field, file, file.name);
    } else {
      requestBody = JSON.stringify({ fields: body.fields });
    }

    let data;
    try {
      data = await ticketRequest(access.env, "/tickets", { method: "POST", body: requestBody });
    } catch (err) {
      const failure = personalFailure(access, err);
      if (failure) return failure;
      throw err;
    }
    return json(201, { ok: true, id: data.id, ref: data.ref, attachments: data.attachments || [], createdAs: access.personal ? "own" : "shared" });
  } catch (err) {
    if (err instanceof SyntaxError) return json(400, { ok: false, error: "Malformed JSON" });
    return ticketError(err);
  }
}

export const onRequest = adapt(handler);
