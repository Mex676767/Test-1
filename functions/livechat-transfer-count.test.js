import test from "node:test";
import assert from "node:assert/strict";
import { handler, resetTransferDirectoryCache } from "./livechat-transfer-count.js";
import { initEnv as initLiveChatEnv } from "./_lib/livechat.js";
import {
  TRANSFER_LICENSES, addThread, buildDirectory, classifyThread, klDay, klDayStartMs, newTotals, rfc3339,
} from "./_lib/transfer-count.js";

const license = TRANSFER_LICENSES.lc2; // tracked 22 12 5 6 26 13 27 11 23, not a source: 29 28
const groups = [
  { id: 22, name: "Support A" }, { id: 12, name: "Support B" }, { id: 29, name: "Priority 96" },
  { id: 50, name: "Escalations" }, { id: 51, name: "🎯Special Desk🎯" },
];
const agents = [{ id: "kim@x.com", name: "Kim Lee", email: "kim@x.com" }];
const dir = buildDirectory(groups, agents);

const T = (minute) => `2026-10-10T08:${String(minute).padStart(2, "0")}:00.000000Z`;
const moved = (to, minute) => ({ type: "system_message", system_message_type: "chat_transferred", created_at: T(minute), text: "%initiator% transferred the chat to %targets%", text_vars: { initiator: "Sam", targets: to } });
const chat = (events, access = { group_ids: [50] }) => ({ id: "C1", thread: { id: "T1", access, events } });
const OCT = { fromMs: klDayStartMs("2026-10-01"), toMs: klDayStartMs("2026-11-01") };
const statuses = (events) => classifyThread(chat(events).thread, license, dir).transfers.map((item) => item.status);

test("follows the chain of groups and applies the license rules in order", () => {
  const events = [moved("Priority 96", 1), moved("Support A", 2), moved("Support B", 3), moved("Escalations", 4), moved("Escalations", 5)];
  assert.deepEqual(statuses(events), ["undetermined", "sourceUntracked", "destTracked", "counted", "sameGroup"]);
});

test("a first transfer into a tracked group is decided even though its source is unknown", () => {
  assert.deepEqual(statuses([moved("Support A", 1)]), ["destTracked"]);
});

test("a transfer straight to an agent is ignored and does not move the chain", () => {
  assert.deepEqual(statuses([moved("Support A", 1), moved("Kim Lee", 2), moved("Escalations", 3)]), ["destTracked", "ignoredAgent", "counted"]);
});

test("an unrecognised destination is unclassified and the chain starts again", () => {
  const result = classifyThread(chat([moved("Support A", 1), moved("Mystery Desk", 2), moved("Escalations", 3)]).thread, license, dir).transfers;
  assert.deepEqual(result.map((item) => item.status), ["destTracked", "unclassified", "undetermined"]);
  assert.match(result[1].reason, /Mystery Desk/);
});

test("a group name used twice, or an agent mixed with a group, is not guessed", () => {
  const twice = buildDirectory([{ id: 1, name: "Same" }, { id: 2, name: "Same" }], []);
  assert.equal(classifyThread(chat([moved("Same", 1)]).thread, license, twice).transfers[0].status, "unclassified");
  assert.deepEqual(statuses([moved("Kim Lee, Escalations", 1)]), ["unclassified"]);
});

test("emoji group names, ids, and the plain-text message are understood", () => {
  const byId = classifyThread(chat([moved("50", 1)]).thread, license, dir).transfers[0];
  assert.equal(byId.destId, "50");
  assert.equal(classifyThread(chat([moved("🎯Special Desk🎯", 1)]).thread, license, dir).transfers[0].destId, "51");
  const textOnly = { type: "system_message", created_at: T(1), text: "Sam transferred the chat to Escalations" };
  assert.equal(classifyThread(chat([textOnly]).thread, license, dir).transfers[0].destId, "50");
  const other = { type: "system_message", system_message_type: "agent_joined", created_at: T(1), text: "Sam joined" };
  assert.equal(classifyThread(chat([other]).thread, license, dir).transfers.length, 0);
});

