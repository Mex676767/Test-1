import { adapt } from "./_lib/adapt.js";

const ASSET_PATHS = ["/widget-release.json", "/deployment-refresh.js", "/blast/index.html", "/blast/popup.js", "/blast/web-adapter.js"];
const TTL_MS = 30_000;
let cached = null;
export function resetWidgetVersionCache() { cached = null; }

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function computeWidgetVersion(assets) {
  const encoder = new TextEncoder();
  const parts = [];
  for (const path of ASSET_PATHS) {
    const response = await assets.fetch(new Request(`http://assets${path}`));
    if (!response.ok) throw new Error(`Asset ${path} returned HTTP ${response.status}`);
    parts.push(encoder.encode(`\n--${path}--\n`), new Uint8Array(await response.arrayBuffer()));
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { all.set(part, offset); offset += part.length; }
  return hex(await crypto.subtle.digest("SHA-1", all));
}

export async function handler(event) {
  const headers = { "Cache-Control": "no-store" };
  if (event.httpMethod !== "GET") return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };
  try {
    if (!event.env?.ASSETS?.fetch) throw new Error("Static assets binding is not available");
    if (!cached || Date.now() - cached.at > TTL_MS) {
      cached = { at: Date.now(), version: await computeWidgetVersion(event.env.ASSETS) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, version: cached.version }) };
  } catch (error) {
    return { statusCode: 503, headers, body: JSON.stringify({ ok: false, error: String(error.message || error) }) };
  }
}

export const onRequest = adapt(handler);
