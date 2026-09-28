import { adapt } from "./_lib/adapt.js";
import { json, ticketError, ticketRequest, ticketSettings } from "./_lib/tickets.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  try {
    const settings = ticketSettings(event.env);
    if (!settings.configured) {
      return json(503, { ok: false, error: "Ticket integration is not configured" });
    }

    const body = JSON.parse(event.body || "{}");
    if (!body.fields || typeof body.fields !== "object" || Array.isArray(body.fields)) {
      return json(400, { ok: false, error: "Ticket fields are required" });
    }
    const toDepartmentId = Number(body.toDepartmentId || settings.departmentId);
    const marketId = Number(body.marketId || settings.marketId);
    if (!Number.isInteger(toDepartmentId) || toDepartmentId <= 0) {
      return json(400, { ok: false, error: "Choose a destination department" });
    }

    const payload = {
      toDepartmentId,
      fields: body.fields,
    };
    if (Number.isInteger(marketId) && marketId > 0) payload.marketId = marketId;

    const data = await ticketRequest(event.env, "/tickets", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return json(201, { ok: true, id: data.id, ref: data.ref });
  } catch (err) {
    if (err instanceof SyntaxError) return json(400, { ok: false, error: "Malformed JSON" });
    return ticketError(err);
  }
}

export const onRequest = adapt(handler);
