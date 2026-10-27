import { adapt } from "./_lib/adapt.js";
import { createRecord, updateRecord, TABLE_LEARNING_GROUP } from "./_lib/lark.js";
import { fileMatchesType, isStoredImage } from "./_lib/ticket-images.js";
import {
  clearKnowledgeCache, ensureCategoryOption, GuideInputError, guideToFields, knowledgeFieldOptions,
  KNOWLEDGE_FIELDS, listKnowledgeRecords, uploadPicture,
} from "./_lib/knowledge.js";

const MAX_PICTURE_BYTES = 5 * 1024 * 1024;
const RECORD_ID = /^rec[A-Za-z0-9]{6,40}$/;

const reply = (statusCode, body) => ({ statusCode, headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });

async function checkedPicture(form) {
  const file = form.get("picture");
  if (!file || typeof file !== "object" || !file.size) return null;
  if (!isStoredImage(file) || !(await fileMatchesType(file))) throw new GuideInputError("The picture must be a PNG, JPEG or WebP image.");
  if (file.size > MAX_PICTURE_BYTES) throw new GuideInputError("The picture is too large (max 5 MB).");
  return file;
}

// Creates a guide in the Learning Group table, or updates it when the form sends an id.
export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return reply(405, { ok: false, error: "Method not allowed" });
    if (!TABLE_LEARNING_GROUP) return reply(503, { ok: false, error: "The Learning Group table is not set up yet." });
    const form = event.formData;
    if (!form) return reply(400, { ok: false, error: "Send the guide as a form." });
    let input;
    try { input = JSON.parse(String(form.get("guide") || "")); } catch (_) { return reply(400, { ok: false, error: "The guide could not be read." }); }

    const options = await knowledgeFieldOptions();
    const fields = guideToFields(input, { brands: options?.brands });
    const picture = await checkedPicture(form);

    const id = String(input.id || "").trim();
    if (id) {
      if (!RECORD_ID.test(id)) return reply(400, { ok: false, error: "That guide id is not valid." });
      const records = await listKnowledgeRecords({ fresh: true });
      if (!records.some((record) => record.record_id === id)) return reply(404, { ok: false, error: "That guide no longer exists." });
    }

    await ensureCategoryOption(fields[KNOWLEDGE_FIELDS.category]);
    if (picture) fields[KNOWLEDGE_FIELDS.picture] = [{ file_token: await uploadPicture(picture) }];
    else if (id && input.removePicture === true) fields[KNOWLEDGE_FIELDS.picture] = [];

    const record = id ? await updateRecord(TABLE_LEARNING_GROUP, id, fields) : await createRecord(TABLE_LEARNING_GROUP, fields);
    clearKnowledgeCache();
    return reply(200, { ok: true, id: record?.record_id || id, created: !id });
  } catch (err) {
    if (err instanceof GuideInputError) return reply(400, { ok: false, error: err.message });
    return reply(502, { ok: false, error: String(err.message || err) });
  }
}

export const onRequest = adapt(handler);
