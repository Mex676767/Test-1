import { adapt } from "./_lib/adapt.js";
import { CATALOG_SNAPSHOT_DATE, TICKET_CATALOG } from "./_lib/ticket-catalog.js";
import { actingAs, flag, needTicketEmail } from "./_lib/ticket-actor.js";
import { json, ticketError, ticketRequest, ticketSettings, withOnBehalf } from "./_lib/tickets.js";

// The catalog is the same for every agent and changes rarely, but every open widget refetched it (a 100-ticket
// list) on its options timer. Cache the successful result per isolate for 5 minutes; the manual Refresh button
// sends ?fresh=1 and always bypasses it.
const CONFIG_TTL_MS = 5 * 60_000;
let cachedConfig = null; // { key, at, body }
export function resetTicketConfigCache() { cachedConfig = null; }

const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const normalizeOption = (option) => (typeof option === "string"
  ? { value: option, label: option, isActive: true }
  : { value: option?.value, label: option?.label ?? option?.value, isActive: option?.isActive !== false });

// The choices of one SELECT / MULTISELECT field: whatever the API itself lists (it does not yet), then the ticket system's own list
// (ticket-catalog.js, with its display labels), then any value real tickets carry that neither knows (a choice added after the
// snapshot), so a stale snapshot never hides something agents can use.
function fieldOptions(field, observedValues) {
  const options = [];
  const add = (option) => {
    if (option.value === undefined || option.value === null || options.some((item) => same(item.value, option.value))) return;
    options.push(option);
  };
  (Array.isArray(field.options) ? field.options : Array.isArray(field.choices) ? field.choices : []).map(normalizeOption).forEach(add);
  (TICKET_CATALOG[field.key] || []).forEach(({ value, label }) => add({ value, label, isActive: true }));
  const known = (value) => options.some((item) => same(item.value, value) || same(item.label, value));
  [...new Set(observedValues.map(String))].filter((value) => !known(value)).sort((a, b) => a.localeCompare(b))
    .forEach((value) => add({ value, label: value, isActive: true }));
  return options;
}

// Departments and markets: the catalog's entries (code + label) carry the ids seen on real tickets; without one the code stands in
// as the id (the widget posts the code either way). A department or market seen on a ticket but not in the catalog is added.
function mergeByCode(catalogItems, observedItems, build) {
  const observedByCode = new Map(observedItems.map((item) => [String(item.code).toLowerCase(), item]));
  const merged = catalogItems.map((item) => build(item, observedByCode.get(String(item.code).toLowerCase())));
  for (const item of observedItems) {
    if (!merged.some((entry) => same(entry.code, item.code))) merged.push(build({ code: item.code, label: item.name ?? item.label }, item));
  }
  return merged;
}

// The ticket API's own lists (GET /markets, /departments, /fields/choices): live from its database, with real ids, labels and an active
// flag per choice. Each is read on its own and an answer without the expected list is treated as missing, so a failure (or a ticket
// system that does not have the call yet) falls back to the snapshot (ticket-catalog.js) for that part only.
// GET /fields entries say whether the person may fill them (postable) and whether they are required; a ticket list's field catalog does not,
// so only an answer that carries them is taken as the form.
const formFields = (list) => (Array.isArray(list) && list.length && list.every((field) => field && typeof field.key === "string" && "postable" in field) ? list : null);

async function readLiveCatalog(env, email) {
  const [markets, departments, choices, form] = await Promise.allSettled([
    ticketRequest(env, withOnBehalf("/markets", email)), ticketRequest(env, withOnBehalf("/departments", email)), ticketRequest(env, withOnBehalf("/fields/choices", email)),
    ticketRequest(env, withOnBehalf("/fields", email)),
  ]);
  const list = (result, key) => (result.status === "fulfilled" && Array.isArray(result.value?.[key]) ? result.value[key] : null);
  const fieldList = list(choices, "fields");
  const choiceMap = fieldList
    ? new Map(fieldList.filter((field) => field && Array.isArray(field.choices)).map((field) => [field.key, field.choices.map(normalizeOption)]))
    : null;
  return { markets: list(markets, "markets"), departments: list(departments, "departments"), choices: choiceMap && choiceMap.size ? choiceMap : null, fields: formFields(list(form, "fields")) };
}

