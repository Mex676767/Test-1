const {
  searchRecords, createRecord, getRecord, toDisplay,
  TABLE_CUSTOMER_APPROACHING, TABLE_ANG_PAO, TABLE_REDEEM_CODE,
} = require("./lib/lark");

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
    const { username, brand, picName } = JSON.parse(event.body || "{}");
    if (!username || !brand) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "username and brand are required" }) };
    }
    const uname = username.trim();
    const brandVal = brand.trim();

    // Always create a fresh record — each Look Up is a new case.
    // Brand must be set at create time, not deferred to the Record step:
    // the bonus Lookup columns (Grace Period, LTV, etc.) only resolve when
    // BOTH Username and Brand match the linked table's reference row. The
    // earlier UserFieldConvFail was caused by also sending PIC (a Person
    // field) here — PIC is left alone now, so Brand (a Single Select field)
    // is safe to send as a plain string.
    const created = await createRecord(TABLE_CUSTOMER_APPROACHING, {
      [F.username]: uname,
      [F.brand]: brandVal,
    });

    const caRecordId = created.record_id;
    await wait(1500);
    const freshRecord = await getRecord(TABLE_CUSTOMER_APPROACHING, caRecordId);
    const f = freshRecord.fields;

    // Warn CS if username exists under other brands
    const caUsernameOnly = await searchRecords(TABLE_CUSTOMER_APPROACHING, [
      { field_name: F.username, operator: "is", value: [uname] },
    ]);
    const otherBrands = [...new Set(
      caUsernameOnly
        .map((r) => toDisplay(r.fields[F.brand]))
        .filter((b) => b && b.toUpperCase() !== brandVal.toUpperCase())
    )];

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
      const redeemMatches = await searchRecords(TABLE_REDEEM_CODE, [
        { field_name: F.usernameUid, operator: "is", value: [uname] },
        { field_name: F.brand, operator: "is", value: [brandVal] },
      ]);
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
