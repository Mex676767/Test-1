import { adapt } from "./_lib/adapt.js";
import { json, ticketError, ticketRequest, ticketSettings } from "./_lib/tickets.js";

export async function handler(event) {
  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed" });
  try {
    const settings = ticketSettings(event.env);
    if (!settings.configured) {
      return json(200, {
        ok: false,
        configured: false,
        error: "Set TICKETS_API_KEY on this site",
      });
    }

    // The list response is the API's only field-catalog endpoint. Strip all
    // ticket records here so no unrelated customer data reaches the browser.
    const data = await ticketRequest(event.env, "/tickets?pageSize=100");
    const tickets = Array.isArray(data.tickets) ? data.tickets : [];
    const uniqueById = (items) => Array.from(new Map(items
      .filter((item) => item && Number.isInteger(Number(item.id)))
      .map((item) => [Number(item.id), item])).values());
    const departments = uniqueById(tickets.flatMap((ticket) => [ticket.currentDepartment, ticket.raisedByDepartment]))
      .map(({ id, code, name }) => ({ id: Number(id), code, name }));
    const markets = uniqueById(tickets.map((ticket) => ticket.market))
      .filter((market) => market.isActive !== false)
      .map(({ id, code, label, currency }) => ({ id: Number(id), code, label, currency }));
    return json(200, {
      ok: true,
      configured: true,
      fields: (data.fields || []).filter((field) => field.isActive !== false),
      departments,
      markets,
      defaultDepartmentId: settings.departmentId,
      defaultMarketId: settings.marketId,
    });
  } catch (err) {
    return ticketError(err);
  }
}

export const onRequest = adapt(handler);
