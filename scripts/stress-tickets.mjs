#!/usr/bin/env node
// Stress test of the ticket integration with FAKES ONLY: nothing is sent to the real ticket system, LiveChat or Lark.
//
//   node scripts/stress-tickets.mjs                      # 5..50 agents, shared and no-cache modes
//   node scripts/stress-tickets.mjs --agents 12 --minutes 8 --mode none --seed 3
//
// It runs the real Functions (ticket-list, ticket-status, ticket-update, ticket-create, ticket-comment, ticket-config) against a fake ticket API
// that enforces the real limit (120 requests a minute per API key, answering 429 with Retry-After) on a virtual clock, with N simulated agents
// that behave like the widget: the bell poll every 15 s (own tickets every poll, everyone's newest every fourth), an open ticket every 8 s
// (a share of the agents have one open), comments, live edits, claims (auto ticket: a ticket create + a market read), the options refresh every
// 10 minutes, and "wait as long as the ticket system asked" after a 429 for the polls (a claim or an edit is the agent's own action and is
// not held back, so it fails when the limit is hit).
//
// Cache modes (the Functions keep reads for a few seconds per isolate): "shared" = every agent hits one isolate (best case), "none" = no read
// is ever shared and an isolate does not know the limit was hit (worst case). Production is in between.
//
// Prints, per agent count: ticket API calls a minute (peak and average), how many were refused with 429, how many claims/edits/comments failed.
import { handler as listHandler } from "../functions/ticket-list.js";
import { handler as statusHandler } from "../functions/ticket-status.js";
import { handler as updateHandler } from "../functions/ticket-update.js";
import { handler as createHandler } from "../functions/ticket-create.js";
import { handler as commentHandler } from "../functions/ticket-comment.js";
import { handler as configHandler, resetTicketConfigCache } from "../functions/ticket-config.js";
import { initEnv as initLiveChatEnv } from "../functions/_lib/livechat.js";
import { resetTicketRateLimit, resetTicketReadCache } from "../functions/_lib/tickets.js";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args.set(a.slice(2), next); i += 1; } else args.set(a.slice(2), true);
}
const MINUTES = Number(args.get("minutes") || 6);
const SEED = Number(args.get("seed") || 1);
const AGENT_COUNTS = args.has("agents") ? [Number(args.get("agents"))] : [5, 10, 15, 20, 30, 50];
const MODES = args.has("mode") ? [String(args.get("mode"))] : ["shared", "none"];
const KEY_LIMIT = Number(args.get("limit") || 120);
const OPEN_SHARE = Number(args.get("open-share") || 0.3); // share of agents with a ticket open in the widget at any time
const CLAIM_EVERY_S = Number(args.get("claim-every") || 180); // one claim per agent per 3 minutes on average

// ---- virtual clock and a small seeded random ------------------------------------------------------------------------------------
let now = Date.UTC(2026, 9, 19, 10, 0, 0);
const realNow = Date.now;
Date.now = () => now;
let seed = SEED;
const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

