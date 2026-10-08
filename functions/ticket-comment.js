import { adapt } from "./_lib/adapt.js";
import { cleanComment, json, ticketError, ticketRequest, ticketSettings } from "./_lib/tickets.js";

// POST /ticket-comment?ref=TK... with JSON { body, agent?, parentId?, mentions? }, or multipart/form-data with the same object in a
// "comment" part plus up to 4 files. The API key stays on the server; the ticket service decides who may comment.
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);
const MAX_FILES = 4;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_AGENT_NAME = 60;

// Every widget comment is posted by one shared service account, so the agent's own name goes at the start of the text.
// Brackets and line breaks are removed so a name cannot break out of the label.
function agentLabel(value) {
  const name = String(value || "").replace(/[\r\n\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_AGENT_NAME);
  return name ? `[${name} via widget]` : "";
}

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  const ref = String(event.queryStringParameters?.ref || "").trim().toUpperCase();
  if (!/^TK\d{10}$/.test(ref)) {
    return json(400, { ok: false, error: "Enter a ticket reference such as TK2609210007" });
  }
  try {
    if (!ticketSettings(event.env).configured) {
      return json(503, { ok: false, error: "Ticket integration is not configured" });
    }

    let input;
    const files = [];
    if (event.formData) {
      const commentPart = event.formData.get("comment");
      if (typeof commentPart !== "string") {
        return json(400, { ok: false, error: "The multipart request needs a comment JSON part" });
      }
      input = JSON.parse(commentPart);
      for (const [field, value] of event.formData.entries()) {
        if (field === "comment" || typeof value === "string") continue;
        files.push(value);
      }
    } else {
      input = JSON.parse(event.body || "{}");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return json(400, { ok: false, error: "A comment is required" });
    }

    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!body && !files.length) return json(400, { ok: false, error: "Write a comment or attach a file" });

    const label = agentLabel(input.agent);
    const payload = { body: label ? `${label} ${body}`.trim() : body };
    if (input.parentId !== undefined && input.parentId !== null && input.parentId !== "") {
      const parentId = Number(input.parentId);
      if (!Number.isInteger(parentId) || parentId <= 0) return json(400, { ok: false, error: "That reply target is not valid" });
      payload.parentId = parentId;
    }
    if (input.mentions !== undefined) {
      if (!Array.isArray(input.mentions) || input.mentions.length > 20) {
        return json(400, { ok: false, error: "Mentions must be a list of up to 20 people" });
      }
      payload.mentions = input.mentions;
    }

    if (files.length > MAX_FILES) return json(400, { ok: false, error: `A comment allows at most ${MAX_FILES} files` });
    let totalSize = 0;
    for (const file of files) {
      totalSize += Number(file.size) || 0;
      if (!file.size) return json(400, { ok: false, error: `${file.name || "Attachment"} is empty` });
      if (file.size >= MAX_FILE_BYTES) return json(400, { ok: false, error: `${file.name || "Attachment"} must be under 1MB` });
      if (!ALLOWED_TYPES.has(file.type)) return json(400, { ok: false, error: `${file.name || "Attachment"} must be PNG, JPG, WEBP, or PDF` });
    }
    if (totalSize > MAX_REQUEST_BYTES) return json(413, { ok: false, error: "The complete comment request must be under 10MB" });

    let requestBody;
    if (files.length) {
      requestBody = new FormData();
      requestBody.append("comment", JSON.stringify(payload));
      for (const file of files) requestBody.append("file", file, file.name);
    } else {
      requestBody = JSON.stringify(payload);
    }

    const data = await ticketRequest(event.env, `/tickets/${encodeURIComponent(ref)}/comments`, { method: "POST", body: requestBody });
    return json(201, {
      ok: true,
      parentId: data.parentId ?? null,
      comment: data.comment ? cleanComment(data.comment) : null,
    });
  } catch (err) {
    if (err instanceof SyntaxError) return json(400, { ok: false, error: "Malformed JSON" });
    return ticketError(err);
  }
}

export const onRequest = adapt(handler);
