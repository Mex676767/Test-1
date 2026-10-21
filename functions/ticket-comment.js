import { adapt } from "./_lib/adapt.js";
import { actingAs, flag, isOnBehalfRefusal, needTicketEmail, refusalResponse } from "./_lib/ticket-actor.js";
import { rememberTicketEmail } from "./_lib/ticket-email.js";
import { deleteTicketImages, fileMatchesType, isStoredImage, storeTicketImages, useImageBucket } from "./_lib/ticket-images.js";
import { json, ticketError, ticketRequest, ticketSettings } from "./_lib/tickets.js";

const MAX_COMMENT = 5000;
const MAX_FILES = 4;
const TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  try {
    if (!ticketSettings(event.env).configured) return json(503, { ok: false, error: "Ticket integration is not configured" });
    let input;
    const files = [];
    if (event.formData) {
      const part = event.formData.get("comment");
      if (typeof part !== "string") return json(400, { ok: false, error: "The multipart request needs a comment JSON part" });
      input = JSON.parse(part);
      for (const [name, value] of event.formData.entries()) if (name !== "comment" && typeof value !== "string") files.push(value);
    } else {
      input = JSON.parse(event.body || "{}");
    }
    const ref = String(input.ref || "").trim().toUpperCase();
    let text = String(input.body ?? "").trim();
    if (!/^TK\d{10}$/.test(ref)) return json(400, { ok: false, error: "Enter a ticket reference such as TK2609210007" });
    if (!text && !files.length) return json(400, { ok: false, error: "Write a comment first." });
    if (files.length > MAX_FILES) return json(400, { ok: false, error: `A comment can carry at most ${MAX_FILES} files.` });
    let totalSize = 0;
    for (const file of files) {
      totalSize += Number(file.size) || 0;
      if (!file.size) return json(400, { ok: false, error: `${file.name || "Attachment"} is empty` });
      const limitMb = useImageBucket(event.env) && isStoredImage(file) ? 5 : 1;
      if (file.size >= limitMb * 1024 * 1024) return json(400, { ok: false, error: `${file.name || "Attachment"} must be under ${limitMb}MB` });
      if (!TYPES.has(file.type)) return json(400, { ok: false, error: `${file.name || "Attachment"} must be PNG, JPG, WEBP, or PDF` });
      if (!(await fileMatchesType(file))) return json(400, { ok: false, error: `${file.name || "Attachment"} is not really a ${file.type === "application/pdf" ? "PDF" : "PNG, JPG or WEBP image"}, so it was not sent` });
    }
    if (totalSize > 10 * 1024 * 1024) return json(413, { ok: false, error: "The comment's files must be under 10MB together" });
    if (text.length > MAX_COMMENT) return json(400, { ok: false, error: `A comment can be at most ${MAX_COMMENT} characters.` });
    const parentId = input.parentId === undefined || input.parentId === null || input.parentId === "" ? null : Number(input.parentId);
    if (parentId !== null && !(Number.isInteger(parentId) && parentId > 0)) return json(400, { ok: false, error: "That reply is not to a valid comment." });

    const onBehalf = flag(event.env?.TICKETS_ON_BEHALF_OF);
    let acting = null;
    if (onBehalf) {
      acting = await actingAs(event.env, input.author);
      if (acting.response) return acting.response;
      if (!acting.email) return needTicketEmail("");
    }
    const email = onBehalf ? acting.email : "";

    let imageKeys = [];
    let sent = files;
    if (useImageBucket(event.env) && files.some(isStoredImage)) {
      const images = files.filter(isStoredImage);
      const stored = await storeTicketImages(event.env, String(event.headers?.host || ""), images);
      imageKeys = stored.keys;
      sent = files.filter((file) => !isStoredImage(file));
      text = `${text}${text ? "\n\n" : ""}Images:\n${stored.links.join("\n")}`;
    }
    const comment = { body: text, ...(parentId ? { parentId } : {}), ...(email ? { onBehalfOf: email } : {}) };
    let requestBody;
    if (sent.length) {
      requestBody = new FormData();
      requestBody.append("comment", JSON.stringify(comment));
      for (const file of sent) requestBody.append("file", file, file.name);
    } else {
      requestBody = JSON.stringify(comment);
    }
    try {
      const data = await ticketRequest(event.env, `/tickets/${encodeURIComponent(ref)}/comments`, { method: "POST", body: requestBody });
      if (email && acting.source === "entered") {
        const save = rememberTicketEmail(acting.agentLogin.accountKey, acting.agentLogin.login, email);
        if (event.waitUntil) event.waitUntil(save); else await save;
      }
      return json(201, { ok: true, parentId: data.parentId ?? null, comment: data.comment || null, images: imageKeys.length, ...(email ? { actedAs: email } : {}) });
    } catch (err) {
      await deleteTicketImages(event.env, imageKeys);
      if (email && isOnBehalfRefusal(err)) return refusalResponse(err, email, acting.source);
      throw err;
    }
  } catch (err) {
    if (err instanceof SyntaxError) return json(400, { ok: false, error: "Malformed JSON" });
    return ticketError(err);
  }
}

export const onRequest = adapt(handler);
