import { adapt } from "./_lib/adapt.js";
import {
  searchRecords, createRecord, deleteRecord, toDisplay, getFieldOptionMap, findOldestClaimableRow,
  TABLE_CUSTOMER_APPROACHING, TABLE_REDEEM_CODE, TABLE_PNL,
  TABLE_GRACE_PERIOD, TABLE_TOP_PNL_NIGHT, TABLE_LTV_DAY, TABLE_RISK_PLAYER,
  TABLE_SPECIAL_RELOAD, TABLE_VIP_BOOSTER,
  TABLE_TELEGRAM28, TABLE_MOONCAKE, TABLE_VS96_FEEDBACK,
} from "./_lib/lark.js";
import { readOwnership, ownedBy } from "./_lib/ca-row.js";

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
  swCheckerCopy: "SW Checker Copy", // LTV(Day)'s own copy field -- this, not "Status", is what actually decides claimable (see the LTV(Day) block below)
  claimedCopy: "Claimed Copy",
  bonusAmount: "Bonus Amount", // Telegram RM28's actual per-row amount (18, 8, 28, 5...) — confirmed from a real screenshot
  graceExpiry: "Expried", // yes, "Expried" (confirmed from the real column header) -- Grace Period's own expiry date, gates whether Reactivate shows in app.js
  riskExpiry: "Date Expired", // Risk Player(Day)'s own expiry date column -- confirmed from the real column header
  uid: "UID", // Mooncake bonus's own username column -- confirmed from a real screenshot; plain "UID", not "Username/UID" like most other bonus tables (same situation as Risk Player's plain "Username").
};

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
    const { username, brand, picName, previousRecordId, link } = JSON.parse(event.body || "{}");
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

    // One Customer Approaching row per chat, not one per Look Up click —
    // if the agent looks up again for the same chat (typo fix, re-check,
    // etc.), the frontend passes back the record it created last time here
    // so it can be deleted first. Non-fatal: if the delete fails (already
    // gone, etc.) the old row just lingers rather than blocking the new
    // lookup. Only ever sent for a chat that hasn't been logged yet (see
    // app.js) -- a completed case is never deleted by a stray re-lookup.
    //
    // Only this agent's own still-blank row is ever removed: after a chat
    // transfer (PC crash / lost connection) the previous agent's row stays
    // theirs, and the new agent gets a separate row of their own.
    if (previousRecordId) {
      try {
        const { owner, blank } = await readOwnership(previousRecordId);
        if (blank && ownedBy(owner, agentVal)) await deleteRecord(TABLE_CUSTOMER_APPROACHING, previousRecordId);
      } catch (_) { /* non-fatal */ }
    }

    // Always create a fresh record — each Look Up is a new case. This row
    // is only a target for the final Record submit now (Agent Name, Brand,
    // Inquiry, Status, Player D.O.B, etc.) — none of the actual bonus data
    // below comes from its Lookup columns anymore (see the 2026-08-29
    // rearchitecture note in lib/lark.js), so there's no Lookup-resolution
    // delay to wait out.
    // The chat link goes on the row right away (not just on final submit)
    // so an unfinished row can still be traced back to its chat -- see
    // lark-stale-records.js. "link" is a Lark Link field, hence {link, text}.
    // If the link write is ever rejected, retry without it rather than
    // failing the whole Look Up.
    const baseFields = { [F.username]: uname, [F.brand]: brandVal, [F.agentName]: agentVal };
    const chatLink = String(link || "").trim();
    const created = chatLink
      ? await createRecord(TABLE_CUSTOMER_APPROACHING, { ...baseFields, link: { link: chatLink, text: chatLink } })
          .catch(() => createRecord(TABLE_CUSTOMER_APPROACHING, baseFields))
      : await createRecord(TABLE_CUSTOMER_APPROACHING, baseFields);
    const caRecordId = created.record_id;

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
      otherBrands,
      { tier, customerName, notVip },
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
    ] = await Promise.all([
      // Warn CS if username exists under other brands
      (async () => {
        const caUsernameOnly = await searchRecords(TABLE_CUSTOMER_APPROACHING, [
          { field_name: F.username, operator: "is", value: [uname] },
        ]);
        return [...new Set(
          caUsernameOnly
            .map((r) => toDisplay(r.fields[F.brand]))
            .filter((b) => b && b.toUpperCase() !== brandVal.toUpperCase())
        )];
      })().catch(() => []),

      // Tier comes straight from the P&L "master file" table (Username +
      // Brand match) — not from Customer Approaching's Tier Lookup. P&L is
      // the full VIP player list, so no match at all means this username
      // isn't a VIP under this brand — surfaced to the frontend as notVip
      // rather than just silently leaving Tier blank.
      (async () => {
        if (!TABLE_PNL) return { tier: "", customerName: "", notVip: false };
        const pnlMatches = await searchRecords(TABLE_PNL, [
          { field_name: F.username, operator: "is", value: [uname] },
          { field_name: F.brand, operator: "is", value: [brandVal] },
        ]);
        if (!pnlMatches.length) return { tier: "", customerName: "", notVip: true };
        const tierMap = await getFieldOptionMap(TABLE_PNL, F.tier);
        return {
          tier: toDisplay(pnlMatches[0].fields[F.tier], tierMap),
          customerName: toDisplay(pnlMatches[0].fields[F.titleName]),
          notVip: false,
        };
      })().catch(() => ({ tier: "", customerName: "", notVip: false })), // non-fatal — tier/customerName just show blank, notVip stays false

      // Top 10 P&L(Night): "Claimed Copy" checkbox is the claim flag
      // (unticked = still claimable); displayed value is "SW Check". This
      // used to only check the checkbox + that SW Check had *some* text, not
      // what it said — a "Failed" row (customer didn't qualify) slipped
      // through as a claimable ticket. Now hidden() (Claimed/Expired/Failed)
      // gates the actual text too, same as every other bonus table.
      findOldestClaimableRow(
        TABLE_TOP_PNL_NIGHT, uname, brandVal,
        (fields) => {
          const display = toDisplay(fields[F.swCheck]);
          return fields[F.claimedCopy] !== true && !!display && !hidden(display);
        }
      ).catch(() => null),

      // LTV(Day): the "Status" formula field was still leaving rows hidden
      // that should've shown -- checking "SW Checker Copy" directly instead
      // (confirmed live to be the reliable one): contains "Failed" or
      // "Claimed" -> not claimable, contains "Pass" -> claimable. When more
      // than one row for this Username/Brand contains "Pass", only the most
      // recent one (by Time of Inspection) should show -- newest: true does
      // exactly that: filters down to the Pass-only rows first, then picks
      // the latest of those, same as scanning newest-to-oldest and stopping
      // at the first Pass. Display text comes from the same field that was
      // checked, so it always reflects the row actually picked.
      findOldestClaimableRow(
        TABLE_LTV_DAY, uname, brandVal,
        (fields) => /pass/i.test(toDisplay(fields[F.swCheckerCopy])),
        undefined,
        { newest: true }
      ).catch(() => null),

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
      findOldestClaimableRow(
        TABLE_GRACE_PERIOD, uname, brandVal,
        (fields) => !hidden(toDisplay(fields[F.swCheck])),
        undefined,
        { newest: true }
      ).catch(() => null),

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
      findOldestClaimableRow(
        TABLE_RISK_PLAYER, uname, brandVal,
        (fields) => {
          const status = String(toDisplay(fields[F.status]) || "").trim();
          return !!status && !/no bonus/i.test(status) && !hidden(status);
        },
        undefined,
        { usernameField: "Username", dateField: "Date" }
      ).catch(() => null),

      // 12hour VIP Deposit Booster: only "Eligible" (exact) counts.
      findOldestClaimableRow(
        TABLE_VIP_BOOSTER, uname, brandVal,
        (fields) => String(toDisplay(fields[F.status]) || "").trim().toLowerCase() === "eligible"
      ).catch(() => null),

      // Special Reload Event: only "Eligible Angpao" counts — the Free Spin
      // variant that used to live in this table is retired (kept for old
      // record history only), so it's intentionally not checked for here.
      findOldestClaimableRow(
        TABLE_SPECIAL_RELOAD, uname, brandVal,
        (fields) => String(toDisplay(fields[F.status]) || "").trim().toLowerCase() === "eligible angpao"
      ).catch(() => null),

      // Telegram RM28 (2026-09-09) — repurposes the retired Ang Pao ticket's
      // plumbing, lives on the main base like every other bonus table above.
      // Only "Eligible" counts; display combines Status with the row's own
      // Bonus Amount so the agent sees the real claimable amount, e.g.
      // "Eligible — RM18" — and so the existing "grab the number after RM"
      // extraction (already fixed for the Top 10 P&L bug) picks up the right
      // amount for Released Amount with no new extraction logic needed.
      findOldestClaimableRow(
        TABLE_TELEGRAM28, uname, brandVal,
        (fields) => String(toDisplay(fields[F.status]) || "").trim().toLowerCase() === "eligible"
      ).catch(() => null),

      (async () => {
        const redeemMatches = (await searchRecords(TABLE_REDEEM_CODE, [
          { field_name: F.usernameUid, operator: "is", value: [uname] },
          { field_name: F.brand, operator: "is", value: [brandVal] },
        ])).filter((r) => !hidden(toDisplay(r.fields[F.status])));
        return redeemMatches[redeemMatches.length - 1] || null;
      })().catch(() => null),

      // Mooncake bonus: "Status" hides Claimed/Expired same as every other
      // table (only "Pass" is a real value here today, but this follows the
      // same generic hidden()-based rule as LTV/Grace Period rather than an
      // exact "pass" string match, so it doesn't need a code change if Lark
      // ever adds another non-Claimed status). No monetary amount column,
      // so it's not in AMOUNT_ELIGIBLE_PROGRAMS on the frontend. Username
      // column is plain "UID" here, not "Username/UID".
      findOldestClaimableRow(
        TABLE_MOONCAKE, uname, brandVal,
        (fields) => !hidden(toDisplay(fields[F.status])) && !!toDisplay(fields[F.status]),
        undefined,
        { usernameField: F.uid }
      ).catch(() => null),

      // VS96 Feedback Bonus: same rule as Redeem Code above -- "Status"
      // hides Claimed/Expired, anything else (still shows as its actual
      // text, e.g. "Eligible" / "Pass") is claimable.
      (async () => {
        const vs96Matches = (await searchRecords(TABLE_VS96_FEEDBACK, [
          { field_name: F.usernameUid, operator: "is", value: [uname] },
          { field_name: F.brand, operator: "is", value: [brandVal] },
        ])).filter((r) => !hidden(toDisplay(r.fields[F.status])));
        return vs96Matches[vs96Matches.length - 1] || null;
      })().catch(() => null),
    ]);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        otherBrands,
        justCreated: true,
        notVip,
        caRecordId,
        row: {
          tier,
          customerName,
          topPnl: topPnlRow ? toDisplay(topPnlRow.fields[F.swCheck]) : "",
          ltvTest: ltvRow ? toDisplay(ltvRow.fields[F.swCheckerCopy]) : "",
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
        },
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
}

export const onRequest = adapt(handler);
