import { adapt } from "./_lib/adapt.js";
import { createRecord, updateRecord, deleteRecord, listFields, toDisplay, TABLE_HALLOWEEN } from "./_lib/lark.js";
import {
  F, brandKey, normalizeTier, readProgress, readTopups, malaysiaToday, testDateFor, planClaim, planUnclaim, checkFields, shapeFields,
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
const hasValue = (value) => value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && !value.length);
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
    // Always the dropdown's form ("EZ"), whatever spelling arrives ("ez", "EZ96"), so one player can never get two rows.
    const brand = brandKey(text(body.brand, 40));
    if (!username || !brand) return reply(400, { ok: false, error: "username and brand are required" });
    if (!check.ok) return reply(200, { ok: false, error: `The Halloween table is not set up correctly (${describeCheck(check)}).`, fieldCheck: check });

    const nowMs = Date.now();
    const today = malaysiaToday(nowMs, testDateFor(event.env, event.headers));
    const dryRun = body.preview === true;
    const [row, maps] = await Promise.all([readHalloweenRow(username, brand), readOptionMaps()]);

    if (body.action === "unclaim") {
      // An admin-preview claim never wrote anything, so undoing it has nothing to check or change.
      if (dryRun) return reply(200, { ok: true, dryRun: true });
      const plan = planUnclaim({ day: Number(body.day), row, maps, agent: clean(body.agentName, 120), chatLink: clean(body.chatLink, 500) });
      if (!plan.ok) return reply(200, { ok: false, error: plan.error, ...(plan.notOwner ? { notOwner: true } : {}) });
      if (plan.kind === "none") return reply(200, { ok: true, undone: Number(body.day), alreadyUndone: true });
      // Undo the latest Day 1 top-up only (the plan already checked it is this agent's, from this chat).
      if (plan.kind === "topup") {
        const shaped = shapeFields({ ...plan.fields, ...(plan.topups ? { [F.day1Topups]: plan.topups } : {}) }, catalog);
        for (const name of plan.clear) shaped[name] = null;
        await updateRecord(TABLE_HALLOWEEN, row.record_id, shaped);
        return reply(200, { ok: true, undone: 1, topupUndone: true, amount: plan.amount, fromDeposit: plan.fromDeposit, toDeposit: plan.toDeposit });
      }
      // Only the agent who made the latest claim, from the same chat, may undo it. This stops mistakes (a wrong chat, an
      // old case); it is not security, because the API has no login yet. A row with no saved claimant can be undone by anyone.
      const savedAgent = toDisplay(row.fields[F.agent]).trim();
      const savedChat = toDisplay(row.fields[F.chatLink]).trim();
      if ((savedAgent || savedChat) && !sameClaimant(row.fields, clean(body.agentName, 120), clean(body.chatLink, 500))) {
        return reply(200, {
          ok: false, notOwner: true,
          error: `Only ${savedAgent || "the agent who claimed it"}, in the chat where it was claimed, can undo Day ${Number(body.day)}. Ask them, or change the row in Lark.`,
        });
      }
      if (plan.kind === "delete") await deleteRecord(TABLE_HALLOWEEN, row.record_id);
      // The saved agent and chat belong to the day being undone; clearing them lets the earlier day be undone next.
      else await updateRecord(TABLE_HALLOWEEN, row.record_id, Object.fromEntries([...plan.clear, F.agent, F.chatLink].map((name) => [name, null])));
      return reply(200, { ok: true, undone: Number(body.day) });
    }

    // A Day 1 top-up, Day 2 and Day 3 use the tier saved on Day 1, so the P&L table is only read when that is missing.
    const savedTier = row ? normalizeTier(readProgress(row.fields, maps).tier) : "";
    const tierText = savedTier || await readPlayerTier(username, brand);
    const plan = planClaim({
      brand, tierText, row, today, nowMs, maps,
      input: { day: body.day, choice: body.choice, deposit: body.deposit, shared: body.shared === true, shareMethod: body.shareMethod, postLink: body.postLink },
      agent: body.agentName, chatLink: body.chatLink,
    });
    if (!plan.ok) return reply(200, { ok: false, error: plan.error });

    const values = plan.kind === "create" ? { [F.uid]: username, [F.brand]: brand, ...plan.fields } : plan.fields;
    const summary = {
      day: plan.day, amount: plan.amount, tier: plan.tier, shared: plan.shared, base: plan.base, track: plan.track, choice: plan.choice, deposit: plan.deposit,
      ...(plan.topup ? { topup: true, total: plan.total, previousDeposit: plan.previousDeposit, previousBonus: plan.previousBonus } : {}),
    };
    if (dryRun) return reply(200, { ok: true, dryRun: true, ...summary, fields: values });

    const shaped = shapeFields(values, catalog);
    const agent = clean(body.agentName, 120);
    const chatLink = clean(body.chatLink, 500);
    const delays = settleDelays(event.env);
    const lost = () => reply(200, { ok: false, error: `This player's Day ${plan.day} was claimed a moment ago by someone else.` });
    const undone = () => reply(200, { ok: false, error: "This player's Day 1 was undone a moment ago. Look up the player again." });

    if (plan.kind === "update") {
      try {
        await updateRecord(TABLE_HALLOWEEN, row.record_id, shaped);
      } catch (error) {
        // The row was removed between our read and our write: someone undid this player's Day 1 at that moment.
        if (/RecordIdNotFound|record.{0,20}not.{0,10}found|1254043/i.test(`${error?.code} ${error?.larkMsg} ${error?.message}`)) return undone();
        throw error;
      }
      // Two agents claiming the same day at the same moment both pass the check above. The later write is the one that
      // stays in the row, so whoever is still named in it once the writes have settled owns the claim; the other is refused.
      // An undo of an earlier day can land at the same moment too: a claim never stays on top of a day that was undone.
      for (const wait of delays) {
        await sleep(wait);
        const current = await retry(() => readHalloweenRow(username, brand)).catch(() => undefined);
        if (current === null) return undone();
        if (!current) continue;
        // Checked first: an undo of Day 2 also clears the saved agent, and Day 3 must never stay on top of an undone Day 2.
        if (plan.day === 3 && !hasValue(current.fields[F.day2Claimed])) {
          await retry(() => updateRecord(TABLE_HALLOWEEN, row.record_id, { [F.day3Base]: null, [F.day3Share]: null, [F.day3Claimed]: null }))
            .catch((error) => console.warn("Halloween Day 3 not reverted", row.record_id, String(error?.message || error).slice(0, 100)));
          return reply(200, { ok: false, error: "Day 2 was undone a moment ago, so Day 3 is not available. Look up the player again." });
        }
        // A top-up keeps the first claim's agent: it owns the claim while its own line is still the latest one.
        if (plan.topup) {
          const latest = readTopups(readProgress(current.fields, maps).day1Topups).at(-1);
          if (latest?.line !== plan.line) return reply(200, { ok: false, error: "Another top-up for this player was claimed a moment ago. Look up the player again." });
          continue;
        }
        if ((agent || chatLink) && !sameClaimant(current.fields, agent, chatLink)) return lost();
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
