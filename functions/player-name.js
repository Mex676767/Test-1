import { adapt } from "./_lib/adapt.js";
import { getRecord, listFields, updateRecord, toDisplay, TABLE_PNL } from "./_lib/lark.js";

const reply = (statusCode, body) => ({ statusCode, headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
const normalized = (value) => String(value || "").trim().toLowerCase();

export async function handler(event) {
  if (event.httpMethod !== "POST") return reply(405, { ok: false, error: "Method not allowed" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (_) { return reply(400, { ok: false, error: "Invalid request." }); }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 200 || /[\r\n\x00-\x1f]/.test(name)) return reply(400, { ok: false, error: "Enter a name between 1 and 200 characters on one line." });
  if (!/^rec[A-Za-z0-9]{6,40}$/.test(body.recordId || "") || !normalized(body.username) || !normalized(body.brand) || typeof body.expectedName !== "string") {
    return reply(400, { ok: false, error: "Look up the player again before editing their name." });
  }
  if (!TABLE_PNL) return reply(503, { ok: false, error: "The P&L file is not configured." });
  try {
    const record = await getRecord(TABLE_PNL, body.recordId);
    if (!record) return reply(404, { ok: false, error: "Player not found in the P&L file." });
    if (normalized(toDisplay(record.fields?.["Username/UID"])) !== normalized(body.username)
      || normalized(toDisplay(record.fields?.Brand)) !== normalized(body.brand)) {
      return reply(409, { ok: false, error: "The player has changed. Look up the player again before saving." });
    }
    const current = toDisplay(record.fields?.["Title name"]) || toDisplay(record.fields?.["Tittle name"]);
    if (current !== body.expectedName && current !== name) return reply(409, { ok: false, error: "This name was changed in the P&L file. Look up the player again before editing." });
    const fields = await listFields(TABLE_PNL);
    const field = fields.find((item) => item.field_name === "Title name") || fields.find((item) => item.field_name === "Tittle name");
    if (!field || field.type !== 1) return reply(409, { ok: false, error: "The P&L file needs an editable text column called Title name (or Tittle name)." });
    if (current !== name) await updateRecord(TABLE_PNL, body.recordId, { [field.field_name]: name });
    return reply(200, { ok: true, customerName: name });
  } catch (error) {
    return reply(502, { ok: false, error: String(error?.message || error).slice(0, 300) });
  }
}

export const onRequest = adapt(handler);
