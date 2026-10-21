export const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
export const IMAGE_KEY = /^tickets\/\d{8}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/;

export const isStoredImage = (file) => Boolean(IMAGE_TYPES[file?.type]);

export const useImageBucket = (env) => Boolean(env?.TICKET_IMAGES) && ["1", "true", "on", "yes"].includes(String(env?.TICKET_IMAGES_VIA_R2 ?? "").trim().toLowerCase());

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

export async function deleteTicketImages(env, keys) {
  if (!keys.length) return;
  try { await env.TICKET_IMAGES.delete(keys); } catch (_) { }
}
