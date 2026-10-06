import { adapt } from "./_lib/adapt.js";
import {
  searchRecords, createRecord, deleteRecord, toDisplay, getFieldOptionMap, findOldestClaimableRow,
  TABLE_CUSTOMER_APPROACHING, TABLE_REDEEM_CODE, TABLE_PNL,
  TABLE_GRACE_PERIOD, TABLE_TOP_PNL_NIGHT, TABLE_LTV_DAY, TABLE_RISK_PLAYER,
  TABLE_SPECIAL_RELOAD, TABLE_VIP_BOOSTER,
  TABLE_TELEGRAM28, TABLE_MOONCAKE, TABLE_VS96_FEEDBACK,
} from "./_lib/lark.js";
import { readOwnership, ownedBy, summarizeRow, parseChatLink } from "./_lib/ca-row.js";
import { isConfiguredBonusEligible, listBonusConfigs } from "./_lib/bonus-config.js";

// The widget aborts a lookup at 45 s. Keep the whole server-side lookup inside
// that: a bounded first pass over every source, then a bounded retry of only the
// sources that failed. A source that still has not answered is reported in
// lookupWarnings (explicitly unavailable) instead of the whole lookup hanging
// until the browser gives up with nothing.
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
  titleName: "Tittle name", // P&L's own customer-name field, shown before Tier -- yes, "Tittle" (confirmed from the real column header, not a typo on our end)
  status: "Status",
  swCheck: "SW Check",
  swChecker: "SW Checker", // LTV(Day)'s equivalent field is spelled differently from Top 10 P&L(Night)'s — confirmed from a real row, not a guess
  claimedCopy: "Claimed Copy",
  bonusAmount: "Bonus Amount", // Telegram RM28's actual per-row amount (18, 8, 28, 5...) — confirmed from a real screenshot
  graceExpiry: "Expried", // yes, "Expried" (confirmed from the real column header) -- Grace Period's own expiry date, gates whether Reactivate shows in app.js
  riskExpiry: "Date Expired", // Risk Player(Day)'s own expiry date column -- confirmed from the real column header
  uid: "UID", // Mooncake bonus's own username column -- confirmed from a real screenshot; plain "UID", not "Username/UID" like most other bonus tables (same situation as Risk Player's plain "Username").
};

// A repeated Look Up for the same chat used to delete its still-blank row
// and create a replacement. If that best-effort delete hit a transient Lark
// failure, the replacement became a second row and the abandoned first row
// later appeared under Needs Attention. Reuse the one blank row for this
// exact agent/player/brand/thread instead. If an older deployment already
// produced several blank twins, keep the oldest deterministically and remove
// the rest so concurrent callers converge on the same record.
// Create-with-link falls back to a link-less create ONLY when Lark rejected the link column
// itself. A timeout, 5xx, throttle or batch-mismatch can all mean the row WAS created, so
// those are re-thrown: the agent's next lookup reuses the blank row instead of creating a twin.
function isLinkFieldRejection(error) {
  if (error?.rateLimited) return false;
  const message = String(error?.message || "");
  if (!/^Lark create failed/i.test(message)) return false;
  // Never for anything where the row may exist: timeouts, 5xx/busy, throttling, a batch that could not be matched.
  if (/timed? ?out|rate.?limit|too ?many|could not be matched|internal|temporar|busy|server error/i.test(message)) return false;
  // Lark rejects a bad URL field with URLFieldConvFail (code 1254068); a missing/renamed column names the field.
  return Number(error?.code) === 1254068
    || /FieldConvFail/i.test(String(error?.larkMsg || "") + " " + message)
    || /\blink\b/i.test(message);
}

async function reusableBlankCase(agent, username, brand, link, timeoutMs = CASE_SEARCH_TIMEOUT_MS) {
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
    // Exactly the columns the filter below re-checks. Projecting them lets the shared
    // queue merge this lookup with other agents' (one OR query over many usernames,
    // filtered back per caller) instead of spending a Lark call per lookup on it.
    fieldNames: [F.agentName, F.username, F.brand, "Inquiry", "Status", "link"],
  });
  const matches = rows.map(summarizeRow)
    .filter((row) => row.agent === agent && row.username === username && row.brand === brand
      && String(row.link || "").trim().replace(/\/$/, "") === exactLink
      && !row.inquiry.length && !row.status)
    .sort((a, b) => (a.createdAt - b.createdAt) || a.recordId.localeCompare(b.recordId));
  if (!matches.length) return null;
  await Promise.allSettled(matches.slice(1).map(async (row) => {
    // Re-check immediately before deletion. A concurrent submit may have
    // completed the row after the search snapshot was returned.
    const { owner, blank } = await readOwnership(row.recordId);
    if (blank && ownedBy(owner, agent)) await deleteRecord(TABLE_CUSTOMER_APPROACHING, row.recordId);
  }));
  return matches[0].recordId;
}