// ---- the fake ticket system ---------------------------------------------------------------------------------------------------
const stats = { perMinute: new Map(), refused: 0, served: 0 };
const NOW_ISO = () => new Date(now).toISOString();
const ticketOf = (n) => ({ id: n, ref: `TK26101900${String(n).padStart(2, "0")}`, fields: { status: "OPEN", member_id: `p${n}` }, raisedBy: { id: 1, name: "A", email: "a@x.com" }, assignees: [], currentDepartment: { id: 3, code: "PYM" }, market: { id: 1, code: "MYR" }, createdAt: NOW_ISO(), updatedAt: NOW_ISO(), commentCount: 2, attachmentCount: 0 });
const LIST = (size) => Array.from({ length: size }, (_, i) => ticketOf(i + 1));
let created = 0;
function ticketSystem(url, options = {}) {
  const parsed = new URL(url);
  const minute = Math.floor(now / 60_000);
  const used = (stats.perMinute.get(minute) || 0) + 1;
  stats.perMinute.set(minute, used);
  if (used > KEY_LIMIT) {
    stats.refused += 1;
    const retry = Math.max(1, 60 - Math.floor((now % 60_000) / 1000));
    return new Response(JSON.stringify({ ok: false, error: "Rate limit exceeded" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(retry) } });
  }
  stats.served += 1;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const path = parsed.pathname.replace(/^.*\/api\/v1/, "");
  const method = options.method || "GET";
  if (method === "POST" && path === "/tickets") { created += 1; return json({ ok: true, id: 1000 + created, ref: `TK2610190${String(1000 + created)}`, ignored: [] }, 201); }
  if (method === "PATCH") return json({ ok: true, ref: path.split("/")[2], changed: [], visible: true, ticket: ticketOf(1) });
  if (method === "POST" && path.endsWith("/comments")) return json({ ok: true, parentId: null, comment: { id: 9, author: { id: 1, name: "A" }, body: "x" } }, 201);
  if (path === "/tickets") return json({ ok: true, total: 13802, tickets: LIST(Number(parsed.searchParams.get("pageSize") || 100)) });
  if (path.startsWith("/tickets/")) return json({ ok: true, ticket: { ...ticketOf(1), comments: [] } });
  if (path === "/markets") return json({ ok: true, markets: [{ id: 1, code: "MYR", label: "Malaysia" }] });
  if (path === "/departments") return json({ ok: true, departments: [{ id: 3, code: "PYM_MYR", name: "Payment" }] });
  if (path === "/fields/choices") return json({ ok: true, fields: [] });
  if (path === "/fields") return json({ ok: true, fields: [{ key: "status", label: "Status", type: "SELECT" }] });
  return json({ ok: false, error: `unexpected ${path}` }, 404);
}

const ENV = { TICKETS_API_KEY: "k", TICKETS_ON_BEHALF_OF: "1", LIVECHAT_CLIENT_ID: "c1" };
const TOKENS = new Map();
globalThis.fetch = async (url, options = {}) => {
  url = String(url);
  if (url.endsWith("/v2/info")) {
    const info = TOKENS.get(String(options.headers.Authorization).replace("Bearer ", ""));
    return info ? Response.json(info) : Response.json({ error: "invalid_token" }, { status: 401 });
  }
  if (url.includes("tickets.96ghq.com")) return ticketSystem(url, options);
  throw new Error(`the stress test must not reach ${url}`);
};

// ---- the simulated widget ---------------------------------------------------------------------------------------------------
const call = async (handler, input, method = "POST") => {
  const result = await handler({ httpMethod: method, env: ENV, body: JSON.stringify(input), queryStringParameters: {}, headers: {} });
  let body = {};
  try { body = JSON.parse(result.body); } catch (_) { /* a binary answer is not used here */ }
  return { status: result.statusCode, body };
};

function makeAgent(index) {
  const token = `tok-${index}`;
  TOKENS.set(token, { account_id: `uuid-${index}`, email: `agent${index}@x.com`, client_id: "c1" });
  return {
    index, author: { accountKey: "lc1", agentToken: token },
    pausedUntil: 0, pollRound: 0, nextBell: now + random() * 15_000, nextOpen: now + random() * 8_000, nextClaim: now + random() * CLAIM_EVERY_S * 2 * 1000,
    nextConfig: now + random() * 600_000, nextEdit: now + 60_000 + random() * 240_000, nextComment: now + 90_000 + random() * 300_000, hasOpenTicket: random() < OPEN_SHARE,
  };
}
// The widget's own rule (ticketPollBackoff): after "busy" the polls wait as long as the ticket system asked.
const backoff = (agent, response) => {
  if (response.status !== 429) return;
  const seconds = Number((/Try again in (\d+) s/.exec(String(response.body.error || "")) || [])[1]) || 30;
  agent.pausedUntil = now + seconds * 1000 + 2000;
};

