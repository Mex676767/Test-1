import { adapt } from "./_lib/adapt.js";
import { createRecord, getRecord, listFields, searchRecords, toDisplay, updateRecord, TABLE_BIRTHDAY } from "./_lib/lark.js";
import { fileMatchesType, isStoredImage } from "./_lib/ticket-images.js";
import { uploadPicture } from "./_lib/knowledge.js";
import { BF, bonusAmountOf, newRowFields, rowYear, malaysiaDateOf } from "./_lib/birthday.js";

const MAX_PICTURE_BYTES = 5 * 1024 * 1024;
const RECORD_ID = /^rec[A-Za-z0-9]{6,40}$/;
const reply = (statusCode, body) => ({ statusCode, headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
const clean = (value, max = 200) => String(value ?? "").trim().slice(0, max);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class InputError extends Error {}

// Lark fills SW - Bonus Amount (lookups/formulas) a moment after the row is written: read it a few times.
async function readAmount(recordId, delays = [0, 700, 1200, 1800]) {
  let record = null;
  for (const wait of delays) {
    if (wait) await sleep(wait);
    record = await getRecord(TABLE_BIRTHDAY, recordId);
    if (bonusAmountOf(record?.fields?.[BF.amount]) > 0) break;
  }
  return {
    amount: bonusAmountOf(record?.fields?.[BF.amount]),
    bonusType: toDisplay(record?.fields?.[BF.bonusType]).slice(0, 80),
  };
}

async function checkedPicture(form) {
  const file = form.get("picture");
  if (!file || typeof file !== "object" || !file.size) return null;
  if (!isStoredImage(file) || !(await fileMatchesType(file))) throw new InputError("The ID picture must be a PNG, JPEG or WebP image.");
  if (file.size > MAX_PICTURE_BYTES) throw new InputError("The ID picture is too large (max 5 MB).");
  return file;
}

// POST multipart { username, brand, dob, picture } -> creates (or reuses this year's) Birthday Bonus row with the
//   ID picture in Screenshot, then reads SW - Bonus Amount back.
// POST JSON { action: "approve", recordId, username, atl } -> writes "Approved by <atl>" in Remark (amount over RM300).
export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return reply(405, { ok: false, error: "Method not allowed" });
    if (!TABLE_BIRTHDAY) return reply(200, { ok: false, notConfigured: true, error: "The Birthday Bonus table is not set up yet (LARK_TABLE_BIRTHDAY)." });

    if (!event.formData) {
      let body;
      try { body = JSON.parse(event.body || "{}"); } catch (_) { return reply(400, { ok: false, error: "The request was not valid JSON." }); }
      if (body?.action !== "approve" && body?.action !== "removePicture") return reply(400, { ok: false, error: "Unknown action." });
      const recordId = clean(body.recordId, 60);
      const atl = clean(body.atl, 80);
      if (!RECORD_ID.test(recordId)) return reply(400, { ok: false, error: "That Birthday Bonus row id is not valid." });
      if (body.action === "approve" && !atl) return reply(400, { ok: false, error: "Enter the ATL's name." });
      const record = await getRecord(TABLE_BIRTHDAY, recordId);
      if (toDisplay(record?.fields?.[BF.username]).trim().toLowerCase() !== clean(body.username).toLowerCase()) {
        return reply(409, { ok: false, error: "That Birthday Bonus row belongs to another player." });
      }
      // removePicture: the agent took the ID picture back off (wrong photo); the row's Screenshot is emptied.
      await updateRecord(TABLE_BIRTHDAY, recordId, body.action === "approve" ? { [BF.remark]: `Approved by ${atl}` } : { [BF.screenshot]: [] });
      return reply(200, { ok: true });
    }

    const form = event.formData;
    const username = clean(form.get("username"));
    const brand = clean(form.get("brand"), 40).toUpperCase();
    const dob = clean(form.get("dob"), 10);
    if (!username || !brand) return reply(400, { ok: false, error: "Look up the player first." });
    const picture = await checkedPicture(form);

    const nowMs = Date.now();
    const year = malaysiaDateOf(nowMs).slice(0, 4);
    const [catalog, rows] = await Promise.all([
      listFields(TABLE_BIRTHDAY),
      searchRecords(TABLE_BIRTHDAY, [
        { field_name: BF.username, operator: "is", value: [username] },
        { field_name: BF.brand, operator: "is", value: [brand] },
      ], undefined, { automaticFields: true }),
    ]);
    // A row already made this year (e.g. Check amount pressed before) is reused, so one birthday never gets two rows.
    const existing = rows.filter((row) => rowYear(row) === year).sort((a, b) => Number(b.created_time) - Number(a.created_time))[0];
    if (!existing && !picture) return reply(400, { ok: false, error: "Attach the customer's ID picture first." });

    const fileToken = picture ? await uploadPicture(picture) : "";
    let recordId;
    if (existing) {
      recordId = existing.record_id;
      if (fileToken) await updateRecord(TABLE_BIRTHDAY, recordId, { [BF.screenshot]: [{ file_token: fileToken }] });
    } else {
      const created = await createRecord(TABLE_BIRTHDAY, newRowFields({ username, brand, dob, fileToken, nowMs }, catalog));
      recordId = created?.record_id;
      if (!recordId) throw new Error("Lark did not return the new Birthday Bonus row.");
    }
    const { amount, bonusType } = await readAmount(recordId);
    return reply(200, { ok: true, recordId, amount, bonusType, reused: !!existing });
  } catch (err) {
    if (err instanceof InputError) return reply(400, { ok: false, error: err.message });
    return reply(502, { ok: false, error: String(err?.message || err).slice(0, 300) });
  }
}

export const onRequest = adapt(handler);
