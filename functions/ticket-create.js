import { adapt } from "./_lib/adapt.js";
import { LIVECHAT_ACCOUNTS } from "./_lib/livechat.js";
import { identifyAgent } from "./_lib/livechat-identity.js";
import { deleteTicketImages, isStoredImage, storeTicketImages } from "./_lib/ticket-images.js";
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
      const limitMb = event.env?.TICKET_IMAGES && isStoredImage(file) ? 5 : 1;
      if (file.size >= limitMb * 1024 * 1024) return json(400, { ok: false, error: `${file.name || "Attachment"} must be under ${limitMb}MB` });
      if (!allowedTypes.has(file.type)) return json(400, { ok: false, error: `${file.name || "Attachment"} must be PNG, JPG, WEBP, or PDF` });
    }
    if (totalSize > 10 * 1024 * 1024) return json(413, { ok: false, error: "The complete ticket request must be under 10MB" });

    // Who raised it: the ticket system only knows the API key's owner, so the agent's LiveChat id and email go in fields of the
    // ticket. LiveChat is asked with the agent's own token; anything the browser put in those fields is overwritten.
    const fields = { ...body.fields };
    const authorIdField = String(event.env?.TICKETS_AUTHOR_ID_FIELD || "").trim();
    const authorEmailField = String(event.env?.TICKETS_AUTHOR_EMAIL_FIELD || "").trim();
    if (authorIdField || authorEmailField) {
      const account = LIVECHAT_ACCOUNTS.find((item) => item.key === body.author?.accountKey);
      if (!account || !String(body.author?.agentToken || "").trim()) {
        return json(401, { ok: false, loginExpired: true, error: "Connect LiveChat first: a ticket has to say which agent raised it." });
      }
      const who = await identifyAgent(event.env, account.key, body.author.agentToken, { withEmail: true, pat: account.pat });
      if (!who.ok) return json(401, { ok: false, loginExpired: true, error: who.error });
      const email = who.identities.find((id) => id.includes("@")) || "";
      if (authorEmailField && !email) return json(502, { ok: false, error: "LiveChat did not return this agent's email, so the ticket was not created." });
      if (authorIdField) fields[authorIdField] = who.login;
      if (authorEmailField) fields[authorEmailField] = email;
    }

    // Images go to the R2 bucket and the ticket gets their links (in the remarks unless TICKETS_IMAGE_LINKS_FIELD names another
    // field). Without the bucket binding they are attached as before. PDFs are always attached.
    let imageKeys = [];
    let sent = attachments;
    if (event.env?.TICKET_IMAGES && attachments.some(({ file }) => isStoredImage(file))) {
      const images = attachments.filter(({ file }) => isStoredImage(file));
      const host = String(event.headers?.host || "");
      const stored = await storeTicketImages(event.env, host, images.map(({ file }) => file));
      imageKeys = stored.keys;
      sent = attachments.filter(({ file }) => !isStoredImage(file));
      const linksField = String(event.env.TICKETS_IMAGE_LINKS_FIELD || "remarks").trim();
      const current = String(fields[linksField] ?? "").trim();
      fields[linksField] = `${current ? `${current}\n\n` : ""}Images:\n${stored.links.join("\n")}`;
    }

    try {
      let requestBody;
      if (sent.length) {
        requestBody = new FormData();
        requestBody.append("ticket", JSON.stringify({ fields }));
        for (const { field, file } of sent) requestBody.append(field, file, file.name);
      } else {
        requestBody = JSON.stringify({ fields });
      }

      const data = await ticketRequest(event.env, "/tickets", { method: "POST", body: requestBody });
      return json(201, { ok: true, id: data.id, ref: data.ref, attachments: data.attachments || [], images: imageKeys.length });
    } catch (err) {
      // No ticket points to these images.
      await deleteTicketImages(event.env, imageKeys);
      throw err;
    }
  } catch (err) {
    if (err instanceof SyntaxError) return json(400, { ok: false, error: "Malformed JSON" });
    return ticketError(err);
  }
}

export const onRequest = adapt(handler);
