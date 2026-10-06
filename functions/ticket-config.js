import { adapt } from "./_lib/adapt.js";
import { json, ticketError, ticketRequest, ticketSettings } from "./_lib/tickets.js";

// The catalog is the same for every agent and changes rarely, but every open widget refetched it (a 100-ticket
// list) on its options timer. Cache the successful result per isolate for 5 minutes; the manual Refresh button
// sends ?fresh=1 and always bypasses it.
const CONFIG_TTL_MS = 5 * 60_000;
let cachedConfig = null; // { key, at, body }
export function resetTicketConfigCache() { cachedConfig = null; }

export async function handler(event) {
  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed" });
  try {
    const settings = ticketSettings(event.env);
    const cacheKey = String(event.env?.TICKETS_API_KEY || "") + "|" + String(event.env?.TICKETS_API_BASE_URL || "");
    const fresh = event.queryStringParameters?.fresh === "1";
    if (!fresh && cachedConfig && cachedConfig.key === cacheKey && Date.now() - cachedConfig.at < CONFIG_TTL_MS) {
      return json(200, cachedConfig.body);
    }
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
    const fields = (data.fields || [])
      .filter((field) => field.isActive !== false)
      .map((field) => {
        if (field.type !== "SELECT" && field.type !== "MULTISELECT") return field;
        const observed = tickets.flatMap((ticket) => {
          const value = ticket.fields?.[field.key];
          return Array.isArray(value) ? value : [value];
        }).filter((value) => value !== undefined && value !== null && String(value).trim());
        const options = Array.from(new Set(observed.map(String)))
          .sort((a, b) => a.localeCompare(b))
          .map((value) => ({ value, label: value, isActive: true }));
        return { ...field, options };
      });
    const body = {
      ok: true,
      configured: true,
      fields,
      departments,
      markets,
      defaultDepartmentId: settings.departmentId,
      defaultMarketId: settings.marketId,
    };
    cachedConfig = { key: cacheKey, at: Date.now(), body };
    return json(200, body);
  } catch (err) {
    return ticketError(err);
  }
}

export const onRequest = adapt(handler);
