import { adapt } from "./_lib/adapt.js";
import {
  searchRecords, createRecord, deleteRecord, toDisplay, getFieldOptionMap, findOldestClaimableRow, runWithRequestStart, noteCounter,
  TABLE_CUSTOMER_APPROACHING, TABLE_REDEEM_CODE, TABLE_PNL,
  TABLE_GRACE_PERIOD, TABLE_TOP_PNL_NIGHT, TABLE_LTV_DAY, TABLE_RISK_PLAYER,
  TABLE_SPECIAL_RELOAD, TABLE_VIP_BOOSTER,
  TABLE_TELEGRAM28, TABLE_MOONCAKE, TABLE_VS96_FEEDBACK, TABLE_HALLOWEEN,
} from "./_lib/lark.js";
import { readOwnership, ownedBy, summarizeRow, parseChatLink } from "./_lib/ca-row.js";
import { isConfiguredBonusEligible, listBonusConfigs } from "./_lib/bonus-config.js";
import { halloweenStatus, malaysiaToday, dayNumber, brandKey, testDateFor } from "./_lib/halloween.js";
import { readHalloweenRow, readOptionMaps } from "./_lib/halloween-io.js";

const FIRST_PASS_TIMEOUT_MS = 22_000;
const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 14_000;
const LOOKUP_BUDGET_MS = 36_000;
const CASE_SEARCH_TIMEOUT_MS = 20_000;

const F = {
  username: "Username",
  usernameUid: "Username/UID",
  brand: "Brand",
  agentName: "Agent Name",
  tier: "Tier",
  titleName: "Tittle name",
  status: "Status",
  swCheck: "SW Check",
  swChecker: "SW Checker",
  claimedCopy: "Claimed Copy",
  bonusAmount: "Bonus Amount",
  graceExpiry: "Expried",
  riskExpiry: "Date Expired",
  uid: "UID",
};

function isLinkFieldRejection(error) {
  if (error?.rateLimited) return false;
  const message = String(error?.message || "");
  if (!/^Lark create failed/i.test(message)) return false;
  if (/timed? ?out|rate.?limit|too ?many|could not be matched|internal|temporar|busy|server error/i.test(message)) return false;
  return Number(error?.code) === 1254068
    || /FieldConvFail/i.test(String(error?.larkMsg || "") + " " + message)
    || /\blink\b/i.test(message);
}

async function reusableBlankCase(agent, username, brand, link, timeoutMs = CASE_SEARCH_TIMEOUT_MS, defer = (promise) => { promise.catch(() => {}); }) {
  const exactLink = String(link || "").trim().replace(/\/$/, "");
  if (!parseChatLink(exactLink).threadId) return null;
  const rows = await searchRecords(TABLE_CUSTOMER_APPROACHING, [
    { field_name: F.agentName, operator: "is", value: [agent] },
    { field_name: F.username, operator: "is", value: [username] },
    { field_name: F.brand, operator: "is", value: [brand] },
    { field_name: "Inquiry", operator: "isEmpty", value: [] },
    { field_name: "Status", operator: "isEmpty", value: [] },
  ], undefined, {
    pageSize: 100, automaticFields: true, timeoutMs,
    fieldNames: [F.agentName, F.username, F.brand, "Inquiry", "Status", "link"],
  });
  const matches = rows.map(summarizeRow)
    .filter((row) => row.agent === agent && row.username === username && row.brand === brand
      && String(row.link || "").trim().replace(/\/$/, "") === exactLink
      && !row.inquiry.length && !row.status)
    .sort((a, b) => (a.createdAt - b.createdAt) || a.recordId.localeCompare(b.recordId));
  if (!matches.length) return null;
  if (matches.length > 1) {
    defer(Promise.allSettled(matches.slice(1).map(async (row) => {
      const { owner, blank } = await readOwnership(row.recordId);
      if (blank && ownedBy(owner, agent)) await deleteRecord(TABLE_CUSTOMER_APPROACHING, row.recordId);
    })));
  }
  return matches[0].recordId;
}

// Lark refuses new rows when the table has reached its record limit (code text RecordExceedLimit).
export const isTableFull = (error) => /RecordExceedLimit|exceed.{0,20}limit|record.{0,15}limit/i.test(`${error?.larkMsg || ""} ${error?.message || ""}`);
export const TABLE_FULL_MESSAGE = "The Customer Approaching table is full, so this chat cannot be recorded. Tell your admin to start a new table. (The lookup results below are still valid.)";

function hidden(v) {
  const t = String(v || "").trim().toLowerCase();
  return /\b(claimed|expired|failed|not\s+eligible|ineligible)\b/.test(t);
}

