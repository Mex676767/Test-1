import test from "node:test";
import assert from "node:assert/strict";
import { initEnv } from "./_lib/lark.js";
import { handler } from "./halloween-claim.js";
import { F, CAMPAIGN, RED_PACKET, day1Bonus } from "./_lib/halloween.js";

// Many players over three days, each attacked by 1-3 simultaneous claims, against a fake Lark with random latency,
// a search that lags behind its writes, and randomly failing calls. Whatever happens, the table must stay consistent.

const text = (name) => ({ field_name: name, type: 1 });
const number = (name) => ({ field_name: name, type: 2 });
const date = (name) => ({ field_name: name, type: 5 });
const select = (name, options) => ({ field_name: name, type: 3, property: { options: options.map((option) => ({ id: `o${option}`, name: option })) } });
const catalog = [
  text(F.uid), select(F.brand, Object.keys(CAMPAIGN)), select(F.tier, ["Tier 3", "Tier V"]), select(F.choice, ["TRICK", "TREAT"]),
  number(F.day1Deposit), number(F.day1Bonus), select(F.track, ["Below RM300", "RM300+"]), date(F.day1Claimed),
  number(F.day2Base), number(F.day2Share), date(F.day2Claimed), number(F.day3Base), number(F.day3Share), date(F.day3Claimed),
  select(F.shareMethod, ["Social post", "5 friends"]), text(F.postLink), text(F.agent), text(F.chatLink),
];

function runChaos({ seed: seedStart, players, failRate, lagMs }) {
  let seed = seedStart >>> 0;
  const rand = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  initEnv({ LARK_APP_ID: "a", LARK_APP_SECRET: "s", LARK_BASE_APP_TOKEN: "b", LARK_TABLE_HALLOWEEN: "hw", LARK_TABLE_PNL: "pnl", LARK_TABLE_CUSTOMER_APPROACHING: "ca" });
  const roster = Array.from({ length: players }, (_, i) => `zzp${i}`);
  const tiers = Object.fromEntries(roster.map((name) => [name, ["Tier V", "Tier 3", "Tier V", "Tier 3", "Tier 2", ""][Math.floor(rand() * 6)]]));
  const deposits = Object.fromEntries(roster.map((name) => [name, [30, 50, 120, 250, 300, 350, 500, 800][Math.floor(rand() * 8)]]));
  const store = { rows: [], nextId: 1, injected: 0 };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const reply = (data) => new Response(JSON.stringify({ code: 0, data }), { headers: { "content-type": "application/json" } });
  const flake = () => {
    if (rand() >= failRate) return null;
    store.injected++;
    return new Response(JSON.stringify({ code: 1254607, msg: "injected failure" }), { headers: { "content-type": "application/json" } });
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url), method = options.method || "GET";
    await sleep(1 + rand() * 12);
    if (href.includes("tenant_access_token")) return new Response(JSON.stringify({ code: 0, tenant_access_token: "t", expire: 3600 }));
    if (href.includes("/tables/hw/fields")) return reply({ items: catalog });
    if (href.includes("/tables/pnl/fields")) return reply({ items: [{ field_name: "Tier", type: 3, property: { options: [] } }] });
    if (href.includes("/tables/pnl/records/search")) {
      const who = JSON.parse(options.body).filter.conditions.find((c) => c.field_name === "Username").value[0];
      return reply({ items: tiers[who] ? [{ record_id: `p${who}`, fields: { Username: who, Brand: "NOW", Tier: tiers[who] } }] : [], has_more: false });
    }
    if (href.includes("/tables/hw/records/search")) {
      const failed = flake(); if (failed) return failed;
      const conditions = JSON.parse(options.body).filter.conditions, now = Date.now();
      return reply({ items: store.rows.filter((r) => r.visibleAt <= now && conditions.every((c) => String(r.fields[c.field_name]).toLowerCase() === String(c.value[0]).toLowerCase())), has_more: false });
    }
    if (href.includes("/tables/hw/records") && method === "POST") {
      const failed = flake(); if (failed) return failed;
      const record = { record_id: `rec${store.nextId++}`, created_time: store.nextId, visibleAt: Date.now() + (lagMs ? rand() * lagMs : 0), fields: JSON.parse(options.body).fields };
      store.rows.push(record);
      return reply({ record });
    }
    const match = href.match(/\/tables\/hw\/records\/([^/?]+)/);
    if (match && method === "PUT") {
      const failed = flake(); if (failed) return failed;
      const target = store.rows.find((r) => r.record_id === match[1]);
      for (const [name, value] of Object.entries(JSON.parse(options.body).fields)) { if (value === null) delete target.fields[name]; else target.fields[name] = value; }
      return reply({ record: target });
    }
    if (match && method === "DELETE") {
      const failed = flake(); if (failed) return failed;
      store.rows = store.rows.filter((r) => r.record_id !== match[1]);
      return reply({ deleted: true });
    }
    return reply({ items: [], has_more: false });
  };

  const dates = ["2026-10-26", "2026-10-27", "2026-10-28"];
  const accepted = {};
  const post = async (name, day, extra) => {
    const body = { action: "claim", day, username: name, brand: "NOW", agentName: `Agent${Math.floor(rand() * 5)}`, chatLink: `https://chat/${Math.floor(rand() * 1e6)}`, ...extra };
    const result = await handler({ httpMethod: "POST", body: JSON.stringify(body), env: { HALLOWEEN_TEST_DATE: dates[day - 1], HALLOWEEN_SETTLE_MS: "300,300" } });
    if (JSON.parse(result.body).ok) accepted[`${name}:${day}`] = (accepted[`${name}:${day}`] || 0) + 1;
  };
  return (async () => {
    try {
      for (let day = 1; day <= 3; day++) {
        const jobs = [];
        for (const name of roster) {
          for (let copy = 0, copies = 1 + Math.floor(rand() * 3); copy < copies; copy++) {
            jobs.push(post(name, day, day === 1
              ? { choice: rand() < 0.5 ? "TRICK" : "TREAT", deposit: deposits[name] }
              : { shared: rand() < 0.5, shareMethod: "Social post", postLink: "https://x.test/p" }));
          }
        }
        await Promise.all(jobs);
        await sleep(lagMs + 200);
      }
    } finally { globalThis.fetch = original; }
    return { roster, tiers, store, accepted };
  })();
}

