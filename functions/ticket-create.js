import { adapt } from "./_lib/adapt.js";
import { LIVECHAT_ACCOUNTS } from "./_lib/livechat.js";
import { identifyAgent } from "./_lib/livechat-identity.js";
import { looksLikeEmail, rememberTicketEmail, ticketEmailFor } from "./_lib/ticket-email.js";
import { deleteTicketImages, isStoredImage, storeTicketImages } from "./_lib/ticket-images.js";
import { json, ticketError, ticketRequest, ticketSettings } from "./_lib/tickets.js";

// Raising a ticket "on behalf of" the agent: the ticket API takes the person's email (onBehalfOf) and then raises the ticket as them, from
// their department. It needs the API key's role to hold api-keys:act-on-behalf and an active ticket-system account with that email, so
// it is switched on with TICKETS_ON_BEHALF_OF=1. When the ticket system refuses it for either reason the ticket is raised under the key's
// owner instead (with the LiveChat id and email in the author fields if those are set) and the answer says why, so an agent without a
// ticket-system account can still raise tickets.
const flag = (value) => ["1", "true", "on", "yes"].includes(String(value ?? "").trim().toLowerCase());
const isOnBehalfRefusal = (error) => [400, 403].includes(Number(error?.statusCode))
  && /on behalf|onBehalfOf|No active account has the email|outranks/i.test(String(error?.message || ""));

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

    // Who raised it. LiveChat is asked with the agent's own token, so the browser cannot choose the author; anything the browser put in
    // the author fields is overwritten. The ticket gets the agent's LiveChat id and email in the fields named by
    // TICKETS_AUTHOR_ID_FIELD / TICKETS_AUTHOR_EMAIL_FIELD, and (TICKETS_ON_BEHALF_OF) is raised as that person.
    const fields = { ...body.fields };
    const authorIdField = String(event.env?.TICKETS_AUTHOR_ID_FIELD || "").trim();
    const authorEmailField = String(event.env?.TICKETS_AUTHOR_EMAIL_FIELD || "").trim();
    const onBehalf = flag(event.env?.TICKETS_ON_BEHALF_OF);
    let agentEmail = "";
    let onBehalfEmail = ""; // the ticket-system account's email (see emailSource)
    let emailSource = ""; // "ticket-email" / "same-agent" (set in Lark), "entered" (typed by the agent just now) or "livechat"
    let agentLogin = null; // { accountKey, login }
    if (authorIdField || authorEmailField || onBehalf) {
      const account = LIVECHAT_ACCOUNTS.find((item) => item.key === body.author?.accountKey);
      if (!account || !String(body.author?.agentToken || "").trim()) {
        return json(401, { ok: false, loginExpired: true, error: "Connect LiveChat first: a ticket has to say which agent raised it." });
      }
      const who = await identifyAgent(event.env, account.key, body.author.agentToken, { withEmail: true, pat: account.pat });
      if (!who.ok) return json(401, { ok: false, loginExpired: true, error: who.error });
      agentEmail = who.identities.find((id) => id.includes("@")) || "";
      if (authorEmailField && !agentEmail) return json(502, { ok: false, error: "LiveChat did not return this agent's email, so the ticket was not created." });
      if (authorIdField) fields[authorIdField] = who.login;
      if (authorEmailField) fields[authorEmailField] = agentEmail;
      if (onBehalf) {
        const picked = await ticketEmailFor(account.key, who.login, agentEmail);
        const entered = String(body.author?.ticketEmail || "").trim().toLowerCase();
        // An email an admin set in Lark always wins; one the agent typed is used (and saved once) only when none is set.
        if (picked.via !== "livechat") ({ email: onBehalfEmail, via: emailSource } = picked);
        else if (looksLikeEmail(entered)) { onBehalfEmail = entered; emailSource = "entered"; }
        else { onBehalfEmail = picked.email; emailSource = "livechat"; }
        agentLogin = { accountKey: account.key, login: who.login };
      }
    }
    // The agent is asked for their ticket account email instead of the ticket being raised under someone else's name.
    const needTicketEmail = (triedEmail) => ({ ok: false, needTicketEmail: true, ...(triedEmail ? { triedEmail } : {}), error: "Ticket account not found. Please enter your ticket account email." });
    if (onBehalf && !onBehalfEmail) return json(400, needTicketEmail(""));

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

    // A fresh request body per attempt: a multipart body is consumed when it is sent.
    const buildBody = (onBehalfOf) => {
      const ticket = { fields, ...(onBehalfOf ? { onBehalfOf } : {}) };
      if (!sent.length) return JSON.stringify(ticket);
      const form = new FormData();
      form.append("ticket", JSON.stringify(ticket));
      for (const { field, file } of sent) form.append(field, file, file.name);
      return form;
    };

    try {
      let data;
      let actedAs = "";
      let warning = "";
      if (onBehalf && onBehalfEmail) {
        try {
          data = await ticketRequest(event.env, "/tickets", { method: "POST", body: buildBody(onBehalfEmail) });
          actedAs = onBehalfEmail;
        } catch (err) {
          if (!isOnBehalfRefusal(err)) throw err;
          if (Number(err.statusCode) !== 403) {
            // No active ticket account with that email: nothing was created. Ask for the right one (or send them to the admin if the
            // email came from the Ticket Email column, which an agent cannot change).
            await deleteTicketImages(event.env, imageKeys);
            return json(400, emailSource === "ticket-email" || emailSource === "same-agent"
              ? { ok: false, triedEmail: onBehalfEmail, error: `The Ticket Email saved for you (${onBehalfEmail}) has no active ticket account. Ask your admin to correct it.` }
              : needTicketEmail(onBehalfEmail));
          }
          // The key may not act for others (or this person is senior to it): not the agent's doing, so the ticket is raised under the
          // integration account and the agent is told.
          warning = /outranks/i.test(String(err.message))
            ? "Your ticket account is senior to the integration key, so this ticket was raised under the integration account."
            : "The ticket system's key may not raise tickets for other people yet, so this ticket was raised under the integration account.";
          data = await ticketRequest(event.env, "/tickets", { method: "POST", body: buildBody("") });
        }
        if (actedAs && emailSource === "entered" && agentLogin) {
          const save = rememberTicketEmail(agentLogin.accountKey, agentLogin.login, actedAs);
          if (event.waitUntil) event.waitUntil(save); else await save;
        }
      } else {
        data = await ticketRequest(event.env, "/tickets", { method: "POST", body: buildBody("") });
      }
      return json(201, { ok: true, id: data.id, ref: data.ref, attachments: data.attachments || [], images: imageKeys.length, ...(actedAs ? { actedAs } : {}), ...(warning ? { warning } : {}) });
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
