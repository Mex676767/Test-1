import { adapt } from "./_lib/adapt.js";
import { getFieldOptionMap, TABLE_CUSTOMER_APPROACHING } from "./_lib/lark.js";

export async function handler() {
  try {
    const optionMap = await getFieldOptionMap(TABLE_CUSTOMER_APPROACHING, "Brand", undefined, { fresh: true });
    const names = Array.from(optionMap.values()).filter(Boolean).sort();
    if (!names.length) return { statusCode: 502, body: JSON.stringify({ ok: false, brands: [], error: "Brand option list came back empty." }) };
    return { statusCode: 200, body: JSON.stringify({ ok: true, brands: names }) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, brands: [], error: String(err.message || err) }) };
  }
}

export const onRequest = adapt(handler);
