import { adapt } from "./_lib/adapt.js";
import { createRecord, updateRecord, deleteRecord, listFields, TABLE_HALLOWEEN } from "./_lib/lark.js";
import {
  F, malaysiaToday, planClaim, planUnclaim, checkFields, shapeFields,
} from "./_lib/halloween.js";
import { readHalloweenRow, readPlayerTier, readOptionMaps } from "./_lib/halloween-io.js";

const reply = (statusCode, body) => ({ statusCode, headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
const clean = (value, max = 200) => String(value ?? "").trim().slice(0, max);

function describeCheck(check) {
  const parts = [];
  if (check.missing.length) parts.push(`missing fields: ${check.missing.join(", ")}`);
  if (check.wrongType.length) parts.push(`wrong field type: ${check.wrongType.map((item) => item.field).join(", ")}`);
  if (check.missingOptions.length) parts.push(`missing options: ${check.missingOptions.map((item) => `${item.field}=${item.option}`).join(", ")}`);
  return parts.join("; ");
}

// GET  -> checks the Lark table has every field and option the code writes.
// POST -> { action: "claim" | "unclaim", username, brand, day, ... }. `preview: true` checks everything but writes nothing.
export async function handler(event) {
  try {
    if (!TABLE_HALLOWEEN) return reply(200, { ok: false, notConfigured: true, error: "LARK_TABLE_HALLOWEEN is not set." });
    const catalog = await listFields(TABLE_HALLOWEEN, undefined, { force: event.httpMethod === "GET" });
    const check = checkFields(catalog);

    if (event.httpMethod === "GET") return reply(200, { ok: true, matches: check.ok, missing: check.missing, wrongType: check.wrongType, missingOptions: check.missingOptions, fieldCount: catalog.length });
    if (event.httpMethod !== "POST") return reply(405, { ok: false, error: "Method not allowed" });

    const body = JSON.parse(event.body || "{}");
    const username = clean(body.username).toLowerCase();
    const brand = clean(body.brand, 40);
    if (!username || !brand) return reply(400, { ok: false, error: "username and brand are required" });
    if (!check.ok) return reply(200, { ok: false, error: `The Halloween table is not set up correctly (${describeCheck(check)}).`, fieldCheck: check });

    const nowMs = Date.now();
    const today = malaysiaToday(nowMs, event.env?.HALLOWEEN_TEST_DATE);
    const dryRun = body.preview === true;
    const [row, maps] = await Promise.all([readHalloweenRow(username, brand), readOptionMaps()]);

    if (body.action === "unclaim") {
      const plan = planUnclaim({ day: Number(body.day), row, maps });
      if (!plan.ok) return reply(200, { ok: false, error: plan.error });
      if (dryRun) return reply(200, { ok: true, dryRun: true, kind: plan.kind });
      if (plan.kind === "none") return reply(200, { ok: true, undone: Number(body.day), alreadyUndone: true });
      if (plan.kind === "delete") await deleteRecord(TABLE_HALLOWEEN, row.record_id);
      else await updateRecord(TABLE_HALLOWEEN, row.record_id, Object.fromEntries(plan.clear.map((name) => [name, null])));
      return reply(200, { ok: true, undone: Number(body.day) });
    }

    const tierText = await readPlayerTier(username, brand);
    const plan = planClaim({
      brand, tierText, row, today, nowMs, maps,
      input: { day: body.day, choice: body.choice, deposit: body.deposit, shared: body.shared === true, shareMethod: body.shareMethod, postLink: body.postLink },
      agent: body.agentName, chatLink: body.chatLink,
    });
    if (!plan.ok) return reply(200, { ok: false, error: plan.error });

    const values = plan.kind === "create" ? { [F.uid]: username, [F.brand]: brand, ...plan.fields } : plan.fields;
    const summary = { day: plan.day, amount: plan.amount, tier: plan.tier, shared: plan.shared, base: plan.base, track: plan.track, choice: plan.choice };
    if (dryRun) return reply(200, { ok: true, dryRun: true, ...summary, fields: values });

    const shaped = shapeFields(values, catalog);
    if (plan.kind === "update") {
      await updateRecord(TABLE_HALLOWEEN, row.record_id, shaped);
      return reply(200, { ok: true, ...summary, recordId: row.record_id });
    }

    const created = await createRecord(TABLE_HALLOWEEN, shaped);
    const oldest = await readHalloweenRow(username, brand).catch(() => null);
    if (oldest && oldest.record_id !== created.record_id) {
      await deleteRecord(TABLE_HALLOWEEN, created.record_id).catch(() => { });
      return reply(200, { ok: false, error: "This player's Day 1 was claimed a moment ago by someone else." });
    }
    return reply(200, { ok: true, ...summary, recordId: created.record_id });
  } catch (err) {
    return reply(500, { ok: false, error: err.message });
  }
}

export const onRequest = adapt(handler);
