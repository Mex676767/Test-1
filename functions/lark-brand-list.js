import { adapt } from "./_lib/adapt.js";
import { getFieldOptionMap, TABLE_CUSTOMER_APPROACHING } from "./_lib/lark.js";

// Reads options straight from the "Brand" field's own Single Select choice
// list on Customer Approaching — same pattern lark-pic-list.js uses for
// Agent Name (reusing the same cached getFieldOptionMap helper Tier
// resolution uses too). Brand stays auto-filled by default
// (resolveBrandFromGroupId), but CS can override it via this dropdown when
// detection fails or is wrong — a dropdown instead of free text means they
// can only pick a value that actually exists as a real Brand option, not a
// typo that wouldn't match any per-table Brand column value.
export async function handler() {
  try {
    // fresh: true -- see getFieldOptionMap's own note; only called at boot
    // and on the widget's periodic options refresh, so no reason to ever
    // serve a stale (up to 10 min old) list here.
    const optionMap = await getFieldOptionMap(TABLE_CUSTOMER_APPROACHING, "Brand", undefined, { fresh: true });
    const names = Array.from(optionMap.values()).filter(Boolean).sort();
    // An empty list is never a real answer (Brand always has options). Reporting
    // it as ok:true used to make the widget REPLACE its working list with [],
    // which is how Brand auto-detection and the Brand dropdown "disappeared"
    // whenever Lark was slow. Fail instead so the widget keeps its last list.
    if (!names.length) return { statusCode: 502, body: JSON.stringify({ ok: false, brands: [], error: "Brand option list came back empty." }) };
    return { statusCode: 200, body: JSON.stringify({ ok: true, brands: names }) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, brands: [], error: String(err.message || err) }) };
  }
}

export const onRequest = adapt(handler);
