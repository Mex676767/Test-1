import { adapt } from "./_lib/adapt.js";
import { readingAs } from "./_lib/ticket-actor.js";
import { fileMatchesType, IMAGE_TYPES } from "./_lib/ticket-images.js";
import { json, ticketCredentials, ticketSettings, withOnBehalf } from "./_lib/tickets.js";

// A picture that sits on a ticket or comment in the ticket system, for the widget to show as a preview. The ticket system serves its files
// from /api/attachments/<path> and, to an API key, only images (a PDF there asks for a browser login), so the browser cannot load them
// itself: this reads one through the key, as the signed-in agent, and hands back the picture only if its bytes really are a PNG, JPEG or
// WebP. POST { path, author } -> the image. Anything else is refused, so this cannot be used to read other files.
const MAX_BYTES = 6 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
// What the ticket system writes: folders and a file name, e.g. 2026-09/21/3f9a…c1.jpg. No dot-segments, no leading slash.
const PATH = /^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9_\-./]{0,250}\.(png|jpe?g|webp)$/i;

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  try {
    if (!ticketSettings(event.env).configured) return json(503, { ok: false, error: "Ticket integration is not configured" });
    const input = JSON.parse(event.body || "{}");
    const path = String(input.path || "").trim();
    if (!PATH.test(path)) return json(400, { ok: false, error: "That is not a picture on a ticket." });
    const reading = await readingAs(event.env, input.author);
    if (reading.response) return reading.response;

    const { apiKey, baseUrl } = ticketCredentials(event.env);
    const origin = new URL(baseUrl).origin;
    const url = withOnBehalf(`${origin}/api/attachments/${path.split("/").map(encodeURIComponent).join("/")}`, reading.email);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: "manual", // a file that needs a browser login answers with a redirect: not a picture we can show
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 429) return json(429, { ok: false, error: "The ticket system is busy. Try again in a moment." }, { "Retry-After": "20" });
    if (!response.ok) {
      const redirected = response.status >= 300 && response.status < 400;
      return json(502, { ok: false, upstreamStatus: response.status, error: redirected ? "The ticket system asks for a login to open this file." : `The ticket system answered ${response.status} for this picture.` });
    }
    const type = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES[type]) return json(415, { ok: false, error: `The ticket system sent this file as ${type || "an unknown type"}, not as a picture.` });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES) return json(413, { ok: false, error: "That picture is too large to preview." });
    if (!(await fileMatchesType(new Blob([bytes], { type })))) return json(415, { ok: false, error: "That file is not a picture." });
    return {
      statusCode: 200,
      bytes,
      headers: {
        "Content-Type": type,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      },
    };
  } catch (err) {
    if (err instanceof SyntaxError) return json(400, { ok: false, error: "Malformed JSON" });
    return json(502, { ok: false, error: "The picture could not be loaded." });
  }
}

export const onRequest = adapt(handler);
