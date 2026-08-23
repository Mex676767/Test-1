const { createRecord, TABLE_CUSTOMER_APPROACHING } = require("./lib/lark");

// Called on "Record to Lark Base" — inserts one new case-log row. NOTE:
// field names below must match the Customer Approaching table's columns
// exactly (case-sensitive). If Lark returns an error naming a field, that's
// almost always a mismatch between this list and the real column name.
exports.handler = async function (event) {
  try {
    const body = JSON.parse(event.body || "{}");
    const { username, nameCustomer, brand, inquiry, status, link, telegram, releasedAmount, claimSecret } = body;

    if (!username || !brand || !inquiry || !inquiry.length || !status) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Missing required fields" }) };
    }

    const fields = {
      "Username": username,
      "Name customer": nameCustomer || "",
      "Brand": brand,
      "Inquiry": inquiry, // multi-select field expects an array
      "Status": status,
      "link": link || "",
      "Telegram": !!telegram,
      "Released amount": releasedAmount || "",
      "Claim Secret": !!claimSecret,
    };

    const record = await createRecord(TABLE_CUSTOMER_APPROACHING, fields);
    return { statusCode: 200, body: JSON.stringify({ ok: true, record }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