async function step(agent, tally) {
  const read = (extra = {}) => call(listHandler, { q: "", fresh: false, author: agent.author, ...extra });
  if (now >= agent.nextBell) {
    agent.nextBell += 15_000;
    if (now >= agent.pausedUntil) {
      const everyone = agent.pollRound % 4 === 0;
      agent.pollRound += 1;
      const results = await Promise.all([read({ mine: true, size: 250, sort: "created" }), everyone ? read() : null]);
      results.filter(Boolean).forEach((r) => backoff(agent, r));
      tally.polls += 1;
    }
  }
  if (agent.hasOpenTicket && now >= agent.nextOpen) {
    agent.nextOpen += 8_000;
    if (now >= agent.pausedUntil) { backoff(agent, await call(statusHandler, { ref: "TK2610190001", fresh: false, author: agent.author })); tally.polls += 1; }
  }
  if (now >= agent.nextConfig) { agent.nextConfig += 600_000; backoff(agent, await call(configHandler, { author: agent.author, fresh: false })); }
  if (now >= agent.nextClaim) {
    agent.nextClaim += (0.5 + random()) * CLAIM_EVERY_S * 1000;
    tally.claims += 1;
    // A claim: the auto ticket (the agent's own action, so not held back) and the ticket config is already loaded.
    const r = await call(createHandler, { fields: { toDepartment: "PYM_MYR", market: "MYR", member_id: "zz", query_type: "vvip_top_p_l_bonus" }, author: agent.author });
    if (r.status !== 201) { tally.claimsFailed += 1; backoff(agent, r); }
  }
  if (now >= agent.nextEdit) {
    agent.nextEdit += (0.5 + random()) * 240_000;
    tally.edits += 1;
    const r = await call(updateHandler, { ref: "TK2610190001", fields: { status: "SOLVED" }, author: agent.author });
    if (r.status !== 200) tally.editsFailed += 1;
  }
  if (now >= agent.nextComment) {
    agent.nextComment += (0.5 + random()) * 300_000;
    tally.comments += 1;
    const r = await call(commentHandler, { ref: "TK2610190001", body: "ok", author: agent.author });
    if (r.status !== 201) tally.commentsFailed += 1;
  }
}

async function run(agentCount, mode) {
  stats.perMinute.clear(); stats.refused = 0; stats.served = 0; created = 0; TOKENS.clear(); seed = SEED;
  now = Date.UTC(2026, 9, 19, 10, 0, 0);
  initLiveChatEnv({ LIVECHAT_PAT: "pat" });
  resetTicketReadCache(); resetTicketRateLimit(); resetTicketConfigCache();
  const agents = Array.from({ length: agentCount }, (_, i) => makeAgent(i + 1));
  const tally = { polls: 0, claims: 0, claimsFailed: 0, edits: 0, editsFailed: 0, comments: 0, commentsFailed: 0 };
  const end = now + MINUTES * 60_000;
  const start = now;
  while (now < end) {
    for (const agent of agents) {
      if (mode === "none") { resetTicketReadCache(); resetTicketRateLimit(); resetTicketConfigCache(); }
      await step(agent, tally);
    }
    now += 1000;
  }
  const minutes = [...stats.perMinute.entries()].sort((a, b) => a[0] - b[0]).map(([, count]) => count);
  const whole = minutes.slice(0, MINUTES); // minute buckets over the run
  const peak = Math.max(...whole);
  const average = whole.reduce((sum, n) => sum + n, 0) / Math.max(1, whole.length);
  return { agentCount, mode, peak, average, refused: stats.refused, served: stats.served, ...tally, seconds: (now - start) / 1000 };
}

const rows = [];
for (const mode of MODES) for (const count of AGENT_COUNTS) rows.push(await run(count, mode));
Date.now = realNow;

const pad = (value, width) => String(value).padEnd(width);
console.log(`Fake ticket system limit: ${KEY_LIMIT} calls a minute for the key. ${MINUTES} virtual minutes per run, ${Math.round(OPEN_SHARE * 100)}% of agents with a ticket open, a claim per agent every ~${CLAIM_EVERY_S} s.\n`);
console.log([pad("cache", 7), pad("agents", 7), pad("calls/min avg", 14), pad("peak", 6), pad("refused(429)", 13), pad("claims failed", 14), pad("edits failed", 13), "comments failed"].join(""));
for (const r of rows) {
  console.log([pad(r.mode, 7), pad(r.agentCount, 7), pad(r.average.toFixed(0), 14), pad(r.peak, 6), pad(r.refused, 13), pad(`${r.claimsFailed}/${r.claims}`, 14), pad(`${r.editsFailed}/${r.edits}`, 13), `${r.commentsFailed}/${r.comments}`].join(""));
}
const worst = rows.filter((r) => r.mode === "none");
const okAgents = worst.filter((r) => r.refused === 0 && r.claimsFailed === 0).map((r) => r.agentCount);
console.log(`\nWorst case (no read is shared): no refusal at ${okAgents.length ? `up to ${Math.max(...okAgents)}` : "none of the tested"} agents.`);
