import { getTenantToken, larkBaseToken, listFields, listRecords, toDisplay, TABLE_LEARNING_GROUP } from "./lark.js";

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

export function recordToGuide(record, { includeDrafts = false } = {}) {
  const fields = record?.fields || {};
  const title = text(fields, KNOWLEDGE_FIELDS.title);
  const category = text(fields, KNOWLEDGE_FIELDS.category);
  if (!record?.record_id || !title || !category || !(includeDrafts || isLive(fields))) return null;
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
    status: isLive(fields) ? "Live" : "Draft",
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

/* ---- writing guides from the admin form ---- */

export class GuideInputError extends Error {}
const bad = (message) => { throw new GuideInputError(message); };

const LIMITS = { title: 120, category: 60, brand: 60, keyword: 60, keywords: 40, summary: 1000, stepTitle: 120, stepText: 1500, steps: 30, cell: 200, cols: 6, rows: 40, scenario: 600, scenarios: 12, block: 1500, sentence: 500, sentences: 20 };

const capped = (value, max, label) => {
  const out = clean(value);
  if (out.length > max) bad(`${label} is too long (max ${max} characters).`);
  return out;
};
const oneLine = (value) => clean(value).replace(/\s*[\r\n]+\s*/g, " ");
const noBar = (value) => oneLine(value).replace(/\|/g, "/");
const asList = (value) => (Array.isArray(value) ? value : String(value ?? "").split(/[\r\n,]+/));

function listOf(value, max, maxLen, label) {
  const items = asList(value).map(clean).filter(Boolean);
  if (items.length > max) bad(`Too many ${label} (max ${max}).`);
  for (const item of items) if (item.length > maxLen) bad(`A ${label.replace(/s$/, "")} is too long (max ${maxLen} characters).`);
  return items;
}

function stepsText(steps) {
  if (!Array.isArray(steps)) return "";
  const out = [];
  for (const step of steps) {
    const title = capped(noBar(step?.title), LIMITS.stepTitle, "A step title");
    const body = capped(oneLine(step?.text), LIMITS.stepText, "A step description");
    if (title && body) out.push(`${title} | ${body}`);
    else if (title || body) out.push(title || body);
  }
  if (out.length > LIMITS.steps) bad(`Too many steps (max ${LIMITS.steps}).`);
  return out.join("\n");
}

function tableText(table) {
  const cols = Array.isArray(table?.cols) ? table.cols : [];
  if (!cols.length) return "";
  if (cols.length > LIMITS.cols) bad(`Too many table columns (max ${LIMITS.cols}).`);
  const cell = (value) => capped(noBar(value), LIMITS.cell, "A table cell");
  const rows = (Array.isArray(table.rows) ? table.rows : [])
    .map((row) => cols.map((_, i) => cell(Array.isArray(row) ? row[i] : "")))
    .filter((row) => row.some(Boolean));
  if (!rows.length) return "";
  if (rows.length > LIMITS.rows) bad(`Too many table rows (max ${LIMITS.rows}).`);
  const heads = cols.map((col, i) => cell(col) || `Column ${i + 1}`);
  return [heads, ...rows].map((row) => row.join(" | ")).join("\n");
}

function scenariosText(scenarios) {
  if (!Array.isArray(scenarios)) return "";
  const out = [];
  for (const scenario of scenarios) {
    const part = (value, label) => capped(noBar(value), LIMITS.scenario, label);
    const title = part(scenario?.title, "A scenario title");
    const body = part(scenario?.text, "A scenario situation");
    const result = part(scenario?.result, "A scenario result");
    if (title || body) out.push(`${scenario?.ok === false ? "not ok" : "ok"} | ${title} | ${body} | ${result}`);
  }
  if (out.length > LIMITS.scenarios) bad(`Too many scenarios (max ${LIMITS.scenarios}).`);
  return out.join("\n");
}

const repliesText = (value) => listOf(typeof value === "string" ? value.split(/\r?\n/) : value, LIMITS.sentences, LIMITS.sentence, "reply sentences").join("\n");

// Turns the admin form's structured guide into the Lark cell text that recordToGuide reads back.
export function guideToFields(input, { brands } = {}) {
  if (!input || typeof input !== "object") bad("The guide is missing.");
  const title = capped(oneLine(input.title), LIMITS.title, "The title");
  const category = capped(oneLine(input.category), LIMITS.category, "The category");
  if (!title) bad("Give the guide a title.");
  if (!category) bad("Choose or type a category.");
  const brand = capped(oneLine(input.brand), LIMITS.brand, "The brand");
  if (brand && Array.isArray(brands) && brands.length && !brands.includes(brand)) bad(`"${brand}" is not one of the brands in Lark (${brands.join(", ")}).`);
  const replies = input.replies || {};
  const fields = {
    [KNOWLEDGE_FIELDS.title]: title,
    [KNOWLEDGE_FIELDS.category]: category,
    [KNOWLEDGE_FIELDS.keywords]: listOf(input.keywords, LIMITS.keywords, LIMITS.keyword, "keywords").join("\n"),
    [KNOWLEDGE_FIELDS.summary]: capped(input.summary, LIMITS.summary, "The summary"),
    [KNOWLEDGE_FIELDS.steps]: stepsText(input.steps),
    [KNOWLEDGE_FIELDS.referenceTable]: tableText(input.table),
    [KNOWLEDGE_FIELDS.bonusAmounts]: "",
    [KNOWLEDGE_FIELDS.scenarios]: scenariosText(input.scenarios),
    [KNOWLEDGE_FIELDS.warning]: capped(input.warning, LIMITS.block, "The important note"),
    [KNOWLEDGE_FIELDS.note]: capped(input.note, LIMITS.block, "The note"),
    [KNOWLEDGE_FIELDS.replyEn]: repliesText(replies.en),
    [KNOWLEDGE_FIELDS.replyMs]: repliesText(replies.ms),
    [KNOWLEDGE_FIELDS.replyZh]: repliesText(replies.zh),
    [KNOWLEDGE_FIELDS.status]: input.status === "Draft" ? "Draft" : "Live",
  };
  if (brand) fields[KNOWLEDGE_FIELDS.brand] = brand;
  return fields;
}

export async function knowledgeFieldOptions() {
  if (!TABLE_LEARNING_GROUP) return null;
  try {
    const fields = await listFields(TABLE_LEARNING_GROUP);
    const names = (field) => (fields.find((item) => item.field_name === field)?.property?.options || []).map((option) => option.name);
    return { categories: names(KNOWLEDGE_FIELDS.category), brands: names(KNOWLEDGE_FIELDS.brand) };
  } catch (_) {
    return null;
  }
}

// A single-select cell only takes an option that exists, so a new category is added to the field first.
export async function ensureCategoryOption(category) {
  const fields = await listFields(TABLE_LEARNING_GROUP, undefined, { force: true });
  const field = fields.find((item) => item.field_name === KNOWLEDGE_FIELDS.category);
  if (!field) bad("The Learning Group table has no Category field.");
  const options = field.property?.options || [];
  if (options.some((option) => option.name === category)) return false;
  const token = await getTenantToken();
  const res = await fetch(`https://open.larksuite.com/open-apis/bitable/v1/apps/${larkBaseToken()}/tables/${TABLE_LEARNING_GROUP}/fields/${field.field_id}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      field_name: field.field_name,
      type: field.type,
      property: { options: [...options.map(({ id, name, color }) => ({ id, name, color })), { name: category }] },
    }),
  });
  const data = await res.json();
  if (data.code !== 0) bad(`Lark would not add the category "${category}" (${data.msg}). Add it as an option on the Category field in Lark, then save again.`);
  await listFields(TABLE_LEARNING_GROUP, undefined, { force: true }).catch(() => {});
  return true;
}

export async function uploadPicture(file) {
  const token = await getTenantToken();
  const name = clean(file.name) || "guide-picture";
  const form = new FormData();
  form.append("file_name", name);
  form.append("parent_type", "bitable_image");
  form.append("parent_node", larkBaseToken());
  form.append("size", String(file.size));
  form.append("file", file, name);
  const res = await fetch("https://open.larksuite.com/open-apis/drive/v1/medias/upload_all", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Picture upload failed: ${data.msg}`);
  return data.data.file_token;
}