export async function handler(event) {
  const post = event.httpMethod === "POST";
  if (event.httpMethod !== "GET" && !post) return json(405, { ok: false, error: "Method not allowed" });
  try {
    const settings = ticketSettings(event.env);
    const cacheKey = String(event.env?.TICKETS_API_KEY || "") + "|" + String(event.env?.TICKETS_API_BASE_URL || "");
    const input = post ? JSON.parse(event.body || "{}") : {};
    const fresh = post ? input.fresh === true : event.queryStringParameters?.fresh === "1";
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

    // A key that acts for others needs the person's email on every read: the signed-in agent's, when the widget sends who that is.
    let email = "";
    if (flag(event.env?.TICKETS_ON_BEHALF_OF) && input.author) {
      const acting = await actingAs(event.env, input.author);
      if (acting.response) return acting.response;
      if (!acting.email) return needTicketEmail("");
      email = acting.email;
    }

    // The list response is the API's only field-catalog endpoint. Strip all
    // ticket records here so no unrelated customer data reaches the browser.
    // GET /fields is the ticket form itself (required, defaults, choices, limits, for this person). Only without it is a page of 100 tickets
    // read to learn the form, as before.
    const live = await readLiveCatalog(event.env, email);
    const data = live.fields ? { tickets: [], fields: live.fields } : await ticketRequest(event.env, withOnBehalf("/tickets?pageSize=100", email));
    const tickets = Array.isArray(data.tickets) ? data.tickets : [];
    const uniqueById = (items) => Array.from(new Map(items
      .filter((item) => item && Number.isInteger(Number(item.id)))
      .map((item) => [Number(item.id), item])).values());
    const observedDepartments = uniqueById(tickets.flatMap((ticket) => [ticket.currentDepartment, ticket.raisedByDepartment]))
      .map(({ id, code, name }) => ({ id: Number(id), code, name }));
    const observedMarkets = uniqueById(tickets.map((ticket) => ticket.market))
      .filter((market) => market.isActive !== false)
      .map(({ id, code, label, currency }) => ({ id: Number(id), code, label, currency }));
    const departments = live.departments ? live.departments.filter((item) => item.receivesTickets !== false).map(({ id, code, name }) => ({ id, code, name })) : mergeByCode(
      TICKET_CATALOG.toDepartment.map(({ value, label }) => ({ code: value, label })),
      observedDepartments,
      (item, seen) => ({ id: seen ? seen.id : item.code, code: item.code, name: item.label ?? seen?.name ?? item.code }),
    );
    const markets = live.markets ? live.markets.map(({ id, code, label, currency }) => ({ id, code, label, ...(currency ? { currency } : {}) })) : mergeByCode(
      TICKET_CATALOG.market.map(({ value, label }) => ({ code: value, label })),
      observedMarkets,
      (item, seen) => ({ id: seen ? seen.id : item.code, code: item.code, label: item.label ?? seen?.label ?? item.code, ...(seen?.currency ? { currency: seen.currency } : {}) }),
    );
    const fields = (data.fields || [])
      .filter((field) => field.isActive !== false)
      .map((field) => {
        if (field.type !== "SELECT" && field.type !== "MULTISELECT") return field;
        const observed = tickets.flatMap((ticket) => {
          const value = ticket.fields?.[field.key];
          return Array.isArray(value) ? value : [value];
        }).filter((value) => value !== undefined && value !== null && String(value).trim());
        return { ...field, options: live.choices?.get(field.key) || fieldOptions(field, observed) };
      });
    const body = {
      ok: true,
      configured: true,
      fields,
      departments,
      markets,
      catalogSnapshot: CATALOG_SNAPSHOT_DATE,
      catalogSource: { departments: live.departments ? "live" : "snapshot", markets: live.markets ? "live" : "snapshot", choices: live.choices ? "live" : "snapshot", },
      formSource: live.fields ? "live" : "tickets",
      defaultDepartmentId: settings.departmentId,
      defaultMarketId: settings.marketId,
    };
    cachedConfig = { key: cacheKey, at: Date.now(), body };
    return json(200, body);
  } catch (err) {
    if (err instanceof SyntaxError) return json(400, { ok: false, error: "Malformed JSON" });
    return ticketError(err);
  }
}

export const onRequest = adapt(handler);