test("only transfers inside the Kuala Lumpur month are counted, but earlier ones still set the source", () => {
  assert.equal(klDay(Date.parse("2026-10-31T15:59:59Z")), "2026-10-31");
  assert.equal(klDay(Date.parse("2026-10-31T16:00:00Z")), "2026-11-01");
  const at = (iso, to) => ({ ...moved(to, 0), created_at: iso });
  const events = [
    at("2026-09-30T20:00:00.000000Z", "Support A"), // 1 Oct 04:00 KL, in range, comes from Priority 96 (untracked)
    at("2026-10-31T15:59:59.000000Z", "Escalations"), // 31 Oct 23:59:59 KL, in range, counted
    at("2026-10-31T16:00:00.000000Z", "Support B"), // 1 Nov 00:00 KL, out of range
    at("2026-09-30T15:59:59.000000Z", "Priority 96"), // 30 Sep 23:59:59 KL, out of range
  ];
  const totals = addThread(newTotals(), chat(events), license, dir, OCT);
  // chronological: Priority 96 (Sep, out), Support A, Escalations, Support B (Nov, out)
  assert.equal(totals.transfers, 2);
  assert.equal(totals.sourceUntracked, 1);
  assert.equal(totals.counted, 1);
  assert.deepEqual(totals.byDay, { "2026-10-31": 1 });
  assert.deepEqual(totals.bySource, { 22: 1 });
  assert.deepEqual(totals.byDestination, { 50: 1 });
});

test("flags a thread whose last destination is not the chat's current group", () => {
  const result = classifyThread(chat([moved("Escalations", 1)], { group_ids: [12] }).thread, license, dir);
  assert.equal(result.mismatch, true);
  assert.equal(classifyThread(chat([moved("Escalations", 1)]).thread, license, dir).mismatch, false);
});

test("the two licenses keep separate tracked lists", () => {
  assert.ok(TRANSFER_LICENSES.lc1.tracked.includes(45) && !TRANSFER_LICENSES.lc2.tracked.includes(45));
  assert.ok(TRANSFER_LICENSES.lc1.tracked.includes(26) && TRANSFER_LICENSES.lc2.tracked.includes(26));
  assert.equal(rfc3339(Date.parse("2026-09-28T16:00:00Z")), "2026-09-28T16:00:00.000000+00:00");
});

// ---- endpoint ----
const ENV = { SCAN_KEY: "scan-secret" };
const sampleChats = () => [
  chat([moved("Priority 96", 1), moved("Support A", 2), moved("Escalations", 3)]),
  { id: "C2", thread: { id: "T2", access: { group_ids: [22] }, events: [moved("Support A", 3)] } },
];

function world({ pages, groupList = groups, calls = [] }) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    const body = JSON.parse(options.body || "{}");
    calls.push({ url, auth: options.headers?.Authorization, body });
    if (url.endsWith("/configuration/action/list_groups")) return { ok: true, json: async () => groupList };
    if (url.endsWith("/configuration/action/list_agents")) return { ok: true, json: async () => agents };
    if (url.endsWith("/agent/action/list_archives")) return { ok: true, json: async () => pages(body) };
    throw new Error("unexpected " + url);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const call = async (body, { env = ENV, key = "scan-secret", method = "POST" } = {}) => {
  initLiveChatEnv({ LIVECHAT_PAT: "pat-1", LIVECHAT_PAT_2: "pat-2" });
  resetTransferDirectoryCache();
  const result = await handler({ httpMethod: method, body: JSON.stringify(body), env, headers: key === null ? {} : { "x-scan-key": key } });
  return { status: result.statusCode, body: JSON.parse(result.body) };
};

