const {
  searchRecords,
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

exports.handler = async function (event) {
  try {
    const { username, brand } = JSON.parse(event.body || "{}");
    if (!username || !brand) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "username and brand are required" }) };
    }
    const uname = username.trim();
    const brandVal = brand.trim();

    const caMatches = await searchRecords(TABLE_CUSTOMER_APPROACHING, [
      { field_name: F.username, operator: "is", value: [uname] },
      { field_name: F.brand, operator: "is", value: [brandVal] },
    ]);

    // Username-only search (no brand filter) so we can tell CS "found under a
    // different brand" instead of a flat "not found" when they're in the wrong chat.
    const caUsernameOnly = await searchRecords(TABLE_CUSTOMER_APPROACHING, [
      { field_name: F.username, operator: "is", value: [uname] },
    ]);
    const otherBrands = [...new Set(
      caUsernameOnly
        .map((r) => r.fields[F.brand])
        .filter((b) => b && String(b).toUpperCase() !== brandVal.toUpperCase())
        .map(String)
    )];

    if (!caMatches.length) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, row: null, otherBrands }) };
    }

    // If several historical rows exist for this username+brand, the most
    // recently created one reflects current state.
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
        row: {
          pic: f[F.pic] || "",
          tier: f[F.tier] || "",
          nameCustomer: f[F.nameCustomer] || "",
          dob: f[F.dob] || "",
          riskPlayer: f[F.riskPlayer] || "",
          topPnl: f[F.topPnl] || "",
          gracePeriod: f[F.gracePeriod] || "",
          ltvTest: f[F.ltvTest] || "",
          vipBooster: f[F.vipBooster] || "",
          angPao: angPaoRow
            ? { recordId: angPaoRow.record_id, status: angPaoRow.fields[F.status] || "", amount: angPaoRow.fields[F.angPaoAmount] }
            : null,
          redeemCode: redeemRow
            ? { recordId: redeemRow.record_id, status: redeemRow.fields[F.status] || "" }
            : null,
        },
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
