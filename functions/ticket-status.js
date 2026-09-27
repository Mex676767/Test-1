import { adapt } from "./_lib/adapt.js";
import { json, ticketError, ticketRequest } from "./_lib/tickets.js";

export async function handler(event) {
  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed" });
  const ref = String(event.queryStringParameters?.ref || "").trim().toUpperCase();
  if (!/^TK\d{10}$/.test(ref)) {
    return json(400, { ok: false, error: "Enter a ticket reference such as TK2609210007" });
  }

  try {
    const data = await ticketRequest(event.env, `/tickets/${encodeURIComponent(ref)}`);
    return json(200, {
      ok: true,
      ticket: {
        ref: data.ref,
        fields: data.fields || {},
        currentDepartment: data.currentDepartment || null,
        updatedAt: data.updatedAt || null,
      },
    });
  } catch (err) {
    return ticketError(err);
  }
}

export const onRequest = adapt(handler);
