// Halloween "Trick or Treat" campaign rules. Pure functions only (no Lark calls), so the lookup,
// the claim endpoint and the tests all share one source of truth.
import { toDisplay } from "./lark.js";

export const F = {
  uid: "Username/UID",
  brand: "Brand",
  tier: "Tier",
  choice: "Choice",
  day1Deposit: "Day 1 Deposit",
  day1Bonus: "Day 1 Bonus",
  track: "Track",
  day1Claimed: "Day 1 Claimed",
  day2Base: "Day 2 Base",
  day2Share: "Day 2 Share",
  day2Claimed: "Day 2 Claimed",
  day3Base: "Day 3 Base",
  day3Share: "Day 3 Share",
  day3Claimed: "Day 3 Claimed",
  shareMethod: "Share Method",
  postLink: "Post Link",
  agent: "Agent",
  chatLink: "Chat Link",
};

export const TRACK_LOW = "Below RM300";
export const TRACK_HIGH = "RM300+";
export const METHOD_POST = "Social post";
export const METHOD_FRIENDS = "5 friends";
export const INQUIRY_PREFIX = "Halloween Day ";

// Brand as stored in the Brand dropdown (digits stripped) -> full name used on tickets and the day it opens.
export const CAMPAIGN = {
  EZ: { full: "EZ96", start: "2026-10-26" },
  NOW: { full: "NOW32", start: "2026-10-26" },
  JUS: { full: "JUS22", start: "2026-10-26" },
  FUN: { full: "FUN36", start: "2026-10-27" },
  BIG: { full: "BIG321", start: "2026-10-27" },
  YES: { full: "YES82", start: "2026-10-27" },
  ZAS: { full: "ZAS36", start: "2026-10-28" },
  RUSH: { full: "RUSH33", start: "2026-10-28" },
  MAX: { full: "MAX39", start: "2026-10-28" },
  AC: { full: "AC69", start: "2026-10-29" },
  ONG: { full: "ONG66", start: "2026-10-29" },
  VS: { full: "VS96", start: "2026-10-29" },
  OG: { full: "OG321", start: "2026-10-30" },
  SK: { full: "SK69", start: "2026-10-30" },
  HOT: { full: "HOT321", start: "2026-10-30" },
  RM: { full: "RM68", start: "2026-10-31" },
  BM: { full: "BM69", start: "2026-10-31" },
  SA: { full: "SA969", start: "2026-10-31" },
  JK: { full: "JK32", start: "2026-10-31" },
};

// Highest row reached wins (RM200 pays the RM100 row). Amounts are [TRICK, TREAT].
export const DAY1_TABLE = [
  { min: 500, trick: 200, treat: 150 },
  { min: 300, trick: 120, treat: 90 },
  { min: 100, trick: 40, treat: 30 },
  { min: 50, trick: 18, treat: 15 },
];
export const RED_PACKET = { "Tier 3": 18, "Tier V": 28 };
export const SHARE_EXTRA = 28;
export const LOW_TRACK_BELOW = 300;
export const WINDOW_DAYS = 3;

export function brandKey(brand) {
  return String(brand || "").toUpperCase().replace(/\d+/g, "").replace(/\s+/g, "").trim();
}

export function normalizeTier(text) {
  const t = String(text || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const match = /^(?:tier |t)?(3|v)$/.exec(t);
  if (!match) return "";
  return match[1] === "3" ? "Tier 3" : "Tier V";
}

// "Today" in Malaysia time (UTC+8). `override` (YYYY-MM-DD) is only for testing on a preview deployment.
export function malaysiaToday(nowMs = Date.now(), override = "") {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(override || "").trim())) return String(override).trim();
  return new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10);
}

// 1, 2 or 3 inside the brand's window; 0 when the brand is not in the campaign or the window is closed.
export function dayNumber(brand, today) {
  const campaign = CAMPAIGN[brandKey(brand)];
  if (!campaign) return 0;
  const diff = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${campaign.start}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(diff) || diff < 0 || diff >= WINDOW_DAYS) return 0;
  return diff + 1;
}

