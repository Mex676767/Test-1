// Birthday Bonus: rules shared by the lookup and the /birthday-bonus endpoint.
import { toDisplay } from "./lark.js";

// Field names in the Birthday Bonus table.
export const BF = {
  username: "Username/UID",
  brand: "Brand",
  dob: "DOB",
  inspected: "Time of Inspection",
  amount: "SW - Bonus Amount",
  bonusType: "Bonus Type",
  remark: "Remark",
  screenshot: "Screenshot",
};
// Inquiry written to Customer Approaching when a birthday bonus is claimed.
export const BIRTHDAY_INQUIRY = "Birthday";
// Above this amount the agent must check with an ATL first and give their name.
export const BIRTHDAY_ATL_LIMIT = 300;

const MY_OFFSET_MS = 8 * 3600_000;

// A Lark date (epoch ms) as the Malaysia calendar date "YYYY-MM-DD", or "".
export function malaysiaDateOf(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n === 0) return "";
  return new Date(n + MY_OFFSET_MS).toISOString().slice(0, 10);
}

export function epochOf(value) {
  if (typeof value === "number") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const n = epochOf(item);
      if (n !== null) return n;
    }
    return null;
  }
  if (value && typeof value === "object" && "value" in value) return epochOf(value.value);
  const n = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(n) ? n : null;
}

// "YYYY-MM-DD" -> epoch ms at UTC midnight (how the widget already writes Player D.O.B).
export function dateInputToEpoch(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(text || ""))) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

// The amount from SW - Bonus Amount (number, formula or text), rounded to cents; 0 when empty.
export function bonusAmountOf(value) {
  const text = toDisplay(value).replace(/,/g, "");
  const match = text.match(/-?\d+(?:\.\d+)?/);
  const n = match ? Number(match[0]) : 0;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

// The Malaysia year a Birthday Bonus row belongs to: its Time of Inspection, or when it was created.
export function rowYear(row) {
  const ms = epochOf(row?.fields?.[BF.inspected]) ?? epochOf(row?.created_time);
  return ms ? malaysiaDateOf(ms).slice(0, 4) : "";
}

// Was a birthday bonus already given this year? Read from the player's Customer Approaching rows
// (same brand, Status "Given", Inquiry "Birthday", created this Malaysia year, or in the last 3 days so a 31 Dec
// birthday claimed on 31 Dec cannot be claimed again on 1 Jan inside the same 3-day window).
export const BIRTHDAY_WINDOW_MS = 3 * 86_400_000;
export function birthdayGivenThisYearFrom(rows, brand, year, nowMs = Date.now()) {
  const wanted = String(brand || "").trim().toUpperCase();
  return (rows || []).some((r) => toDisplay(r.fields?.[BF.brand]).trim().toUpperCase() === wanted
    && /^given$/i.test(toDisplay(r.fields?.Status).trim())
    && [].concat(r.fields?.Inquiry ?? []).map((v) => toDisplay(v)).includes(BIRTHDAY_INQUIRY)
    && (malaysiaDateOf(r.created_time).slice(0, 4) === String(year) || nowMs - Number(r.created_time) < BIRTHDAY_WINDOW_MS));
}

// The fields for a new Birthday Bonus row; only fields the table has and can take are written.
export function newRowFields({ username, brand, dob, fileToken, nowMs }, catalog = []) {
  const byName = new Map(catalog.map((field) => [field.field_name, field]));
  for (const name of [BF.username, BF.brand]) {
    if (!byName.has(name)) throw new Error(`The Birthday Bonus table has no field called "${name}".`);
  }
  const fields = { [BF.username]: username, [BF.brand]: brand };
  const dobMs = dateInputToEpoch(dob);
  if (dobMs !== null && byName.get(BF.dob)?.type === 5) fields[BF.dob] = dobMs;
  if (byName.get(BF.inspected)?.type === 5) fields[BF.inspected] = nowMs;
  if (fileToken) {
    if (byName.get(BF.screenshot)?.type !== 17) throw new Error(`The Birthday Bonus table needs an attachment field called "${BF.screenshot}".`);
    fields[BF.screenshot] = [{ file_token: fileToken }];
  }
  return fields;
}
