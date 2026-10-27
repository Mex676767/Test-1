import { listRecords, toDisplay, TABLE_LEARNING_GROUP } from "./lark.js";

export const KNOWLEDGE_FIELDS = {
  title: "Title",
  category: "Category",
  brand: "Brand",
  keywords: "Keywords",
  summary: "Summary",
  steps: "Steps",
  referenceTable: "Reference Table",
  bonusAmounts: "Bonus Amounts",
  scenarios: "Scenarios",
  warning: "Warning",
  note: "Note",
  replyEn: "Reply Template",
  replyMs: "Reply MS",
  replyZh: "Reply ZH",
  picture: "Picture",
  status: "Status",
  sort: "Sort",
};

const LIVE = "live";
const CACHE_MS = 60_000;

const clean = (value) => String(value ?? "").trim();
const lines = (value) => clean(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const cells = (line) => line.split("|").map((cell) => cell.trim());
const text = (fields, name) => clean(toDisplay(fields[name]));

// "Title | Description" per line; a line without a bar is a description with no title.
export function parseSteps(value) {
  return lines(value).map((line) => {
    const at = line.indexOf("|");
    if (at < 0) return { title: "", text: line };
    const title = line.slice(0, at).trim();
    const body = line.slice(at + 1).trim();
    return body ? { title, text: body } : { title: "", text: title };
  });
}

// First line = column headings, every other line = one row, columns split by "|".
export function parseTable(value, title = "Reference") {
  const rows = lines(value).map(cells);
  if (!rows.length) return null;
  return { title, cols: rows[0], rows: rows.slice(1) };
}

const OK_WORDS = new Set(["ok", "yes", "eligible", "pass"]);
const NO_WORDS = new Set(["not ok", "no", "not eligible", "fail"]);

// "ok | Title | Situation | Result" per line. Without a leading ok / not ok the scenario counts as ok.
export function parseScenarios(value) {
  return lines(value).map((line) => {
    const parts = cells(line);
    const word = parts[0].toLowerCase();
    const known = OK_WORDS.has(word) || NO_WORDS.has(word);
    const [title = "", body = "", result = ""] = known ? parts.slice(1) : parts;
    return { ok: known ? OK_WORDS.has(word) : true, title, text: body, result };
  }).filter((scenario) => scenario.title || scenario.text);
}

export function parseReplies(en, ms, zh) {
  const replies = {};
  for (const [lang, value] of [["en", en], ["ms", ms], ["zh", zh]]) {
    const sentences = lines(value);
    if (sentences.length) replies[lang] = sentences;
  }
  return replies;
}

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
  const title = text(fields, KNOWLEDGE_FIELDS.title);
  const category = text(fields, KNOWLEDGE_FIELDS.category);
  if (!record?.record_id || !title || !category || !isLive(fields)) return null;
  const picture = firstPicture(fields);
  const sortText = text(fields, KNOWLEDGE_FIELDS.sort);
  const sort = Number(sortText);
  const bonusAmounts = lines(toDisplay(fields[KNOWLEDGE_FIELDS.bonusAmounts]));
  const table = parseTable(toDisplay(fields[KNOWLEDGE_FIELDS.referenceTable]))
    || (bonusAmounts.length ? { title: "Bonus reference", cols: ["Bonus"], rows: bonusAmounts.map((line) => [line]) } : null);
  return {
    id: record.record_id,
    title,
    category,
    brand: text(fields, KNOWLEDGE_FIELDS.brand),
    keywords: lines(toDisplay(fields[KNOWLEDGE_FIELDS.keywords])),
    summary: text(fields, KNOWLEDGE_FIELDS.summary),
    steps: parseSteps(toDisplay(fields[KNOWLEDGE_FIELDS.steps])),
    bonus_table: table,
    scenarios: parseScenarios(toDisplay(fields[KNOWLEDGE_FIELDS.scenarios])),
    warning: text(fields, KNOWLEDGE_FIELDS.warning),
    note: text(fields, KNOWLEDGE_FIELDS.note),
    replies: parseReplies(
      toDisplay(fields[KNOWLEDGE_FIELDS.replyEn]),
      toDisplay(fields[KNOWLEDGE_FIELDS.replyMs]),
      toDisplay(fields[KNOWLEDGE_FIELDS.replyZh]),
    ),
    image: picture ? `/knowledge-image?id=${encodeURIComponent(record.record_id)}&v=${encodeURIComponent(clean(picture.file_token).slice(-12))}` : "",
    sort: Number.isFinite(sort) && sortText !== "" ? sort : null,
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
