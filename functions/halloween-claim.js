import { adapt } from "./_lib/adapt.js";
import { createRecord, updateRecord, deleteRecord, listFields, toDisplay, TABLE_HALLOWEEN } from "./_lib/lark.js";
import {
  F, malaysiaToday, planClaim, planUnclaim, checkFields, shapeFields,
} from "./_lib/halloween.js";
import { readHalloweenRow, readPlayerTier, readOptionMaps } from "./_lib/halloween-io.js";

const reply = (statusCode, body) => ({ statusCode, headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
const clean = (value, max = 200) => String(value ?? "").trim().slice(0, max);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Pauses (ms) between the re-checks after a write; Lark's search can lag a little behind its writes.
const settleDelays = (env) => String(env?.HALLOWEEN_SETTLE_MS ?? "700,800").split(",").map((n) => Math.max(0, Number(n) || 0));
// Lark can fail a call at random: the re-checks and the cleanup are what stop double claims, so they get a few tries.
async function retry(work, tries = 4) {
  let last;
  for (let attempt = 0; attempt < tries; attempt++) {
    try { return await work(); } catch (error) { last = error; await sleep(30 * (attempt + 1)); }
  }
  throw last;
}
const sameClaimant = (fields, agent, chatLink) => toDisplay(fields?.[F.agent]).trim() === agent && toDisplay(fields?.[F.chatLink]).trim() === chatLink;

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

    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (_) { return reply(400, { ok: false, error: "The request was not valid JSON." }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { ok: false, error: "The request body must be a JSON object." });
    const text = (value, max) => (typeof value === "string" || typeof value === "number" ? clean(value, max) : "");
    const username = text(body.username, 200).toLowerCase();
    const brand = text(body.brand, 40);
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
    const summary = { day: plan.day, amount: plan.amount, tier: plan.tier, shared: plan.shared, base: plan.base, track: plan.track, choice: plan.choice, deposit: plan.deposit };
    if (dryRun) return reply(200, { ok: true, dryRun: true, ...summary, fields: values });

    const shaped = shapeFields(values, catalog);
    const agent = clean(body.agentName, 120);
    const chatLink = clean(body.chatLink, 500);
    const delays = settleDelays(event.env);
    const lost = () => reply(200, { ok: false, error: `This player's Day ${plan.day} was claimed a moment ago by someone else.` });

    if (plan.kind === "update") {
      await updateRecord(TABLE_HALLOWEEN, row.record_id, shaped);
      // Two agents claiming the same day at the same moment both pass the check above. The later write is the one that
      // stays in the row, so whoever is still named in it once the writes have settled owns the claim; the other is refused.
      if (agent || chatLink) {
        for (const wait of delays) {
          await sleep(wait);
          const current = await retry(() => readHalloweenRow(username, brand)).catch(() => null);
          if (current && !sameClaimant(current.fields, agent, chatLink)) return lost();
        }
      }
      return reply(200, { ok: true, ...summary, recordId: row.record_id });
    }

    const created = await createRecord(TABLE_HALLOWEEN, shaped);
    // Lark's search can lag behind its writes, so look again a couple of times: the oldest row stays, the others remove themselves.
    for (const wait of delays) {
      await sleep(wait);
      const oldest = await retry(() => readHalloweenRow(username, brand)).catch(() => null);
      if (oldest && oldest.record_id !== created.record_id) {
        await retry(() => deleteRecord(TABLE_HALLOWEEN, created.record_id)).catch((error) => console.warn("Halloween duplicate row not removed", created.record_id, String(error?.message || error).slice(0, 100)));
        return lost();
      }
    }
    return reply(200, { ok: true, ...summary, recordId: created.record_id });
  } catch (err) {
    return reply(500, { ok: false, error: err.message });
  }
}

export const onRequest = adapt(handler);
