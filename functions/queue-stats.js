import { adapt } from "./_lib/adapt.js";
import { queueStubFrom } from "./_lib/queue-stub.js";

// Read-only health numbers from the shared Lark queue (the Durable Object): starts per class, 429s, queue wait, batch sizes,
// create batches/mismatches. Used to decide whether the gate pace can be raised and to watch batched creates.
//
// Disabled (404) until the QUEUE_STATS_KEY variable is set on the Pages project. Callers send it as the x-stats-key header
// (never in the URL, which would end up in logs). The numbers contain no usernames or record data.
const headers = { "Cache-Control": "no-store" };

function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handler(event) {
  const key = event.env?.QUEUE_STATS_KEY;
  if (!key) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: "Not found" }) };
  if (event.httpMethod !== "GET") return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };
  if (!sameSecret(String(event.headers?.["x-stats-key"] || ""), String(key))) {
    return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: "Unauthorized" }) };
  }
  const queue = event.env?.LARK_SEARCH_QUEUE;
  if (!queue) return { statusCode: 503, headers, body: JSON.stringify({ ok: false, error: "Queue binding is not available" }) };
  try {
    const stub = queueStubFrom(queue, event.env);
    if (typeof stub.getStats !== "function") throw new Error("The deployed queue has no getStats");
    // Where does the queue run? (colo + country; cached inside the queue after the first call). An older queue has no locate().
    if (typeof stub.locate === "function") { try { await stub.locate(); } catch (_) { /* best effort */ } }
    const stats = await stub.getStats();
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, at: new Date().toISOString(), stats }) };
  } catch (error) {
    return { statusCode: 503, headers, body: JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 200) }) };
  }
}

export const onRequest = adapt(handler);
