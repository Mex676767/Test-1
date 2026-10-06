import { adapt } from "./_lib/adapt.js";

// "Which version of the widget is deployed right now?" for the widget's update nudge (deployment-refresh.js).
//
// Pages auto-deploys every push, and a static Pages build cannot stamp a commit id into index.html (that only
// happens with scripts/deploy.ps1). Instead the version is a SHA-1 of the deployed client files themselves, so it
// changes exactly when any of them changes -- no build step and nobody has to remember to bump anything. It is an
// explicit release id (40 hex characters), not an ETag or a file length.
const ASSET_PATHS = ["/", "/app.js", "/style.css", "/deployment-refresh.js", "/blast/index.html", "/blast/popup.js", "/blast/web-adapter.js"];
const TTL_MS = 30_000;
let cached = null; // { at, version }
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
    // The widget treats any failure as "no information" and never reloads because of it.
    return { statusCode: 503, headers, body: JSON.stringify({ ok: false, error: String(error.message || error) }) };
  }
}

export const onRequest = adapt(handler);
