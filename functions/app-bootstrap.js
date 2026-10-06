import { adapt } from "./_lib/adapt.js";
import { listFields, TABLE_CUSTOMER_APPROACHING } from "./_lib/lark.js";
import { listBonusConfigs } from "./_lib/bonus-config.js";

function optionNames(fields, fieldName, { sort = false } = {}) {
  const field = fields.find((item) => item.field_name === fieldName);
  const names = (field?.property?.options || []).map((option) => option.name).filter(Boolean);
  return sort ? names.sort((a, b) => a.localeCompare(b)) : names;
}

function publicBonus(config) {
  return {
    key: config.key,
    label: config.label,
    inquiry: config.inquiry,
    amountEligible: config.amountEligible,
  };
}

export async function handler(event = {}) {
  try {
    // Agent, Brand, Inquiry and Status are fields in the same table. Reading
    // its field catalog once avoids four identical Lark API calls on every
    // browser startup and periodic refresh.
    const fresh = event.queryStringParameters?.fresh === "1";
    const [fields, bonuses] = await Promise.all([
      listFields(TABLE_CUSTOMER_APPROACHING, undefined, { force: fresh }),
      listBonusConfigs({ fresh }),
    ]);
    // Brand and Agent Name always have options. An empty catalog means the read
    // was partial/failed -- say so, so the widget keeps the lists it already has.
    const brands = optionNames(fields, "Brand", { sort: true });
    const agents = optionNames(fields, "Agent Name", { sort: true });
    if (!brands.length || !agents.length) {
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: "Field catalog came back without Brand/Agent options." }) };
    }
    return {
      statusCode: 200,
      headers: { "Cache-Control": fresh ? "no-store" : "private, max-age=60" },
      body: JSON.stringify({
        ok: true,
        agents,
        brands,
        inquiries: optionNames(fields, "Inquiry"),
        statuses: optionNames(fields, "Status"),
        bonuses: bonuses.map(publicBonus),
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
}

export const onRequest = adapt(handler);
