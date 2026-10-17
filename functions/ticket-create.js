import { adapt } from "./_lib/adapt.js";
import { actingAs, flag, isOnBehalfRefusal, needTicketEmail, refusalResponse } from "./_lib/ticket-actor.js";
import { rememberTicketEmail } from "./_lib/ticket-email.js";
import { deleteTicketImages, fileMatchesType, isStoredImage, storeTicketImages, useImageBucket } from "./_lib/ticket-images.js";
import { json, ticketError, ticketRequest, ticketSettings } from "./_lib/tickets.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  try {
    const settings = ticketSettings(event.env);
    if (!settings.configured) {
      return json(503, { ok: false, error: "Ticket integration is not configured" });
    }

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
      // An image goes to R2 and may be larger; anything attached to the ticket stays within the ticket service's 1MB.
      const limitMb = useImageBucket(event.env) && isStoredImage(file) ? 5 : 1;
      if (file.size >= limitMb * 1024 * 1024) return json(400, { ok: false, error: `${file.name || "Attachment"} must be under ${limitMb}MB` });
      if (!allowedTypes.has(file.type)) return json(400, { ok: false, error: `${file.name || "Attachment"} must be PNG, JPG, WEBP, or PDF` });
      if (!(await fileMatchesType(file))) return json(400, { ok: false, error: `${file.name || "Attachment"} is not really a ${file.type === "application/pdf" ? "PDF" : "PNG, JPG or WEBP image"}, so it was not sent` });
    }
    if (totalSize > 10 * 1024 * 1024) return json(413, { ok: false, error: "The complete ticket request must be under 10MB" });

    // Who raised it. LiveChat is asked with the agent's own token, so the browser cannot choose the author; anything the browser put in
    // the author fields is overwritten. The ticket gets the agent's LiveChat id and email in the fields named by
    // TICKETS_AUTHOR_ID_FIELD / TICKETS_AUTHOR_EMAIL_FIELD, and (TICKETS_ON_BEHALF_OF) is raised as that person (see ticket-actor.js).
    const fields = { ...body.fields };
    const authorIdField = String(event.env?.TICKETS_AUTHOR_ID_FIELD || "").trim();
    const authorEmailField = String(event.env?.TICKETS_AUTHOR_EMAIL_FIELD || "").trim();
    const onBehalf = flag(event.env?.TICKETS_ON_BEHALF_OF);
    let acting = null;
    if (authorIdField || authorEmailField || onBehalf) {
      acting = await actingAs(event.env, body.author, { resolveEmail: onBehalf });
      if (acting.response) return acting.response;
      if (authorEmailField && !acting.agentEmail) return json(502, { ok: false, error: "LiveChat did not return this agent's email, so the ticket was not created." });
      if (authorIdField) fields[authorIdField] = acting.who.login;
      if (authorEmailField) fields[authorEmailField] = acting.agentEmail;
    }
    const onBehalfEmail = onBehalf ? acting.email : "";
    if (onBehalf && !onBehalfEmail) return needTicketEmail("");

    // Images go to the R2 bucket and the ticket gets their links (in the remarks unless TICKETS_IMAGE_LINKS_FIELD names another
    // field). Without the bucket binding they are attached as before. PDFs are always attached.
    let imageKeys = [];
    let sent = attachments;
    if (useImageBucket(event.env) && attachments.some(({ file }) => isStoredImage(file))) {
      const images = attachments.filter(({ file }) => isStoredImage(file));
      const host = String(event.headers?.host || "");
      const stored = await storeTicketImages(event.env, host, images.map(({ file }) => file));
      imageKeys = stored.keys;
      sent = attachments.filter(({ file }) => !isStoredImage(file));
      const linksField = String(event.env.TICKETS_IMAGE_LINKS_FIELD || "remarks").trim();
      const current = String(fields[linksField] ?? "").trim();
      fields[linksField] = `${current ? `${current}\n\n` : ""}Images:\n${stored.links.join("\n")}`;
    }

    const ticket = { fields, ...(onBehalfEmail ? { onBehalfOf: onBehalfEmail } : {}) };
    let requestBody;
    if (sent.length) {
      requestBody = new FormData();
      requestBody.append("ticket", JSON.stringify(ticket));
      for (const { field, file } of sent) requestBody.append(field, file, file.name);
    } else {
      requestBody = JSON.stringify(ticket);
    }

    try {
      const data = await ticketRequest(event.env, "/tickets", { method: "POST", body: requestBody });
      // An email the agent typed is saved on their row (once, and only if neither of their rows has a Ticket Email yet).
      if (onBehalfEmail && acting.source === "entered") {
        const save = rememberTicketEmail(acting.agentLogin.accountKey, acting.agentLogin.login, onBehalfEmail);
        if (event.waitUntil) event.waitUntil(save); else await save;
      }
      return json(201, { ok: true, id: data.id, ref: data.ref, attachments: data.attachments || [], images: imageKeys.length, ...(onBehalfEmail ? { actedAs: onBehalfEmail } : {}) });
    } catch (err) {
      // Nothing was created, so no ticket points to these images.
      await deleteTicketImages(event.env, imageKeys);
      if (onBehalfEmail && isOnBehalfRefusal(err)) return refusalResponse(err, onBehalfEmail, acting.source);
      throw err;
    }
  } catch (err) {
    if (err instanceof SyntaxError) return json(400, { ok: false, error: "Malformed JSON" });
    return ticketError(err);
  }
}

export const onRequest = adapt(handler);
