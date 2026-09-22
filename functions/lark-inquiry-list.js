import { adapt } from "./_lib/adapt.js";
import { getFieldOptionMap, TABLE_CUSTOMER_APPROACHING } from "./_lib/lark.js";

// Reads options straight from the "Inquiry" field's own choice list on
// Customer Approaching -- same pattern as lark-brand-list.js/lark-pic-
// list.js. Previously this list was a hardcoded array baked into app.js
// (a stale snapshot by definition -- confirmed live: an Inquiry tag
// removed in Lark stayed selectable in the app indefinitely, since nothing
// ever re-read the real field). fresh: true, see getFieldOptionMap's note.
export async function handler() {
  try {
    const optionMap = await getFieldOptionMap(TABLE_CUSTOMER_APPROACHING, "Inquiry", undefined, { fresh: true });
    const options = Array.from(optionMap.values()).filter(Boolean);
    return { statusCode: 200, body: JSON.stringify({ ok: true, options }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, options: [], error: err.message }) };
  }
}

export const onRequest = adapt(handler);