// Word-boundary substring, not startsWith/=== -- real Status/SW Check
// values embed "claimed"/"expired"/"failed" in different positions per
// table: LTV(Day) is "Claimed RM18" (prefix), but Top 10 P&L(Night) is
// "Batch 09-09-2026 Claimed RM58" (buried in the middle, confirmed live
// 2026-09-19 -- a claimed row still showed as an active claimable ticket
// under startsWith, same bug class as the earlier LTV one). \b so this
// never partial-matches inside an unrelated word.
function hidden(v) {
  const t = String(v || "").trim().toLowerCase();
  // "Not Eligible" / "Ineligible" (e.g. Risk Player) = nothing to claim. Must
  // be filtered here too, not just in the app: findOldestClaimableRow picks
  // the OLDEST claimable row, so a stale "Not Eligible" row would otherwise
  // be returned instead of a newer, genuinely eligible one.
  return /\b(claimed|expired|failed|not\s+eligible|ineligible)\b/.test(t);
}

// "Expried" (Grace Period's own expiry date) previously only worked when
// Lark handed it back as a bare number -- true for a plain Date field, but
// not guaranteed if it's actually a Formula field underneath (same
// situation "SW Check" already needed toDisplay() for: Lark can wrap a
// Formula's output in a segments array or a {value: ...}/{text: ...}
// object instead of returning the raw type directly). A shape mismatch
// here silently failed the `typeof === "number"` check and left
// graceExpiryMs null no matter which row got picked -- confirmed live as
// Reactivate never showing even for a genuinely not-yet-expired cycle.
// Unwraps the same handful of shapes toDisplay() does, but returns the
// numeric epoch itself instead of a display string.
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

