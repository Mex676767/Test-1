import { adapt } from "./_lib/adapt.js";
import { getFieldOptionMap, TABLE_CUSTOMER_APPROACHING } from "./_lib/lark.js";

// Reads options straight from the "Status" field's own choice list on
// Customer Approaching -- same pattern as lark-inquiry-list.js. Previously
// hardcoded in app.js (a stale snapshot). fresh: true, see
// getFieldOptionMap's note.
export async function handler() {
  try {
    const optionMap = await getFieldOptionMap(TABLE_CUSTOMER_APPROACHING, "Status", undefined, { fresh: true });
    const options = Array.from(optionMap.values()).filter(Boolean);
    return { statusCode: 200, body: JSON.stringify({ ok: true, options }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, options: [], error: err.message }) };
  }
}

export const onRequest = adapt(handler);
