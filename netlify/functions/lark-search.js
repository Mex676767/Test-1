const {
  searchRecords, createRecord, toDisplay,
  TABLE_CUSTOMER_APPROACHING, TABLE_ANG_PAO, TABLE_REDEEM_CODE,
} = require("./lib/lark");

const F = {
  username: "Username",
  usernameUid: "Username/UID",
  brand: "Brand",
  agentName: "Agent Name",
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
    const { username, brand, picName } = JSON.parse(event.body || "{}");
    if (!username || !brand) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "username and brand are required" }) };
    }
    const uname = username.trim();
    const brandVal = brand.trim();
    const agentVal = (picName || "").trim();

    // Always create a fresh record — each Look Up is a new case.
    // Brand must be set at create time, not deferred to the Record step:
    // the bonus Lookup columns (Grace Period, LTV, etc.) only resolve when
    // BOTH Username and Brand match the linked table's reference row. The
    // earlier UserFieldConvFail was caused by also sending PIC (a Person
    // field) here — PIC is left alone now, so Brand (a Single Select field)
    // is safe to send as a plain string.
    // Agent Name (a plain Text field) is stamped now too — the agent is
    // already chosen before Look Up can even run (app.js blocks it
    // otherwise), so there's no reason to leave the row unattributed until
    // the final Record step. lark-record.js still writes it again at submit
    // in case the agent changes their name mid-case.
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

    // Note: the gold-ticket bonus columns (pic/tier/nameCustomer/dob and the
    // 5 bonus Lookups) are NOT read here. On a large base, Lark can take
    // 15-30s to resolve a freshly-created row's Lookup fields — far past
    // Netlify's 10s function limit — so we return the record immediately and
    // let the frontend poll lark-poll.js on its own schedule until they're
    // ready (signaled by "Name customer" becoming non-empty).
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        otherBrands,
        justCreated: true,
        pending: true,
        caRecordId,
        row: {
          pic: "", tier: "", nameCustomer: "", dob: "",
          riskPlayer: "", topPnl: "", gracePeriod: "", ltvTest: "", vipBooster: "",
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