function toEpochMs(v) {
  if (typeof v === "number") return v;
  if (Array.isArray(v)) {
    for (const item of v) {
      const n = toEpochMs(item);
      if (n !== null) return n;
    }
    return null;
  }
  if (v && typeof v === "object") {
    if ("value" in v) return toEpochMs(v.value);
    if ("text" in v) {
      const n = Number(v.text);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

const HARD_DEADLINE_MS = 40_000;

export function handler(event) { return runWithRequestStart(() => lookupWithDeadline(event)); }

async function lookupWithDeadline(event) {
  const hardMs = Number(event.env?.LOOKUP_HARD_DEADLINE_MS) || HARD_DEADLINE_MS;
  let timer;
  const hardStop = new Promise((resolve) => {
    timer = setTimeout(() => { noteCounter("lookupHardDeadline"); resolve({
      statusCode: 504,
      body: JSON.stringify({ ok: false, error: "The lookup took too long. Press Look Up again.", hardDeadline: true }),
    }); }, hardMs);
  });
  try { return await Promise.race([lookupHandler(event, Date.now() + hardMs), hardStop]); }
  finally { clearTimeout(timer); }
}

async function lookupHandler(event, hardEnd) {
  try {
    const { username, brand, picName, previousRecordId, link, preview } = JSON.parse(event.body || "{}");
    if (!username || !brand) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "username and brand are required" }) };
    }
    const uname = username.trim().toLowerCase();
    const brandVal = brand.trim();
    const agentVal = (picName || "").trim();
    const lookupWarnings = [];
    const startedAt = Date.now();
    const firstPassMs = Number(event.env?.LOOKUP_FIRST_PASS_MS) || FIRST_PASS_TIMEOUT_MS;
    const lookupBudgetMs = Number(event.env?.LOOKUP_BUDGET_MS) || LOOKUP_BUDGET_MS;
    const retryMinMs = Number(event.env?.LOOKUP_RETRY_MIN_MS) || RETRY_MIN_MS;
    const budget = { searchMs: firstPassMs };
    const defer = (promise) => {
      const safe = Promise.resolve(promise).catch((error) => console.warn("Deferred cleanup failed", String(error?.message || error).slice(0, 160)));
      if (typeof event.waitUntil === "function") event.waitUntil(safe);
    };
    const search = (table, conditions, base, opts = {}) => searchRecords(table, conditions, base, { ...opts, timeoutMs: budget.searchMs });
    const findRow = (table, name, brandName, isClaimable, base, opts = {}) =>
      findOldestClaimableRow(table, name, brandName, isClaimable, base, { ...opts, timeoutMs: budget.searchMs });
    const guard = (promise, ms, label) => {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`${label} did not answer within ${Math.round(ms / 1000)} seconds.`), { retryable: true })), ms);
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    };
    const optionalLookup = (label, read, fallback = null) => Promise.resolve()
      .then(() => guard(read(), firstPassMs + 2_000, label))
      .then(
        (value) => ({ label, read, fallback, value, error: null }),
        (error) => ({ label, read, fallback, value: fallback, error }),
      );
    const resolveLookup = async (task) => {
      if (!task.error) return task.value;
      let error = task.error;
      if (error.retryable !== false) {
        try {
          return await guard(task.read(), budget.searchMs + 1_000, task.label);
        } catch (retryError) {
          error = retryError;
        }
      }
      console.warn("Lark lookup source unavailable", task.label, String(error?.message || error).slice(0, 180));
      lookupWarnings.push(task.label);
      return task.fallback;
    };
    const resolveLookups = async (tasks) => {
      return Promise.all(tasks.map(async (task) => {
        if (!task.error) return task.value;
        if (task.error.retryable !== false) {
          try {
            return await guard(task.read(), budget.searchMs + 1_000, task.label);
          } catch (error) {
            console.warn("Lark lookup source unavailable", task.label, String(error?.message || error).slice(0, 180));
          }
        }
        if (task.error.retryable === false) {
          console.warn("Lark lookup source unavailable", task.label, String(task.error.message || task.error).slice(0, 180));
        }
        lookupWarnings.push(task.label);
        return task.fallback;
      }));
    };

    const configuredBonusConfigsP = optionalLookup(
      "Custom bonuses",
      () => listBonusConfigs({ fresh: !!preview }),
      [],
    );
    const configuredBonusLookupsP = configuredBonusConfigsP.then(async (task) => {
      const configs = await resolveLookup(task);
      const lookups = await Promise.all(configs.map((config) => optionalLookup(
        `Custom bonus ${config.key}`,
        () => findRow(
          config.sourceTableId,
          uname,
          brandVal,
          (fields) => isConfiguredBonusEligible(config, toDisplay(fields[config.displayField])),
          config.sourceBaseToken || undefined,
          {
            usernameField: config.usernameField,
            brandField: config.brandField,
            dateField: config.dateField,
            newest: config.selection === "newest",
            fieldNames: [config.displayField, config.dateField || "Time of Inspection"],
          }
        ).then((row) => row ? toDisplay(row.fields[config.displayField]) : ""),
        "",
      )));
      return { configs, lookups };
    });

    const chatLink = String(link || "").trim();
    const caseMinMs = Number(event.env?.LOOKUP_CASE_MIN_MS) || 2_000;
    const caseGraceMs = Number(event.env?.LOOKUP_CASE_GRACE_MS) || 6_000;
    const caseBudgetMs = () => Math.max(caseMinMs, Math.min(CASE_SEARCH_TIMEOUT_MS, startedAt + lookupBudgetMs - Date.now()));
    const caseRecordP = (async () => {
      let recordId = null;
      if (!preview && chatLink) {
        for (let attempt = 0; ; attempt++) {
          try { recordId = await reusableBlankCase(agentVal, uname, brandVal, chatLink, caseBudgetMs(), defer); break; }
          catch (error) {
            if (attempt >= 1 || (error.retryable === false && !error.rateLimited)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 400 + Math.floor(Math.random() * 300)));
          }
        }
      }

      if (!preview && previousRecordId && previousRecordId !== recordId) {
        try {
          const { owner, blank } = await readOwnership(previousRecordId);
          if (blank && ownedBy(owner, agentVal)) {
            await deleteRecord(TABLE_CUSTOMER_APPROACHING, previousRecordId);
          }
        } catch (_) { }
      }

      let created = false;
      if (!preview && !recordId) {
        if (startedAt + lookupBudgetMs - Date.now() < caseMinMs) {
          throw Object.assign(new Error("Case row skipped: the lookup time budget was already used up."), { retryable: true });
        }
        const baseFields = { [F.username]: uname, [F.brand]: brandVal, [F.agentName]: agentVal };
        let result;
        if (chatLink) {
          try {
            result = await createRecord(TABLE_CUSTOMER_APPROACHING, { ...baseFields, link: { link: chatLink, text: chatLink } });
          } catch (error) {
            if (!isLinkFieldRejection(error)) throw error;
            result = await createRecord(TABLE_CUSTOMER_APPROACHING, baseFields);
          }
        } else {
          result = await createRecord(TABLE_CUSTOMER_APPROACHING, baseFields);
        }
        recordId = result.record_id;
        created = true;
      }
      return { recordId, created };
    })();
    const caseSafeP = caseRecordP.then(
      (value) => ({ ...value, error: null }),
      (error) => {
        console.warn("Case row not saved", String(error?.message || error).slice(0, 160));
        return { recordId: null, created: false, error };
      },
    );

    const [
      otherBrandsTask,
      pnlTask,
      topPnlTask,
      ltvTask,
      graceTask,
      riskTask,
      vipTask,
      specialReloadTask,
      telegram28Task,
      redeemTask,
      mooncakeTask,
      vs96Task,
      halloweenTask,
    ] = await Promise.all([
      optionalLookup("Other-brand check", async () => {
        const caUsernameOnly = await search(TABLE_CUSTOMER_APPROACHING, [
          { field_name: F.username, operator: "is", value: [uname] },
        ], undefined, { fieldNames: [F.brand] });
        return [...new Set(
          caUsernameOnly
            .map((r) => toDisplay(r.fields[F.brand]))
            .filter((b) => b && b.toUpperCase() !== brandVal.toUpperCase())
        )];
      }, []),

      optionalLookup("P&L tier", async () => {
        if (!TABLE_PNL) return { tier: "", customerName: "", notVip: false };
        const pnlMatches = await search(TABLE_PNL, [
          { field_name: F.username, operator: "is", value: [uname] },
          { field_name: F.brand, operator: "is", value: [brandVal] },
        ], undefined, { fieldNames: [F.tier, F.titleName] });
        if (!pnlMatches.length) return { tier: "", customerName: "", notVip: true };
        const tierMap = await getFieldOptionMap(TABLE_PNL, F.tier);
        return {
          tier: toDisplay(pnlMatches[0].fields[F.tier], tierMap),
          customerName: toDisplay(pnlMatches[0].fields[F.titleName]),
          notVip: false,
        };
      }, { tier: "", customerName: "", notVip: false }),

      optionalLookup("Top 10 P&L", () => findRow(
        TABLE_TOP_PNL_NIGHT, uname, brandVal,
        (fields) => {
          const display = toDisplay(fields[F.swCheck]).trim();
          return fields[F.claimedCopy] !== true && !!display && !hidden(display);
        },
        undefined,
        { fieldNames: [F.swCheck, F.claimedCopy, "Time of Inspection"] }
      )),

      optionalLookup("LTV", () => findRow(
        TABLE_LTV_DAY, uname, brandVal,
        (fields) => {
          const display = toDisplay(fields[F.swChecker]).trim();
          return /^pass\b/i.test(display) && !hidden(display);
        },
        undefined,
        { fieldNames: [F.swChecker, "Time of Inspection"] }
      )),

      optionalLookup("Grace Period", () => findRow(
        TABLE_GRACE_PERIOD, uname, brandVal,
        (fields) => !hidden(toDisplay(fields[F.swCheck])),
        undefined,
        { newest: true }
      )),

      optionalLookup("Risk Player", () => findRow(
        TABLE_RISK_PLAYER, uname, brandVal,
        (fields) => {
          const status = String(toDisplay(fields[F.status]) || "").trim();
          return !!status && !/no bonus/i.test(status) && !hidden(status);
        },
        undefined,
        { usernameField: "Username", dateField: "Date", fieldNames: [F.status, F.riskExpiry, "Date"] }
      )),

      optionalLookup("12h VIP Booster", () => findRow(
        TABLE_VIP_BOOSTER, uname, brandVal,
        (fields) => String(toDisplay(fields[F.status]) || "").trim().toLowerCase() === "eligible",
        undefined,
        { fieldNames: [F.status] }
      )),

      optionalLookup("Special Reload", () => findRow(
        TABLE_SPECIAL_RELOAD, uname, brandVal,
        (fields) => String(toDisplay(fields[F.status]) || "").trim().toLowerCase() === "eligible angpao",
        undefined,
        { fieldNames: [F.status] }
      )),

      optionalLookup("Telegram RM28", () => findRow(
        TABLE_TELEGRAM28, uname, brandVal,
        (fields) => String(toDisplay(fields[F.status]) || "").trim().toLowerCase() === "eligible",
        undefined,
        { fieldNames: [F.status, F.bonusAmount] }
      )),

      optionalLookup("Redeem Code", async () => {
        const redeemMatches = (await search(TABLE_REDEEM_CODE, [
          { field_name: F.usernameUid, operator: "is", value: [uname] },
          { field_name: F.brand, operator: "is", value: [brandVal] },
        ], undefined, { fieldNames: [F.status] })).filter((r) => !hidden(toDisplay(r.fields[F.status])));
        return redeemMatches[redeemMatches.length - 1] || null;
      }),

      optionalLookup("Mooncake", () => findRow(
        TABLE_MOONCAKE, uname, brandVal,
        (fields) => !hidden(toDisplay(fields[F.status])) && !!toDisplay(fields[F.status]),
        undefined,
        { usernameField: F.uid, fieldNames: [F.status, "Time of Inspection"] }
      )),

      optionalLookup("VS96 Feedback", () => findRow(
        TABLE_VS96_FEEDBACK, uname, brandVal,
        (fields) => {
          const status = toDisplay(fields[F.status]).trim();
          return !!status && !hidden(status);
        },
        undefined,
        { fieldNames: [F.status, "Time of Inspection"] }
      )),

      optionalLookup("Halloween", async () => {
        const today = malaysiaToday(Date.now(), testDateFor(event.env, event.headers));
        if (!TABLE_HALLOWEEN || !dayNumber(brandVal, today)) return null;
        const row = await readHalloweenRow(uname, brandKey(brandVal), { timeoutMs: budget.searchMs });
        return { row, today, maps: row ? await readOptionMaps() : {} };
      }, { failed: true }),
    ]);
    const { configs: configuredBonusConfigs, lookups: configuredBonusTasks } = await configuredBonusLookupsP;
    const [
      otherBrands,
      pnlInfo,
      topPnlRow,
      ltvRow,
      graceRow,
      riskRow,
      vipRow,
      specialReloadRow,
      telegram28Row,
      redeemRow,
      mooncakeRow,
      vs96Row,
      halloweenRead,
      ...configuredBonusValues
    ] = await (async () => {
      budget.searchMs = Math.max(retryMinMs, Math.min(RETRY_MAX_MS, startedAt + lookupBudgetMs - Date.now()));
      return resolveLookups([
      otherBrandsTask,
      pnlTask,
      topPnlTask,
      ltvTask,
      graceTask,
      riskTask,
      vipTask,
      specialReloadTask,
      telegram28Task,
      redeemTask,
      mooncakeTask,
      vs96Task,
      halloweenTask,
      ...configuredBonusTasks,
      ]);
    })();
    const { tier, customerName, notVip } = pnlInfo;
    const halloween = halloweenRead?.failed
      ? { state: "closed", failed: true, message: "Halloween progress could not be read. Press Look Up again." }
      : halloweenRead
        ? halloweenStatus({ brand: brandVal, tierText: tier, row: halloweenRead.row, today: halloweenRead.today, maps: halloweenRead.maps })
        : null;
    const configuredBonuses = Object.fromEntries(configuredBonusConfigs.map((config, index) => [
      config.key,
      configuredBonusValues[index],
    ]));
    const caseWaitMs = Math.max(0, Math.min(startedAt + lookupBudgetMs + caseGraceMs, hardEnd - 1_500) - Date.now());
    let caseTimer;
    const caseRecordState = await Promise.race([
      caseSafeP,
      new Promise((resolve) => { caseTimer = setTimeout(() => resolve({
        recordId: null, created: false,
        error: new Error("Case row did not finish inside the lookup time budget."),
      }), caseWaitMs); }),
    ]).finally(() => clearTimeout(caseTimer));
    let caRecordId = caseRecordState.recordId;
    const caseTableFull = !!caseRecordState.error && isTableFull(caseRecordState.error);
    const caseRowError = caseRecordState.error
      ? (caseTableFull ? TABLE_FULL_MESSAGE : "Case row not saved — press Look Up again (the results below are still valid).")
      : undefined;

    const dedupeRemainingMs = Math.min(startedAt + lookupBudgetMs, hardEnd - 1_000) - Date.now();
    if (!preview && link && caseRecordState.created && dedupeRemainingMs >= 3_000) {
      let dedupeTimer;
      const found = await Promise.race([
        reusableBlankCase(agentVal, uname, brandVal, link, Math.min(CASE_SEARCH_TIMEOUT_MS, dedupeRemainingMs), defer).catch(() => null),
        new Promise((resolve) => { dedupeTimer = setTimeout(() => resolve(null), dedupeRemainingMs); }),
      ]).finally(() => clearTimeout(dedupeTimer));
      caRecordId = found || caRecordId;
    }

    if (caseRowError) noteCounter("caseRowError");
    if (caseTableFull) noteCounter("caseTableFull");
    for (const source of new Set(lookupWarnings)) noteCounter(`lookupWarning:${source}`);
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        otherBrands,
        lookupWarnings: [...new Set(lookupWarnings)],
        justCreated: !preview && !caseRowError,
        notVip,
        caRecordId,
        ...(caseRowError ? { caseRowError } : {}),
        ...(caseTableFull ? { caseTableFull: true } : {}),
        row: {
          tier,
          customerName,
          topPnl: topPnlRow ? toDisplay(topPnlRow.fields[F.swCheck]) : "",
          ltvTest: ltvRow ? toDisplay(ltvRow.fields[F.swChecker]) : "",
          gracePeriod: graceRow ? toDisplay(graceRow.fields[F.swCheck]) : "",
          graceExpiryMs: graceRow ? toEpochMs(graceRow.fields[F.graceExpiry]) : null,
          riskPlayer: riskRow ? toDisplay(riskRow.fields[F.status]) : "",
          riskExpiryMs: riskRow ? toEpochMs(riskRow.fields[F.riskExpiry]) : null,
          vipBooster: vipRow ? "Eligible" : "",
          specialReload: specialReloadRow
            ? { recordId: specialReloadRow.record_id, status: toDisplay(specialReloadRow.fields[F.status]) }
            : null,
          telegram28: telegram28Row
            ? (() => {
                const status = toDisplay(telegram28Row.fields[F.status]);
                const amount = toDisplay(telegram28Row.fields[F.bonusAmount]);
                return { recordId: telegram28Row.record_id, status: amount ? `${status} — RM${amount}` : status };
              })()
            : null,
          redeemCode: redeemRow
            ? { recordId: redeemRow.record_id, status: toDisplay(redeemRow.fields[F.status]) }
            : null,
          mooncake: mooncakeRow ? toDisplay(mooncakeRow.fields[F.status]) : "",
          vs96Feedback: vs96Row ? toDisplay(vs96Row.fields[F.status]) : "",
          ...(halloween ? { halloween } : {}),
          ...configuredBonuses,
        },
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
}

export const onRequest = adapt(handler);
