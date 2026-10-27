import { adapt } from "./_lib/adapt.js";
import { getTenantToken } from "./_lib/lark.js";
import { firstPicture, listKnowledgeRecords } from "./_lib/knowledge.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MEDIA_URL = /^https:\/\/open\.larksuite\.com\/open-apis\/drive\/v1\/medias\/[^/?#]+\/download(\?|$)/;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_BYTES = 6 * 1024 * 1024;

const plain = (statusCode, message) => ({ statusCode, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, body: message });

// Only a picture attached to a row of the Learning Group table is served (Draft rows too, so the
// admin preview can check them), so this can never be used to read any other file the Lark app can reach.
export async function handler(event) {
  try {
    const id = String(event.queryStringParameters?.id || "").trim();
    if (!/^rec[A-Za-z0-9]{6,40}$/.test(id)) return plain(404, "Not found");
    const records = await listKnowledgeRecords();
    if (!records) return plain(404, "Not found");
    const record = records.find((row) => row.record_id === id);
    const file = record && firstPicture(record.fields);
    if (!file) return plain(404, "Not found");

    const given = String(file.url || "");
    const url = MEDIA_URL.test(given)
      ? given
      : `https://open.larksuite.com/open-apis/drive/v1/medias/${encodeURIComponent(file.file_token)}/download`;
    const token = await getTenantToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) return plain(502, "Picture could not be loaded.");
    const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) return plain(415, "Not a picture.");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) return plain(413, "Picture is too large.");
    return {
      statusCode: 200,
      bytes,
      headers: {
        "Content-Type": type,
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      },
    };
  } catch (err) {
    return plain(502, "Picture could not be loaded.");
  }
}

export const onRequest = adapt(handler);
