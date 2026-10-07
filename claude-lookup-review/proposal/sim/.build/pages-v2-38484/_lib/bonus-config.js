import { listRecords, toDisplay, TABLE_BONUS_CONFIG } from "./lark.js";

export const BONUS_CONFIG_FIELDS = {
  key: "Key",
  label: "Label",
  active: "Active",
  sourceTableId: "Source Table ID",
  sourceBaseToken: "Source Base Token",
  usernameField: "Username Field",
  brandField: "Brand Field",
  dateField: "Date Field",
  displayField: "Display Field",
  rule: "Eligibility Rule",
  ruleValue: "Rule Value",
  selection: "Selection",
  inquiry: "Inquiry",
  amountEligible: "Amount Eligible",
};

export const BONUS_RULES = new Set(["any_text", "starts_with", "contains", "equals"]);

function clean(value) { return String(value || "").trim(); }

export function normalizeBonusConfig(input, { requireRecordId = false } = {}) {
  const config = {
    recordId: clean(input.recordId),
    key: clean(input.key).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""),
    label: clean(input.label),
    active: input.active !== false,
    sourceTableId: clean(input.sourceTableId),
    sourceBaseToken: clean(input.sourceBaseToken),
    usernameField: clean(input.usernameField) || "Username/UID",
    brandField: clean(input.brandField) || "Brand",
    dateField: clean(input.dateField) || "Time of Inspection",
    displayField: clean(input.displayField) || "Status",
    rule: BONUS_RULES.has(clean(input.rule)) ? clean(input.rule) : "any_text",
    ruleValue: clean(input.ruleValue),
    selection: clean(input.selection).toLowerCase() === "newest" ? "newest" : "oldest",
    inquiry: clean(input.inquiry),
    amountEligible: input.amountEligible === true,
  };
  if (requireRecordId && !config.recordId) throw new Error("recordId is required");
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(config.key)) throw new Error("Key must start with a letter and contain 2-40 letters, numbers, - or _");
  if (!config.label) throw new Error("Label is required");
  if (!config.sourceTableId) throw new Error("Source Table ID is required");
  if (!config.inquiry) throw new Error("Inquiry is required");
  if (config.rule !== "any_text" && !config.ruleValue) throw new Error("Rule Value is required for this eligibility rule");
  return config;
}

export function configFromRecord(record) {
  const fields = record.fields || {};
  return normalizeBonusConfig({
    recordId: record.record_id,
    key: toDisplay(fields[BONUS_CONFIG_FIELDS.key]),
    label: toDisplay(fields[BONUS_CONFIG_FIELDS.label]),
    active: fields[BONUS_CONFIG_FIELDS.active] === true,
    sourceTableId: toDisplay(fields[BONUS_CONFIG_FIELDS.sourceTableId]),
    sourceBaseToken: toDisplay(fields[BONUS_CONFIG_FIELDS.sourceBaseToken]),
    usernameField: toDisplay(fields[BONUS_CONFIG_FIELDS.usernameField]),
    brandField: toDisplay(fields[BONUS_CONFIG_FIELDS.brandField]),
    dateField: toDisplay(fields[BONUS_CONFIG_FIELDS.dateField]),
    displayField: toDisplay(fields[BONUS_CONFIG_FIELDS.displayField]),
    rule: toDisplay(fields[BONUS_CONFIG_FIELDS.rule]),
    ruleValue: toDisplay(fields[BONUS_CONFIG_FIELDS.ruleValue]),
    selection: toDisplay(fields[BONUS_CONFIG_FIELDS.selection]),
    inquiry: toDisplay(fields[BONUS_CONFIG_FIELDS.inquiry]),
    amountEligible: fields[BONUS_CONFIG_FIELDS.amountEligible] === true,
  });
}

export function configToFields(config) {
  return {
    [BONUS_CONFIG_FIELDS.key]: config.key,
    [BONUS_CONFIG_FIELDS.label]: config.label,
    [BONUS_CONFIG_FIELDS.active]: config.active,
    [BONUS_CONFIG_FIELDS.sourceTableId]: config.sourceTableId,
    [BONUS_CONFIG_FIELDS.sourceBaseToken]: config.sourceBaseToken || null,
    [BONUS_CONFIG_FIELDS.usernameField]: config.usernameField,
    [BONUS_CONFIG_FIELDS.brandField]: config.brandField,
    [BONUS_CONFIG_FIELDS.dateField]: config.dateField,
    [BONUS_CONFIG_FIELDS.displayField]: config.displayField,
    [BONUS_CONFIG_FIELDS.rule]: config.rule,
    [BONUS_CONFIG_FIELDS.ruleValue]: config.ruleValue || null,
    [BONUS_CONFIG_FIELDS.selection]: config.selection,
    [BONUS_CONFIG_FIELDS.inquiry]: config.inquiry,
    [BONUS_CONFIG_FIELDS.amountEligible]: config.amountEligible,
  };
}

const TERMINAL_STATUS = /\b(claimed|expired|failed|not\s+eligible|ineligible)\b/i;

export function isConfiguredBonusEligible(config, display) {
  const value = clean(display);
  if (!value || TERMINAL_STATUS.test(value)) return false;
  const expected = config.ruleValue.toLowerCase();
  const actual = value.toLowerCase();
  if (config.rule === "starts_with") return actual.startsWith(expected);
  if (config.rule === "contains") return actual.includes(expected);
  if (config.rule === "equals") return actual === expected;
  return true;
}

let cache = { expires: 0, configs: [] };

export function clearBonusConfigCache() { cache = { expires: 0, configs: [] }; }

export async function listBonusConfigs({ includeInactive = false, fresh = false } = {}) {
  if (!TABLE_BONUS_CONFIG) return [];
  if (!fresh && Date.now() < cache.expires) {
    return includeInactive ? cache.configs : cache.configs.filter((item) => item.active);
  }
  const configs = (await listRecords(TABLE_BONUS_CONFIG, 500))
    .map((record) => {
      try { return configFromRecord(record); } catch (_) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.label.localeCompare(b.label));
  cache = { expires: Date.now() + 60_000, configs };
  return includeInactive ? configs : configs.filter((item) => item.active);
}
