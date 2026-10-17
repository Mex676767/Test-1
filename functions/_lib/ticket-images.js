// Ticket images live in a Cloudflare R2 bucket (Pages binding TICKET_IMAGES); the ticket carries a link to each one instead of
// the file itself. PDFs are not images and keep going to the ticket system as attachments.
//
// A link is the public URL of the object: TICKET_IMAGES_PUBLIC_URL + "/" + key when the bucket has a public address of its own
// (custom domain or r2.dev), otherwise this site's /ticket-image?k=<key>, which reads the object through the binding. The key
// holds a random UUID, so a link cannot be guessed.
export const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
export const IMAGE_KEY = /^tickets\/\d{8}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/;

export const isStoredImage = (file) => Boolean(IMAGE_TYPES[file?.type]);

// Off by default: pictures are attached to the ticket or comment itself (under 1MB each, the ticket system's limit). Only with the bucket
// bound AND TICKET_IMAGES_VIA_R2 switched on do pictures go to the bucket and a link is sent instead.
export const useImageBucket = (env) => Boolean(env?.TICKET_IMAGES) && ["1", "true", "on", "yes"].includes(String(env?.TICKET_IMAGES_VIA_R2 ?? "").trim().toLowerCase());

// What a file IS, by its first bytes, not by the name or type the browser gave it: a renamed web page, script or archive is refused (the
// ticket system checks the same). PNG, JPEG, WebP and PDF only.
const ascii = (bytes, from, to) => String.fromCharCode(...bytes.slice(from, to));
const SIGNATURES = {
  "image/png": (b) => b[0] === 0x89 && ascii(b, 1, 4) === "PNG",
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP",
  "application/pdf": (b) => ascii(b, 0, 5) === "%PDF-",
};
export async function fileMatchesType(file) {
  const check = SIGNATURES[file?.type];
  if (!check) return false;
  return check(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
}

function linkFor(env, host, key) {
  const publicBase = String(env.TICKET_IMAGES_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (publicBase) return `${publicBase}/${key}`;
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
  return `${local ? "http" : "https"}://${host}/ticket-image?k=${encodeURIComponent(key)}`;
}

// Puts every file in the bucket. Returns { links, keys }; when a put fails the objects already stored are removed again.
export async function storeTicketImages(env, host, files) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const keys = [];
  try {
    for (const file of files) {
      const key = `tickets/${day}/${crypto.randomUUID()}.${IMAGE_TYPES[file.type]}`;
      await env.TICKET_IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
      keys.push(key);
    }
  } catch (error) {
    await deleteTicketImages(env, keys);
    throw error;
  }
  return { keys, links: keys.map((key) => linkFor(env, host, key)) };
}

// Best effort: a leftover object is harmless (nothing points to it).
export async function deleteTicketImages(env, keys) {
  if (!keys.length) return;
  try { await env.TICKET_IMAGES.delete(keys); } catch (_) { /* an R2 lifecycle rule can sweep what is left */ }
}