export async function handler(event) {
  try {
    const { username, brand, picName, previousRecordId, link, preview } = JSON.parse(event.body || "{}");
    if (!username || !brand) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "username and brand are required" }) };
    }
    // P&L (and every other bonus table's Username column) is always stored
    // lowercase -- confirmed from real data, no capitals anywhere. Lark's
    // "is" filter is an exact-match string comparison, not case-insensitive,
    // so a CS agent typing a username with any capital letters (autocapitalize
    // on a phone keyboard, habit, copy-pasted from a chat where the player
    // capitalized their own name, etc.) silently matched nothing on every
    // table -- P&L Tier, LTV, Top 10 P&L, Grace Period, Risk Player, VIP
    // Booster, all of it -- with no error, just an empty/"not VIP" result.
    // Lowercasing once here (before it's used for any search below, or
    // written into the new Customer Approaching row) fixes every one of
    // those lookups at the source, regardless of what case the agent typed.
    const uname = username.trim().toLowerCase();
    const brandVal = brand.trim();
    const agentVal = (picName || "").trim();
    const lookupWarnings = [];
    const startedAt = Date.now();
    // Overridable through the request env only so tests need not wait 22 s.
    const firstPassMs = Number(event.env?.LOOKUP_FIRST_PASS_MS) || FIRST_PASS_TIMEOUT_MS;
    const lookupBudgetMs = Number(event.env?.LOOKUP_BUDGET_MS) || LOOKUP_BUDGET_MS;
    const retryMinMs = Number(event.env?.LOOKUP_RETRY_MIN_MS) || RETRY_MIN_MS;
    const budget = { searchMs: firstPassMs };
    const search = (table, conditions, base, opts = {}) => searchRecords(table, conditions, base, { ...opts, timeoutMs: budget.searchMs });
    const findRow = (table, name, brandName, isClaimable, base, opts = {}) =>
      findOldestClaimableRow(table, name, brandName, isClaimable, base, { ...opts, timeoutMs: budget.searchMs });
    // Reads that are not searches (config table listing, field catalogs) have no
    // per-call deadline of their own, so every source is raced against one here.
    const guard = (promise, ms, label) => {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`${label} did not answer within ${Math.round(ms / 1000)} seconds.`), { retryable: true })), ms);
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    };
    // Let the whole first wave finish before retrying anything. The second
    // wave then contains only failed sources, so a partial Lark outage cannot
    // make every table independently retry at once.
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
      // The complete first pass has settled before reaching this point. Only
      // failed transient sources enter the second wave; searchRecords' local
      // semaphore and the shared Durable Object queue cap concurrent retries.
      // Running this bounded wave together avoids multiplying a 5s timeout by
      // the number of tables when Lark is slow.
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

    // User-defined regular bonuses are stored as metadata in Lark. Start
    // their reads immediately so they run alongside the built-in lookups.
    const configuredBonusConfigsP = optionalLookup(
      "Custom bonuses",
      () => listBonusConfigs({ fresh: !!preview }),
      [],
    );
    // Start configured table searches as soon as their metadata arrives,
    // alongside the built-in checks below. Previously we waited for every
    // built-in table to finish before even starting these reads.
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
    // Whatever is left of the overall lookup budget, never above the per-search ceiling.
    const caseBudgetMs = () => Math.max(caseMinMs, Math.min(CASE_SEARCH_TIMEOUT_MS, startedAt + lookupBudgetMs - Date.now()));
    // Start case-row work alongside the independent bonus-table reads below.
    // Previously its search and create calls both completed before those reads
    // even began, adding two network waits to every new chat lookup.
    const caseRecordP = (async () => {
      // Only a *successful* "no blank row found" may lead to creating a new
      // row. If the check itself fails (e.g. Lark throttling), swallowing the
      // error here used to create a second blank row for the same chat, which
      // later surfaced as a duplicate under Needs Attention. Retry once, then
      // fail the lookup so the agent can simply look up again.
      let recordId = null;
      if (!preview && chatLink) {
        for (let attempt = 0; ; attempt++) {
          try { recordId = await reusableBlankCase(agentVal, uname, brandVal, chatLink, caseBudgetMs()); break; }
          catch (error) {
            if (attempt >= 1 || (error.retryable === false && !error.rateLimited)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 400 + Math.floor(Math.random() * 300)));
          }
        }
      }

      // Same row as last time (the blank-row check just matched it): nothing to clean up, so no read either.
      if (!preview && previousRecordId && previousRecordId !== recordId) {
        try {
          const { owner, blank } = await readOwnership(previousRecordId);
          if (blank && ownedBy(owner, agentVal)) {
            await deleteRecord(TABLE_CUSTOMER_APPROACHING, previousRecordId);
          }
        } catch (_) { /* non-fatal */ }
      }

      let created = false;
      if (!preview && !recordId) {
        if (startedAt + lookupBudgetMs - Date.now() < caseMinMs) {
          // No time left to create AND report back; starting a create now could finish after the
          // widget has given up. Nothing was created -- the agent just looks up again.
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
    // A case-row failure must not throw away the bonus results (and leave the reads running for
    // nothing): it is reported next to them instead. Bounded so it can never outlive the widget.
    const caseSafeP = caseRecordP.then(
      (value) => ({ ...value, error: null }),
      (error) => {
        console.warn("Case row not saved", String(error?.message || error).slice(0, 160));
        return { recordId: null, created: false, error };
      },
    );

    // Every lookup below is fully independent of the others (and of
    // caRecordId) -- previously each was its own separate `await`, one
    // after another, meaning ~9 sequential Lark API round trips stacked
    // into a single request (roughly 200-800ms of network latency each,
    // so several seconds in a slow moment). Confirmed live as a
    // contributor to "record created but the response never arrived as
    // valid JSON" recurring intermittently even after de-duping the
    // concurrent-token race (see _lib/lark.js's getTenantToken note) --
    // Cloudflare (or the browser's own fetch) can still give up on a slow
    // enough chain of sequential awaits. Running them all together caps
    // the total wait at whichever single lookup is slowest, not their sum.
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
    ] = await Promise.all([
      // Warn CS if username exists under other brands
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

      // Tier comes straight from the P&L "master file" table (Username +
      // Brand match) — not from Customer Approaching's Tier Lookup. P&L is
      // the full VIP player list, so no match at all means this username
      // isn't a VIP under this brand — surfaced to the frontend as notVip
      // rather than just silently leaving Tier blank.
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
      }, { tier: "", customerName: "", notVip: false }), // non-fatal — tier/customerName just show blank, notVip stays false

      // Top 10 P&L(Night): "Claimed Copy" checkbox is the claim flag
      // (unticked = still claimable); displayed value is "SW Check". This
      // used to only check the checkbox + that SW Check had *some* text, not
      // what it said — a "Failed" row (customer didn't qualify) slipped
      // through as a claimable ticket. Now hidden() (Claimed/Expired/Failed)
      // gates the actual text too, same as every other bonus table.
      optionalLookup("Top 10 P&L", () => findRow(
        TABLE_TOP_PNL_NIGHT, uname, brandVal,
        (fields) => {
          const display = toDisplay(fields[F.swCheck]).trim();
          return fields[F.claimedCopy] !== true && !!display && !hidden(display);
        },
        undefined,
        { fieldNames: [F.swCheck, F.claimedCopy, "Time of Inspection"] }
      )),

      // LTV(Day): read the live "SW Checker" field. Only values beginning
      // with Pass are eligible, and recurring rows are consumed FIFO by
      // Time of Inspection, matching Top 10 P&L.
      optionalLookup("LTV", () => findRow(
        TABLE_LTV_DAY, uname, brandVal,
        (fields) => {
          const display = toDisplay(fields[F.swChecker]).trim();
          return /^pass\b/i.test(display) && !hidden(display);
        },
        undefined,
        { fieldNames: [F.swChecker, "Time of Inspection"] }
      )),

      // Grace Period(Day): "SW Check" is both the claim flag (hide only
      // Claimed/Expired) and the displayed value. "SW Check" is a Formula
      // field, so its raw API value can come back as a segments array rather
      // than a plain string — hidden() needs toDisplay() first, or it never
      // matches "claimed"/"expired" and an actually-expired row can slip
      // through as "claimable" (this was the actual bug: an expired row got
      // picked over the real one, so the ticket ended up hidden entirely once
      // isClaimableValue saw "Expired" client-side).
      //
      // newest: true -- Grace Period is a recurring weekly challenge, and an
      // old cycle's own row can still read as "claimable" long after a newer
      // cycle has started (its SW Check/Activated text doesn't change once
      // written). Picking the oldest claimable row (every other bonus
      // table's correct default) meant Reactivate's own expiry check
      // (graceExpiryMs) compared against a stale, already-past cycle even
      // when a current, still-valid one existed -- confirmed live: a
      // genuinely not-yet-expired Grace Period bonus wasn't showing
      // Reactivate at all.
      optionalLookup("Grace Period", () => findRow(
        TABLE_GRACE_PERIOD, uname, brandVal,
        (fields) => !hidden(toDisplay(fields[F.swCheck])),
        undefined,
        // Keep the full Grace row until its live column names are confirmed;
        // Lark rejects the whole search when any projected field name is
        // absent, and the caller intentionally treats bonus-table errors as
        // an empty result.
        { newest: true }
      )),

      // Risk Player(Day): one field ("Status") encodes both which day-tier
      // applies (e.g. "7D 20% Reload") and whether there's anything to claim
      // at all ("1D No Bonus"/"3D No Bonus" mean no bonus, not just a claimed
      // one). Hide "No Bonus" tiers plus Claimed/Expired.
      //
      // Confirmed from the real table's own column headers (2026-09-11):
      // unlike every other bonus table here, Risk Player(Day)'s Username
      // column is plain "Username" (not "Username/UID") and its date column
      // is plain "Date" (not "Time of Inspection") — searching with the
      // usual field names silently found zero rows for every customer,
      // Lark's search API errors on an unrecognized field_name and every
      // call site here catches that as "nothing claimable", indistinguishable
      // from a real no-match without checking the table's own columns
      // directly like this did.
      optionalLookup("Risk Player", () => findRow(
        TABLE_RISK_PLAYER, uname, brandVal,
        (fields) => {
          const status = String(toDisplay(fields[F.status]) || "").trim();
          return !!status && !/no bonus/i.test(status) && !hidden(status);
        },
        undefined,
        { usernameField: "Username", dateField: "Date", fieldNames: [F.status, F.riskExpiry, "Date"] }
      )),

      // 12hour VIP Deposit Booster: only "Eligible" (exact) counts.
      optionalLookup("12h VIP Booster", () => findRow(
        TABLE_VIP_BOOSTER, uname, brandVal,
        (fields) => String(toDisplay(fields[F.status]) || "").trim().toLowerCase() === "eligible",
        undefined,
        { fieldNames: [F.status] }
      )),

      // Special Reload Event: only "Eligible Angpao" counts — the Free Spin
      // variant that used to live in this table is retired (kept for old
      // record history only), so it's intentionally not checked for here.
      optionalLookup("Special Reload", () => findRow(
        TABLE_SPECIAL_RELOAD, uname, brandVal,
        (fields) => String(toDisplay(fields[F.status]) || "").trim().toLowerCase() === "eligible angpao",
        undefined,
        { fieldNames: [F.status] }
      )),

      // Telegram RM28 (2026-09-09) — repurposes the retired Ang Pao ticket's
      // plumbing, lives on the main base like every other bonus table above.
      // Only "Eligible" counts; display combines Status with the row's own
      // Bonus Amount so the agent sees the real claimable amount, e.g.
      // "Eligible — RM18" — and so the existing "grab the number after RM"
      // extraction (already fixed for the Top 10 P&L bug) picks up the right
      // amount for Released Amount with no new extraction logic needed.
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

      // Mooncake bonus: "Status" hides Claimed/Expired same as every other
      // table (only "Pass" is a real value here today, but this follows the
      // same generic hidden()-based rule as LTV/Grace Period rather than an
      // exact "pass" string match, so it doesn't need a code change if Lark
      // ever adds another non-Claimed status). No monetary amount column,
      // so it's not in AMOUNT_ELIGIBLE_PROGRAMS on the frontend. Username
      // column is plain "UID" here, not "Username/UID".
      optionalLookup("Mooncake", () => findRow(
        TABLE_MOONCAKE, uname, brandVal,
        (fields) => !hidden(toDisplay(fields[F.status])) && !!toDisplay(fields[F.status]),
        undefined,
        { usernameField: F.uid, fieldNames: [F.status, "Time of Inspection"] }
      )),

      // VS96 Feedback Bonus: any non-empty Status is eligible except the
      // shared terminal states. Pick the oldest eligible inspection so a
      // player with several campaign rows is handled FIFO and deterministically.
      optionalLookup("VS96 Feedback", () => findRow(
        TABLE_VS96_FEEDBACK, uname, brandVal,
        (fields) => {
          const status = toDisplay(fields[F.status]).trim();
          return !!status && !hidden(status);
        },
        undefined,
        { fieldNames: [F.status, "Time of Inspection"] }
      )),
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
      ...configuredBonusValues
    ] = await (async () => {
      // Whatever time the first pass left (inside the overall budget) is what the
      // retry wave of failed sources may use.
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
      ...configuredBonusTasks,
      ]);
    })();
    const { tier, customerName, notVip } = pnlInfo;
    const configuredBonuses = Object.fromEntries(configuredBonusConfigs.map((config, index) => [
      config.key,
      configuredBonusValues[index],
    ]));
    // Wait for the case row, but only up to the widget's own deadline (budget + grace).
    const caseRecordState = await Promise.race([
      caseSafeP,
      new Promise((resolve) => setTimeout(() => resolve({
        recordId: null, created: false,
        error: new Error("Case row did not finish inside the lookup time budget."),
      }), Math.max(0, startedAt + lookupBudgetMs + caseGraceMs - Date.now()))),
    ]);
    let caRecordId = caseRecordState.recordId;
    const caseRowError = caseRecordState.error
      ? "Case row not saved — press Look Up again (the results below are still valid)."
      : undefined;

    // A second request can begin at the same moment and pass the pre-create
    // check above before either row exists. Re-run the same deterministic
    // coalescing after the slower bonus reads; both requests then return the
    // same surviving record instead of leaving a blank twin behind.
    const dedupeRemainingMs = startedAt + lookupBudgetMs - Date.now();
    if (!preview && link && caseRecordState.created && dedupeRemainingMs >= 3_000) {
      // "||": if Lark's search does not show the row we just created yet (index lag) the check finds
      // nothing -- that must never replace the new row's id with null.
      caRecordId = (await reusableBlankCase(agentVal, uname, brandVal, link, Math.min(CASE_SEARCH_TIMEOUT_MS, dedupeRemainingMs)).catch(() => null)) || caRecordId;
    }

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
        row: {
          tier,
          customerName,
          topPnl: topPnlRow ? toDisplay(topPnlRow.fields[F.swCheck]) : "",
          ltvTest: ltvRow ? toDisplay(ltvRow.fields[F.swChecker]) : "",
          gracePeriod: graceRow ? toDisplay(graceRow.fields[F.swCheck]) : "",
          // Raw epoch ms, straight off the Date field -- an absolute
          // timestamp, unaffected by any of that field's own display/
          // timezone formatting in Lark's UI. app.js compares it against
          // the agent's local "today" to decide whether Reactivate still
          // makes sense to offer at all.
          graceExpiryMs: graceRow ? toEpochMs(graceRow.fields[F.graceExpiry]) : null,
          riskPlayer: riskRow ? toDisplay(riskRow.fields[F.status]) : "",
          // Same epoch-ms pattern as graceExpiryMs above -- Date Expired is
          // a Date field, so it may come back as a bare number or (if the
          // column's ever swapped to a Formula) one of the wrapped shapes
          // toEpochMs() already unwraps. Sent as a raw timestamp, not a
          // pre-formatted string, so app.js can format it in the agent's
          // own local time and decide for itself whether it's already past.
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
          ...configuredBonuses,
        },
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
}

export const onRequest = adapt(handler);