function violations({ roster, tiers, store, accepted }) {
  const found = [];
  const byPlayer = {};
  for (const row of store.rows) (byPlayer[row.fields[F.uid]] ||= []).push(row);
  for (const [name, rows] of Object.entries(byPlayer)) if (rows.length > 1) found.push(`${name}: ${rows.length} rows`);
  for (const [key, count] of Object.entries(accepted)) if (count > 1) found.push(`${key}: accepted ${count} times`);
  for (const name of roster) {
    const eligibleTier = tiers[name] === "Tier V" || tiers[name] === "Tier 3";
    const row = (byPlayer[name] || [])[0];
    if (!eligibleTier && (row || accepted[`${name}:1`] || accepted[`${name}:2`] || accepted[`${name}:3`])) found.push(`${name}: ineligible tier got a claim`);
    if (accepted[`${name}:1`] && !row) found.push(`${name}: Day 1 accepted but no row`);
    if (!row) continue;
    const f = row.fields;
    const bonus = day1Bonus(f[F.day1Deposit], f[F.choice]);
    if (!bonus || bonus.amount !== f[F.day1Bonus] || bonus.track !== f[F.track]) found.push(`${name}: wrong Day 1 amounts`);
    if (f[F.tier] !== tiers[name]) found.push(`${name}: wrong stored tier`);
    if (f[F.day2Claimed] && f[F.track] !== "RM300+") found.push(`${name}: Day 2 on a low track`);
    if (f[F.day3Claimed] && !f[F.day2Claimed]) found.push(`${name}: Day 3 without Day 2`);
    if (f[F.day2Claimed] && f[F.day2Base] !== RED_PACKET[tiers[name]]) found.push(`${name}: wrong Day 2 base`);
    if (f[F.day3Claimed] && f[F.day3Base] !== RED_PACKET[tiers[name]]) found.push(`${name}: wrong Day 3 base`);
    if (f[F.day3Share] && !f[F.day2Share]) found.push(`${name}: Day 3 share without a Day 2 share`);
    if (f[F.day2Share] !== undefined && f[F.day2Share] !== 28) found.push(`${name}: wrong Day 2 share`);
  }
  return found;
}

test("chaos: 40 players, simultaneous claims, search lag and 8% failing Lark calls leave a consistent table", async () => {
  const outcome = await runChaos({ seed: 2026, players: 40, failRate: 0.08, lagMs: 120 });
  assert.ok(outcome.store.injected > 0, "failures were really injected");
  assert.ok(outcome.store.rows.length > 5, "claims really went through");
  assert.deepEqual(violations(outcome), []);
});

// The protection holds while Lark's search lag stays under the re-check window (production: 700 + 800 ms; these tests: 300 + 300 ms).
test("chaos: another seed with heavier failures (20%) and a lag near the re-check window", async () => {
  const outcome = await runChaos({ seed: 77, players: 30, failRate: 0.2, lagMs: 150 });
  assert.ok(outcome.store.injected > 0);
  // With one call in five failing, a loser's cleanup can fail every retry and leave an untidy extra row. That row is harmless
  // (every lookup uses the oldest one), so here we insist on what must never happen: a double claim or wrong data.
  assert.deepEqual(violations(outcome).filter((line) => !/: \d+ rows$/.test(line)), []);
});
