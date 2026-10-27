import { adapt } from "./_lib/adapt.js";
import { knowledgeFieldOptions, listKnowledgeRecords, recordToGuide, sortGuides } from "./_lib/knowledge.js";

// all=1 is what the admin preview uses: it also lists Draft guides and the Category / Brand options.
export async function handler(event) {
  try {
    const all = event.queryStringParameters?.all === "1";
    const fresh = all || event.queryStringParameters?.fresh === "1";
    const records = await listKnowledgeRecords({ fresh });
    if (!records) return { statusCode: 200, body: JSON.stringify({ ok: true, configured: false, guides: [] }) };
    const guides = sortGuides(records.map((record) => recordToGuide(record, { includeDrafts: all })).filter(Boolean));
    const body = { ok: true, configured: true, guides };
    if (all) body.options = await knowledgeFieldOptions();
    return { statusCode: 200, headers: fresh ? { "Cache-Control": "no-store" } : {}, body: JSON.stringify(body) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, guides: [], error: String(err.message || err) }) };
  }
}

export const onRequest = adapt(handler);
