import { listRecords, toDisplay, TABLE_LEARNING_GROUP } from "./lark.js";

export const KNOWLEDGE_FIELDS = {
  title: "Title",
  category: "Category",
  brand: "Brand",
  keywords: "Keywords",
  summary: "Summary",
  steps: "Steps",
  bonusAmounts: "Bonus Amounts",
  warning: "Warning",
  example: "Reply Template",
  picture: "Picture",
  status: "Status",
  sort: "Sort",
};

const LIVE = "live";
const CACHE_MS = 60_000;

const clean = (value) => String(value ?? "").trim();
const lines = (value) => clean(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

export function firstPicture(fields) {
  const files = fields?.[KNOWLEDGE_FIELDS.picture];
  if (!Array.isArray(files)) return null;
  return files.find((file) => file && clean(file.file_token)) || null;
}

export function isLive(fields) {
  return clean(toDisplay(fields?.[KNOWLEDGE_FIELDS.status])).toLowerCase() === LIVE;
}

export function recordToGuide(record) {
  const fields = record?.fields || {};
  const title = clean(toDisplay(fields[KNOWLEDGE_FIELDS.title]));
  const category = clean(toDisplay(fields[KNOWLEDGE_FIELDS.category]));
  if (!record?.record_id || !title || !category || !isLive(fields)) return null;
  const picture = firstPicture(fields);
  const sort = Number(toDisplay(fields[KNOWLEDGE_FIELDS.sort]));
  return {
    id: record.record_id,
    title,
    category,
    brand: clean(toDisplay(fields[KNOWLEDGE_FIELDS.brand])),
    keywords: lines(toDisplay(fields[KNOWLEDGE_FIELDS.keywords])),
    summary: clean(toDisplay(fields[KNOWLEDGE_FIELDS.summary])),
    steps: lines(toDisplay(fields[KNOWLEDGE_FIELDS.steps])),
    bonus_amounts: lines(toDisplay(fields[KNOWLEDGE_FIELDS.bonusAmounts])),
    warning: clean(toDisplay(fields[KNOWLEDGE_FIELDS.warning])),
    example: clean(toDisplay(fields[KNOWLEDGE_FIELDS.example])),
    image: picture ? `/knowledge-image?id=${encodeURIComponent(record.record_id)}&v=${encodeURIComponent(clean(picture.file_token).slice(-12))}` : "",
    sort: Number.isFinite(sort) && clean(toDisplay(fields[KNOWLEDGE_FIELDS.sort])) !== "" ? sort : null,
  };
}

export function sortGuides(guides) {
  const rank = (guide) => (guide.sort === null ? Infinity : guide.sort);
  return guides.slice().sort((a, b) => (rank(a) === rank(b) ? a.title.localeCompare(b.title) : rank(a) < rank(b) ? -1 : 1));
}

let cache = { expires: 0, records: [] };
export function clearKnowledgeCache() { cache = { expires: 0, records: [] }; }

export async function listKnowledgeRecords({ fresh = false } = {}) {
  if (!TABLE_LEARNING_GROUP) return null;
  if (!fresh && Date.now() < cache.expires) return cache.records;
  const records = await listRecords(TABLE_LEARNING_GROUP, 500, { sharedCacheMs: CACHE_MS, force: fresh });
  cache = { expires: Date.now() + CACHE_MS, records };
  return records;
}
