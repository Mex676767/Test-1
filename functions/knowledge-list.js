import { adapt } from "./_lib/adapt.js";
import { listKnowledgeRecords, recordToGuide, sortGuides } from "./_lib/knowledge.js";

export async function handler(event) {
  try {
    const fresh = event.queryStringParameters?.fresh === "1";
    const records = await listKnowledgeRecords({ fresh });
    if (!records) return { statusCode: 200, body: JSON.stringify({ ok: true, configured: false, guides: [] }) };
    const guides = sortGuides(records.map(recordToGuide).filter(Boolean));
    return {
      statusCode: 200,
      headers: fresh ? { "Cache-Control": "no-store" } : {},
      body: JSON.stringify({ ok: true, configured: true, guides }),
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, guides: [], error: String(err.message || err) }) };
  }
}

export const onRequest = adapt(handler);