export const MAX_DEPOSIT = 1_000_000;
const asText = (value) => (typeof value === "string" || typeof value === "number" ? String(value) : "");

export function day1Bonus(deposit, choice) {
  const amount = Number(asText(deposit).replace(/,/g, "").trim() || NaN);
  const pick = typeof choice === "string" ? choice.trim().toUpperCase() : "";
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_DEPOSIT || (pick !== "TRICK" && pick !== "TREAT")) return null;
  const row = DAY1_TABLE.find((item) => amount >= item.min);
  if (!row) return null;
  return {
    deposit: amount,
    choice: pick,
    rowMin: row.min,
    amount: pick === "TRICK" ? row.trick : row.treat,
    track: amount >= LOW_TRACK_BELOW ? TRACK_HIGH : TRACK_LOW,
  };
}

const hasValue = (value) => value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && !value.length);
const asNumber = (value) => {
  const n = Number(String(toDisplay(value)).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

// Read one Halloween row (Lark fields) into plain values. `maps` resolves option ids to names if Lark returns ids.
export function readProgress(fields = {}, maps = {}) {
  const text = (name) => toDisplay(fields[name], maps[name]).trim();
  return {
    choice: text(F.choice).toUpperCase(),
    track: text(F.track),
    tier: text(F.tier),
    day1Deposit: asNumber(fields[F.day1Deposit]),
    day1Bonus: asNumber(fields[F.day1Bonus]),
    day2Claimed: hasValue(fields[F.day2Claimed]),
    day2Base: asNumber(fields[F.day2Base]),
    day2Share: asNumber(fields[F.day2Share]),
    day3Claimed: hasValue(fields[F.day3Claimed]),
    day3Base: asNumber(fields[F.day3Base]),
    day3Share: asNumber(fields[F.day3Share]),
    shareMethod: text(F.shareMethod),
    postLink: text(F.postLink),
  };
}

const rowStatusShape = (progress) => ({
  choice: progress.choice,
  track: progress.track,
  day1Deposit: progress.day1Deposit,
  day1Bonus: progress.day1Bonus,
  day2Total: progress.day2Claimed ? progress.day2Base + progress.day2Share : 0,
  day2Shared: progress.day2Share > 0,
  shareMethod: progress.shareMethod,
  postLink: progress.postLink,
});

// What the widget card should show right now. Returns null when nothing should be shown (not our brand / window closed).
export function halloweenStatus({ brand, tierText, row, today, maps }) {
  const day = dayNumber(brand, today);
  if (!day) return null;
  const key = brandKey(brand);
  const base = {
    day,
    brand: key,
    fullBrand: CAMPAIGN[key].full,
    tier: normalizeTier(tierText),
    tierRaw: String(tierText || "").trim(),
    shareExtra: SHARE_EXTRA,
  };
  if (!base.tier) {
    return { ...base, state: "closed", message: `Halloween is for Tier 3 and Tier V players only. This player's tier: ${base.tierRaw || "not found"}.` };
  }
  const redPacket = RED_PACKET[base.tier];
  const progress = row ? readProgress(row.fields, maps) : null;
  const common = { ...base, redPacket, recordId: row?.record_id || row?.recordId || "", ...(progress ? rowStatusShape(progress) : {}) };

  if (day === 1) {
    if (progress) return { ...common, state: "done", message: `Day 1 already claimed: ${progress.choice} · RM${progress.day1Bonus}.` };
    return { ...common, state: "day1", table: DAY1_TABLE };
  }
  if (!progress) return { ...common, state: "closed", message: `Day ${day} is closed for this player: Day 1 was not claimed.` };
  if (progress.track !== TRACK_HIGH) return { ...common, state: "closed", message: `No Day ${day} reward: the Day 1 deposit was below RM${LOW_TRACK_BELOW}.` };
  if (day === 2) {
    if (progress.day2Claimed) return { ...common, state: "done", message: `Day 2 already claimed: RM${progress.day2Base + progress.day2Share}.` };
    return { ...common, state: "day2" };
  }
  if (!progress.day2Claimed) return { ...common, state: "closed", message: "Day 3 is closed for this player: Day 2 was not claimed." };
  if (progress.day3Claimed) return { ...common, state: "done", message: `Day 3 already claimed: RM${progress.day3Base + progress.day3Share}.` };
  return { ...common, state: "day3", canShare: progress.day2Share > 0 };
}

const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);
// A web address the agent pasted: http(s) or a bare domain; never another scheme (javascript:, data:), spaces or markup.
export const isPostLink = (link) => !/[\s<>"'`]/.test(link) && (/^https?:\/\//i.test(link) || !/^[a-z][a-z0-9+.-]*:/i.test(link));

// Decide whether a claim is allowed and which fields to write. Never trusts amounts from the browser.
export function planClaim({ brand, tierText, row, today, nowMs, input = {}, agent = "", chatLink = "", maps }) {
  const fail = (error) => ({ ok: false, error });
  const key = brandKey(brand);
  if (!CAMPAIGN[key]) return fail(`${brand || "This brand"} is not part of the Halloween promotion.`);
  const day = dayNumber(brand, today);
  if (!day) return fail(`The Halloween window for ${key} is not open today.`);
  if (input.day != null && Number(input.day) !== day) return fail(`It is Day ${day} now, not Day ${input.day}. Look up the player again.`);
  const tier = normalizeTier(tierText);
  if (!tier) return fail("Halloween is for Tier 3 and Tier V players only.");
  const progress = row ? readProgress(row.fields, maps) : null;
  const who = { [F.agent]: clean(agent, 120), [F.chatLink]: clean(chatLink, 500) };

  if (day === 1) {
    if (progress) return fail("This player already claimed Day 1. TRICK or TREAT can only be chosen once.");
    const bonus = day1Bonus(input.deposit, input.choice);
    if (!bonus) return fail("Pick TRICK or TREAT and enter a Day 1 deposit of RM50 or more.");
    return {
      ok: true, kind: "create", day, amount: bonus.amount, track: bonus.track, choice: bonus.choice, deposit: bonus.deposit, tier, shared: false,
      fields: {
        [F.tier]: tier, [F.choice]: bonus.choice, [F.day1Deposit]: bonus.deposit, [F.day1Bonus]: bonus.amount,
        [F.track]: bonus.track, [F.day1Claimed]: nowMs, ...who,
      },
    };
  }

  if (!progress) return fail("Day 1 was not claimed, so Day 2 and Day 3 are not available.");
  if (progress.track !== TRACK_HIGH) return fail(`The Day 1 deposit was below RM${LOW_TRACK_BELOW}, so there is no Day ${day} reward.`);
  const redPacket = RED_PACKET[tier];
  const shared = input.shared === true;

  if (day === 2) {
    if (progress.day2Claimed) return fail("Day 2 was already claimed for this player.");
    const fields = { [F.day2Base]: redPacket, [F.day2Claimed]: nowMs, ...who };
    if (shared) {
      const method = clean(input.shareMethod, 40);
      if (method !== METHOD_POST && method !== METHOD_FRIENDS) return fail("Choose how the player shared: social post or 5 friends.");
      const link = clean(input.postLink);
      if (method === METHOD_POST && !link) return fail("Enter the link of the player's post.");
      if (method === METHOD_POST && !isPostLink(link)) return fail("The post link must be a web address with no spaces (https://…).");
      fields[F.day2Share] = SHARE_EXTRA;
      fields[F.shareMethod] = method;
      if (method === METHOD_POST) fields[F.postLink] = link;
    }
    return { ok: true, kind: "update", day, amount: redPacket + (shared ? SHARE_EXTRA : 0), base: redPacket, shared, tier, fields };
  }

  if (!progress.day2Claimed) return fail("Day 2 was not claimed, so Day 3 is not available.");
  if (progress.day3Claimed) return fail("Day 3 was already claimed for this player.");
  if (shared && !(progress.day2Share > 0)) return fail("The player did not share on Day 2, so there is no share extra on Day 3.");
  const fields = { [F.day3Base]: redPacket, [F.day3Claimed]: nowMs, ...who };
  if (shared) fields[F.day3Share] = SHARE_EXTRA;
  return { ok: true, kind: "update", day, amount: redPacket + (shared ? SHARE_EXTRA : 0), base: redPacket, shared, tier, fields };
}

// Fields to blank when a day's claim is undone. Day 1 removes the whole row (see the endpoint).
export function planUnclaim({ day, row, maps }) {
  const progress = row ? readProgress(row.fields, maps) : null;
  // Already undone (for example a retry after a half-finished unclaim): nothing to do, not an error.
  if (!progress) return { ok: true, kind: "none" };
  if (day === 1) {
    if (progress.day2Claimed) return { ok: false, error: "Day 2 was already claimed. Undo Day 2 first." };
    return { ok: true, kind: "delete" };
  }
  if (day === 2) {
    if (!progress.day2Claimed) return { ok: true, kind: "none" };
    if (progress.day3Claimed) return { ok: false, error: "Day 3 was already claimed. Undo Day 3 first." };
    return { ok: true, kind: "clear", clear: [F.day2Base, F.day2Share, F.day2Claimed, F.shareMethod, F.postLink] };
  }
  if (day === 3) {
    if (!progress.day3Claimed) return { ok: true, kind: "none" };
    return { ok: true, kind: "clear", clear: [F.day3Base, F.day3Share, F.day3Claimed] };
  }
  return { ok: false, error: "Unknown day." };
}

// Expected shape of the Lark table: name -> allowed Lark field types (1 text, 2 number, 3 single select, 5 date, 15 URL).
const SELECT_OR_TEXT = [3, 1];
export const EXPECTED_FIELDS = {
  [F.uid]: [1],
  [F.brand]: SELECT_OR_TEXT,
  [F.tier]: SELECT_OR_TEXT,
  [F.choice]: SELECT_OR_TEXT,
  [F.day1Deposit]: [2],
  [F.day1Bonus]: [2],
  [F.track]: SELECT_OR_TEXT,
  [F.day1Claimed]: [5],
  [F.day2Base]: [2],
  [F.day2Share]: [2],
  [F.day2Claimed]: [5],
  [F.day3Base]: [2],
  [F.day3Share]: [2],
  [F.day3Claimed]: [5],
  [F.shareMethod]: SELECT_OR_TEXT,
  [F.postLink]: [1, 15],
  [F.agent]: SELECT_OR_TEXT,
  [F.chatLink]: [1, 15],
};
const EXPECTED_OPTIONS = {
  [F.tier]: ["Tier 3", "Tier V"],
  [F.choice]: ["TRICK", "TREAT"],
  [F.track]: [TRACK_LOW, TRACK_HIGH],
  [F.shareMethod]: [METHOD_POST, METHOD_FRIENDS],
  [F.brand]: Object.keys(CAMPAIGN),
};

// Compare the table's real fields with what the code writes. `catalog` is the Lark field list.
export function checkFields(catalog = []) {
  const byName = new Map(catalog.map((field) => [field.field_name, field]));
  const missing = [];
  const wrongType = [];
  const missingOptions = [];
  for (const [name, types] of Object.entries(EXPECTED_FIELDS)) {
    const field = byName.get(name);
    if (!field) { missing.push(name); continue; }
    if (!types.includes(field.type)) wrongType.push({ field: name, found: field.type, expected: types });
    if (field.type === 3 && EXPECTED_OPTIONS[name]) {
      const have = new Set((field.property?.options || []).map((option) => option.name));
      for (const option of EXPECTED_OPTIONS[name]) if (!have.has(option)) missingOptions.push({ field: name, option });
    }
  }
  return { ok: !missing.length && !wrongType.length && !missingOptions.length, missing, wrongType, missingOptions };
}

// Turn plain values into what Lark expects for each field type (URL fields need {link,text}).
export function shapeFields(values, catalog = []) {
  const byName = new Map(catalog.map((field) => [field.field_name, field]));
  const out = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    const field = byName.get(name);
    if (!field) throw new Error(`The Halloween table has no field called "${name}".`);
    if (field.type === 15) out[name] = { link: String(value), text: String(value) };
    else if (field.type === 2 || field.type === 5) out[name] = Number(value);
    else out[name] = String(value);
  }
  return out;
}
