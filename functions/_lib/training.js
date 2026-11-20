// Training player: username "edwintest" on brand LPK. A lookup shows every bonus with sample values, and every
// action works in the widget, but nothing is claimed and nothing is written to Lark, the console or the ticket system.
export const TRAINING_USERNAME = "edwintest";
export const TRAINING_BRAND = "LPK";
export const TRAINING_RECORD_PREFIX = "rectraining";

const norm = (value) => String(value ?? "").trim().toLowerCase();

export function isTrainingPlayer(username, brand) {
  return norm(username) === TRAINING_USERNAME && norm(brand) === norm(TRAINING_BRAND);
}

export function isTrainingRecord(recordId) {
  return norm(recordId).startsWith(TRAINING_RECORD_PREFIX);
}

// Any write that names the training username (any brand) or a training record id is never sent to Lark.
export function isTrainingWrite(body) {
  if (!body || typeof body !== "object") return false;
  return norm(body.username) === TRAINING_USERNAME || isTrainingRecord(body.recordId) || isTrainingRecord(body.deleteRecordId);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// The lookup answer for the training player: no Lark reads, no case row, never read-only.
export function trainingLookupBody(nowMs = Date.now()) {
  const today = new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10);
  return {
    ok: true,
    training: true,
    otherBrands: [],
    lookupWarnings: [],
    justCreated: true,
    readOnly: false,
    readOnlyReason: "",
    readOnlyCode: "",
    loginRequired: false,
    notVip: false,
    caRecordId: `${TRAINING_RECORD_PREFIX}case${nowMs.toString(36)}`,
    row: {
      tier: "Tier 3",
      customerName: "Edwin Training",
      pnlRecordId: `${TRAINING_RECORD_PREFIX}pnl`,
      claimsToday: [],
      claimsDay: today,
      pnlBirthday: `1990-${today.slice(5)}`,
      birthdayEnabled: true,
      birthdayGivenThisYear: false,
      topPnl: "Batch 09-09-2026 Pass RM58",
      ltvTest: "Pass RM18",
      gracePeriod: "Pass - Deposit 1000 - Bonus 108",
      graceExpiryMs: nowMs + 4 * DAY_MS,
      riskPlayer: "Eligible · 30%",
      riskExpiryMs: nowMs + 4 * DAY_MS,
      vipBooster: "Eligible",
      specialReload: { recordId: `${TRAINING_RECORD_PREFIX}reload`, status: "Eligible Angpao" },
      telegram28: { recordId: `${TRAINING_RECORD_PREFIX}telegram`, status: "Eligible — RM28" },
      redeemCode: { recordId: `${TRAINING_RECORD_PREFIX}redeem`, status: "SUNNY-88" },
      mooncake: "Eligible · RM28",
      vs96Feedback: "Eligible",
    },
  };
}