test("endpoint is hidden without SCAN_KEY and refuses a wrong key", async () => {
  assert.equal((await call({ accountKey: "lc2" }, { env: {} })).status, 404);
  assert.equal((await call({ accountKey: "lc2" }, { key: "nope" })).status, 401);
  assert.equal((await call({ accountKey: "lc2" }, { key: null })).status, 401);
  assert.equal((await call({ accountKey: "lc2" }, { method: "GET" })).status, 405);
});

test("endpoint pages through October with the right window and adds the counts for the chosen license", async () => {
  const w = world({ pages: (body) => (body.page_id ? { chats: [sampleChats()[1]], next_page_id: "", found_chats: 2 } : { chats: [sampleChats()[0]], next_page_id: "P2", found_chats: 2 }) });
  try {
    const first = await call({ accountKey: "lc2", from: "2026-10-01", to: "2026-11-01" });
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.license, "License 2");
    assert.equal(first.body.nextPageId, "P2");
    assert.equal(first.body.totals.counted, 1);
    assert.equal(first.body.totals.undetermined, 1);
    const archive = w.calls.find((item) => item.url.endsWith("list_archives"));
    assert.equal(archive.auth, "Basic pat-2");
    assert.deepEqual(archive.body, { filters: { from: "2026-09-28T16:00:00.000000+00:00", to: "2026-11-02T16:00:00.000000+00:00" }, limit: 100, sort_order: "asc" });
    assert.deepEqual([...first.body.trackedMissing].sort((a, b) => a - b), [5, 6, 11, 13, 23, 26, 27]);

    const second = await call({ accountKey: "lc2", from: "2026-10-01", to: "2026-11-01", pageId: "P2" });
    assert.deepEqual(w.calls.filter((item) => item.url.endsWith("list_archives")).at(-1).body, { page_id: "P2" });
    assert.equal(second.body.totals.destTracked, 1);
    assert.equal(second.body.nextPageId, "");
  } finally { w.restore(); }
});

test("endpoint rejects bad dates and unknown licenses", async () => {
  assert.equal((await call({ accountKey: "lc3", from: "2026-10-01", to: "2026-11-01" })).status, 400);
  assert.equal((await call({ accountKey: "lc2", from: "October", to: "2026-11-01" })).status, 400);
  assert.equal((await call({ accountKey: "lc2", from: "2026-11-01", to: "2026-10-01" })).status, 400);
  assert.equal((await call({ accountKey: "lc2", from: "2026-01-01", to: "2026-12-01" })).status, 400);
});

test("a LiveChat error is reported, not counted as zero", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: false, status: 429, json: async () => (String(url).includes("list_groups") ? groups : { error: { message: "Too many requests" } }) });
  try {
    const result = await call({ accountKey: "lc2", from: "2026-10-01", to: "2026-11-01" });
    assert.equal(result.body.ok, false);
    assert.match(result.body.error, /Too many requests|HTTP 429/);
  } finally { globalThis.fetch = original; }
});

test("probe shows the raw transfer events and how each was read, without message text", async () => {
  const withMessage = chat([moved("Escalations", 2), { type: "message", author_id: "cust", text: "my private message", created_at: T(1) }]);
  const w = world({ pages: () => ({ chats: [withMessage] }) });
  try {
    const result = await call({ accountKey: "lc2", step: "probe", chatId: "PJ0MRSHTDG" });
    assert.equal(result.body.ok, true);
    assert.equal(w.calls.find((item) => item.url.endsWith("list_archives")).body.filters.chat_ids[0], "PJ0MRSHTDG");
    const thread = result.body.threads[0];
    assert.equal(thread.rawTransferEvents.length, 1);
    assert.deepEqual(thread.rawTransferEvents[0].text_vars, { initiator: "Sam", targets: "Escalations" });
    assert.equal(thread.transfers[0].destId, "50");
    assert.ok(!JSON.stringify(result.body).includes("my private message"));
    assert.equal((await call({ accountKey: "lc2", step: "probe", chatId: "bad id!" })).status, 400);
  } finally { w.restore(); }
});
