const {
  searchRecords,
  createRecord,
  toDisplay,
  TABLE_CUSTOMER_APPROACHING,
  TABLE_ANG_PAO,
  TABLE_REDEEM_CODE,
} = require("./lib/lark");

// Field names — must match Lark exactly (case-sensitive). Customer Approaching
// uses "Username"; Ang Pao / Redeem Code use "Username/UID" instead.
const F = {
  username: "Username",
  usernameUid: "Username/UID",
  brand: "Brand",
  pic: "PIC",
  tier: "Tier",
  nameCustomer: "Name customer",
  dob: "Player D.O.B",
  riskPlayer: "Risk Player",
  topPnl: "Top 10 P&L - Test",
  gracePeriod: "Grace Period 0.1",
  ltvTest: "LTV - Test",
  vipBooster: "12h VIP Deposit Booster",
  status: "Status",
  angPaoAmount: "Ang Pao Claim",
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

exports.handler = async function (event) {
  try {
    const { username, brand, link, telegram } = JSON.parse(event.body || "{}");
    if (!username || !brand) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "username and brand are required" }) };
    }
    const uname = username.trim();
    const brandVal = brand.trim();

    let caMatches = await searchRecords(TABLE_CUSTOMER_APPROACHING, [
      { field_name: F.username, operator: "is", value: [uname] },
      { field_name: F.brand, operator: "is", value: [brandVal] },
    ]);

    // The bonus lookup columns (Risk Player, Grace Period, etc.) only
    // populate once a row exists for this Username+Brand — so if there's no
    // row yet, create the minimal "log" entry first, then re-read it.
    let justCreated = false;
    if (!caMatches.length) {
      await createRecord(TABLE_CUSTOMER_APPROACHING, {
        [F.username]: uname,
        [F.brand]: brandVal,
        "link": link || "",
        "Telegram": !!telegram,
      });
      justCreated = true;
      await wait(1200); // give Lark a moment to resolve any linked lookups
      caMatches = await searchRecords(TABLE_CUSTOMER_APPROACHING, [
        { field_name: F.username, operator: "is", value: [uname] },
        { field_name: F.brand, operator: "is", value: [brandVal] },
      ]);
    }

    // Username-only search (no brand filter) so we can tell CS "found under a
    // different brand" instead of a flat "not found" when they're in the wrong chat.
    const caUsernameOnly = await searchRecords(TABLE_CUSTOMER_APPROACHING, [
      { field_name: F.username, operator: "is", value: [uname] },
    ]);
    const otherBrands = [...new Set(
      caUsernameOnly
        .map((r) => toDisplay(r.fields[F.brand]))
        .filter((b) => b && b.toUpperCase() !== brandVal.toUpperCase())
    )];

    if (!caMatches.length) {
      // Shouldn't normally happen since we just created it, but guard anyway.
      return { statusCode: 200, body: JSON.stringify({ ok: true, row: null, otherBrands }) };
    }

    const caRow = caMatches[caMatches.length - 1];
    const f = caRow.fields;

    const angPaoMatches = await searchRecords(TABLE_ANG_PAO, [
      { field_name: F.usernameUid, operator: "is", value: [uname] },
      { field_name: F.brand, operator: "is", value: [brandVal] },
    ]);
    const angPaoRow = angPaoMatches[angPaoMatches.length - 1] || null;

    const redeemMatches = await searchRecords(TABLE_REDEEM_CODE, [
      { field_name: F.usernameUid, operator: "is", value: [uname] },
      { field_name: F.brand, operator: "is", value: [brandVal] },
    ]);
    const redeemRow = redeemMatches[redeemMatches.length - 1] || null;

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        otherBrands,
        justCreated,
        caRecordId: caRow.record_id, // needed later so "Record to Lark Base" UPDATES this same row
        row: {
          pic: toDisplay(f[F.pic]),
          tier: toDisplay(f[F.tier]),
          nameCustomer: toDisplay(f[F.nameCustomer]),
          dob: toDisplay(f[F.dob]),
          riskPlayer: toDisplay(f[F.riskPlayer]),
          topPnl: toDisplay(f[F.topPnl]),
          gracePeriod: toDisplay(f[F.gracePeriod]),
          ltvTest: toDisplay(f[F.ltvTest]),
          vipBooster: toDisplay(f[F.vipBooster]),
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
