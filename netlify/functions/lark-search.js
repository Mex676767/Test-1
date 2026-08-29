const {
  searchRecords, createRecord, toDisplay, getFieldOptionMap, findOldestClaimableRow,
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
  return t === "claimed" || t === "expired";
}

exports.handler = async function (event) {
  try {
    const { username, brand, picName } = JSON.parse(event.body || "{}");
    if (!username || !brand) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "username and brand are required" }) };
    }
    const uname = username.trim();
    const brandVal = brand.trim();
    const agentVal = (picName || "").trim();

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
    // Brand match) — not from Customer Approaching's Tier Lookup.
    let tier = "";
    try {
      if (TABLE_PNL) {
        const pnlMatches = await searchRecords(TABLE_PNL, [
          { field_name: F.username, operator: "is", value: [uname] },
          { field_name: F.brand, operator: "is", value: [brandVal] },
        ]);
        if (pnlMatches.length) {
          const tierMap = await getFieldOptionMap(TABLE_PNL, F.tier);
          tier = toDisplay(pnlMatches[0].fields[F.tier], tierMap);
        }
      }
    } catch (_) { /* non-fatal — tier just shows blank */ }

    // Top 10 P&L(Night): "Claimed Copy" checkbox is the claim flag
    // (unticked = still claimable); displayed value is "SW Check".
    const [topPnlRow, ltvRow] = await Promise.all([
      findOldestClaimableRow(
        TABLE_TOP_PNL_NIGHT, uname, brandVal,
        (fields) => fields[F.claimedCopy] !== true && !!toDisplay(fields[F.swCheck])
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
    // Claimed/Expired) and the displayed value.
    const graceRow = await findOldestClaimableRow(
      TABLE_GRACE_PERIOD, uname, brandVal,
      (fields) => !hidden(fields[F.swCheck])
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
