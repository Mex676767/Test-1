import { IMAGE_KEY, IMAGE_TYPES } from "./_lib/ticket-images.js";

const text = (status, message) => new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET" && request.method !== "HEAD") return text(405, "Method not allowed");
  const bucket = env?.TICKET_IMAGES;
  if (!bucket) return text(404, "Not found");
  const key = new URL(request.url).searchParams.get("k") || "";
  if (!IMAGE_KEY.test(key)) return text(404, "Not found");
  const object = await bucket.get(key);
  if (!object) return text(404, "Not found");
  const stored = object.httpMetadata?.contentType;
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers: {
      "Content-Type": IMAGE_TYPES[stored] ? stored : "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}
