const {
  searchRecords, createRecord, deleteRecord, toDisplay, getFieldOptionMap, findOldestClaimableRow,
  TABLE_CUSTOMER_APPROACHING, TABLE_ANG_PAO, TABLE_REDEEM_CODE, TABLE_PNL,
  TABLE_GRACE_PERIOD, TABLE_TOP_PNL_NIGHT, TABLE_LTV_DAY, TABLE_RISK_PLAYER,
  TABLE_SPECIAL_RELOAD, TABLE_VIP_BOOSTER,
} = require("./lib/lark");

const F = {
  username: "Username",
  usernameUid: "Username/UID",
  brand: "Brand",
  agentName: "Agent Name",
  tier: "Tier",
  status: "Status",
  swCheck: "SW Check",
  swChecker: "SW Checker", // LTV(Day)'s equivalent field is spelled differently from Top 10 P&L(Night)'s — confirmed from a real row, not a guess
  claimedCopy: "Claimed Copy",
  angPaoAmount: "Ang Pao Claim",
};

function hidden(v) {
  const t = String(v || "").trim().toLowerCase();
  return t === "claimed" || t === "expired" || t === "failed";
}

exports.handler = async function (event) {
  try {
    const { username, brand, picName, previousRecordId } = JSON.parse(event.body || "{}");
    if (!username || !brand) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "username and brand are required" }) };
    }
    const uname = username.trim();
    const brandVal = brand.trim();
    const agentVal = (picName || "").trim();

    // One Customer Approaching row per chat, not one per Look Up click —
    // if the agent looks up again for the same chat (typo fix, re-check,
    // etc.), the frontend passes back the record it created last time here
    // so it can be deleted first. Non-fatal: if the delete fails (already
    // gone, etc.) the old row just lingers rather than blocking the new
    // lookup. Only ever sent for a chat that hasn't been logged yet (see
    // app.js) -- a completed case is never deleted by a stray re-lookup.
    if (previousRecordId) {
      try { await deleteRecord(TABLE_CUSTOMER_APPROACHING, previousRecordId); } catch (_) { /* non-fatal */ }
    }

    // Always create a fresh record — each Look Up is a new case. This row
    // is only a target for the final Record submit now (Agent Name, Brand,
    // Inquiry, Status, Player D.O.B, etc.) — none of the actual bonus data
    // below comes from its Lookup columns anymore (see the 2026-08-29
    // rearchitecture note in lib/lark.js), so there's no Lookup-resolution
    // delay to wait out.
    const created = await createRecord(TABLE_CUSTOMER_APPROACHING, {
      [F.username]: uname,
      [F.brand]: brandVal,
      [F.agentName]: agentVal,
    });
    const caRecordId = created.record_id;

    // Warn CS if username exists under other brands
    const caUsernameOnly = await searchRecords(TABLE_CUSTOMER_APPROACHING, [
      { field_name: F.username, operator: "is", value: [uname] },
    ]);
    const otherBrands = [...new Set(
      caUsernameOnly
        .map((r) => toDisplay(r.fields[F.brand]))
        .filter((b) => b && b.toUpperCase() !== brandVal.toUpperCase())
    )];

    // Tier comes straight from the P&L "master file" table (Username +
    // Brand match) — not from Customer Approaching's Tier Lookup. P&L is
    // the full VIP player list, so no match at all means this username
    // isn't a VIP under this brand — surfaced to the frontend as notVip
    // rather than just silently leaving Tier blank.
    let tier = "";
    let notVip = false;
    try {
      if (TABLE_PNL) {
        const pnlMatches = await searchRecords(TABLE_PNL, [
          { field_name: F.username, operator: "is", value: [uname] },
          { field_name: F.brand, operator: "is", value: [brandVal] },
        ]);
        if (pnlMatches.length) {
          const tierMap = await getFieldOptionMap(TABLE_PNL, F.tier);
          tier = toDisplay(pnlMatches[0].fields[F.tier], tierMap);
        } else {
          notVip = true;
        }
      }
    } catch (_) { /* non-fatal — tier just shows blank, notVip stays false */ }

    // Top 10 P&L(Night): "Claimed Copy" checkbox is the claim flag
    // (unticked = still claimable); displayed value is "SW Check". This
    // used to only check the checkbox + that SW Check had *some* text, not
    // what it said — a "Failed" row (customer didn't qualify) slipped
    // through as a claimable ticket. Now hidden() (Claimed/Expired/Failed)
    // gates the actual text too, same as every other bonus table.
    const [topPnlRow, ltvRow] = await Promise.all([
      findOldestClaimableRow(
        TABLE_TOP_PNL_NIGHT, uname, brandVal,
        (fields) => {
          const display = toDisplay(fields[F.swCheck]);
          return fields[F.claimedCopy] !== true && !!display && !hidden(display);
        }
      ).catch(() => null),
      // LTV(Day) has no "Claimed Copy" field at all — confirmed from a real
      // row, not the same table structure as Top 10 P&L(Night) despite
      // looking similar at a glance. It follows Grace Period's pattern
      // instead: "Status" hides Claimed/Expired, display comes from
      // "SW Checker" (note the different spelling from Top 10 P&L's
      // "SW Check").
      findOldestClaimableRow(
        TABLE_LTV_DAY, uname, brandVal,
        (fields) => !hidden(toDisplay(fields[F.status])) && !!toDisplay(fields[F.swChecker])
      ).catch(() => null),
    ]);

    // Grace Period(Day): "SW Check" is both the claim flag (hide only
    // Claimed/Expired) and the displayed value. "SW Check" is a Formula
    // field, so its raw API value can come back as a segments array rather
    // than a plain string — hidden() needs toDisplay() first, or it never
    // matches "claimed"/"expired" and an actually-expired row can slip
    // through as "claimable" (this was the actual bug: an expired row got
    // picked over the real one, so the ticket ended up hidden entirely once
    // isClaimableValue saw "Expired" client-side).
    const graceRow = await findOldestClaimableRow(
      TABLE_GRACE_PERIOD, uname, brandVal,
      (fields) => !hidden(toDisplay(fields[F.swCheck]))
    ).catch(() => null);

    // Risk Player(Day): one field ("Status") encodes both which day-tier
    // applies (e.g. "7D 20% Reload") and whether there's anything to claim
    // at all ("1D No Bonus"/"3D No Bonus" mean no bonus, not just a claimed
    // one). Hide "No Bonus" tiers plus Claimed/Expired.
    const riskRow = await findOldestClaimableRow(
      TABLE_RISK_PLAYER, uname, brandVal,
      (fields) => {
        const status = String(toDisplay(fields[F.status]) || "").trim();
        return !!status && !/no bonus/i.test(status) && !hidden(status);
      }
    ).catch(() => null);

    // 12hour VIP Deposit Booster: only "Eligible" (exact) counts.
    const vipRow = await findOldestClaimableRow(
      TABLE_VIP_BOOSTER, uname, brandVal,
      (fields) => String(toDisplay(fields[F.status]) || "").trim().toLowerCase() === "eligible"
    ).catch(() => null);

    // Special Reload Event: only "Eligible Angpao" counts — the Free Spin
    // variant that used to live in this table is retired (kept for old
    // record history only), so it's intentionally not checked for here.
    const specialReloadRow = await findOldestClaimableRow(
      TABLE_SPECIAL_RELOAD, uname, brandVal,
      (fields) => String(toDisplay(fields[F.status]) || "").trim().toLowerCase() === "eligible angpao"
    ).catch(() => null);

    // Ang Pao + Redeem Code are separate tables — search them non-fatally
    // since their field names may differ or the tables may be empty/restructured.
    let angPaoRow = null;
    try {
      const angPaoMatches = await searchRecords(TABLE_ANG_PAO, [
        { field_name: F.usernameUid, operator: "is", value: [uname] },
        { field_name: F.brand, operator: "is", value: [brandVal] },
      ]);
      angPaoRow = angPaoMatches[angPaoMatches.length - 1] || null;
    } catch (_) { /* non-fatal */ }

    let redeemRow = null;
    try {
      const redeemMatches = (await searchRecords(TABLE_REDEEM_CODE, [
        { field_name: F.usernameUid, operator: "is", value: [uname] },
        { field_name: F.brand, operator: "is", value: [brandVal] },
      ])).filter((r) => !hidden(toDisplay(r.fields[F.status])));
      redeemRow = redeemMatches[redeemMatches.length - 1] || null;
    } catch (_) { /* non-fatal */ }

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
          topPnl: topPnlRow ? toDisplay(topPnlRow.fields[F.swCheck]) : "",
          ltvTest: ltvRow ? toDisplay(ltvRow.fields[F.swChecker]) : "",
          gracePeriod: graceRow ? toDisplay(graceRow.fields[F.swCheck]) : "",
          riskPlayer: riskRow ? toDisplay(riskRow.fields[F.status]) : "",
          vipBooster: vipRow ? "Eligible" : "",
          specialReload: specialReloadRow
            ? { recordId: specialReloadRow.record_id, status: toDisplay(specialReloadRow.fields[F.status]) }
            : null,
          angPao: angPaoRow
            ? { recordId: angPaoRow.record_id, status: toDisplay(angPaoRow.fields[F.status]), amount: toDisplay(angPaoRow.fields[F.angPaoAmount]) }
            : null,
          redeemCode: redeemRow
            ? { recordId: redeemRow.record_id, status: toDisplay(redeemRow.fields[F.status]) }
            : null,
        },
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
