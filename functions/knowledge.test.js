import test from "node:test";
import assert from "node:assert/strict";
import { handler as listHandler } from "./knowledge-list.js";
import { handler as imageHandler } from "./knowledge-image.js";
import { clearKnowledgeCache, parseScenarios, parseSteps, parseTable, recordToGuide, sortGuides } from "./_lib/knowledge.js";
import { initEnv as initLarkEnv } from "./_lib/lark.js";

const ENV = { LARK_APP_ID: "app", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base", LARK_TABLE_LEARNING_GROUP: "learn-table" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const row = (id, fields) => ({ record_id: id, fields: { Title: "Deposit Block", Category: "Deposit", Status: "Live", ...fields } });
const ROWS = [
  row("recAAAAAAAA1", {
    Brand: "TC / ZYRA", Keywords: "cannot deposit\r\n 1075 \n\n", Summary: "Multiple requests", Steps: "Check BO\nRaise ticket\n",
    "Bonus Amounts": "7D: 20%\n14D: 30%", Warning: "Be careful", "Reply Template": "Done boss",
    Picture: [{ file_token: "tokABCDEFGHIJKLMN", name: "p.png", type: "image/png", url: "https://open.larksuite.com/open-apis/drive/v1/medias/tokABCDEFGHIJKLMN/download?extra=x" }], Sort: 2,
  }),
  row("recAAAAAAAA2", { Title: "Hidden draft", Status: "Draft" }),
  row("recAAAAAAAA3", { Title: "Trainer's new topic", Category: "Escalation", Sort: 1 }),
  row("recAAAAAAAA4", { Title: "No category", Category: "" }),
  row("recAAAAAAAA5", { Title: "Evil picture", Picture: [{ file_token: "tokEVIL12345678", url: "https://evil.example/steal" }] }),
];

function world({ rows = ROWS, larkDown = false, mediaType = "image/png", mediaOk = true } = {}) {
  const calls = { records: 0, media: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.includes("tenant_access_token")) return { json: async () => ({ code: 0, tenant_access_token: "t", expire: 3600 }) };
    if (url.includes("/tables/learn-table/records")) {
      calls.records += 1;
      if (larkDown) throw new Error("Lark is down");
      return { json: async () => ({ code: 0, data: { items: rows } }) };
    }
    if (url.includes("/medias/")) {
      calls.media.push({ url, auth: options.headers?.Authorization });
      return { ok: mediaOk, status: mediaOk ? 200 : 404, headers: new Headers({ "content-type": mediaType }), arrayBuffer: async () => PNG.buffer.slice(0) };
    }
    throw new Error("unexpected " + url);
  };
  clearKnowledgeCache();
  initLarkEnv(ENV);
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const list = async (query = {}) => { const res = await listHandler({ queryStringParameters: query }); return { status: res.statusCode, ...JSON.parse(res.body), headers: res.headers }; };
const picture = (id) => imageHandler({ queryStringParameters: { id } });

const GRACE = row("recGRACE00001", {
  Title: "Grace Period Bonus", Category: "Special Bonus", Brand: "TC", Keywords: "grace period\n激活红利",
  Steps: "Check the valid period | The bonus is valid for 4 days.\nActivate via Live Chat | Deposits count only after activation.\nA step with no title",
  "Reference Table": "Item | Value\nDeposit requirement | RM1,000\nBonus amount | RM108",
  Scenarios: "ok | Scenario 1 · Eligible | Activates at 2 PM and deposits RM1,000. | Eligible to claim RM108.\nnot ok | Scenario 2 · Not met | Deposits only RM500. | Not eligible today.",
  Note: "New joiners: ask a Senior to issue it.",
  "Reply Template": "I have activated your bonus ya!\nYou have 4 days.", "Reply MS": "Saya dah aktifkan bonus boss ya!", "Reply ZH": "老板，我已经帮您激活了哦！",
});

test("a Grace Period style row fills every part of the guide page", () => {
  const guide = recordToGuide(GRACE);
  assert.deepEqual(guide.steps, [
    { title: "Check the valid period", text: "The bonus is valid for 4 days." },
    { title: "Activate via Live Chat", text: "Deposits count only after activation." },
    { title: "", text: "A step with no title" },
  ]);
  assert.deepEqual(guide.bonus_table, { title: "Reference", cols: ["Item", "Value"], rows: [["Deposit requirement", "RM1,000"], ["Bonus amount", "RM108"]] });
  assert.deepEqual(guide.scenarios, [
    { ok: true, title: "Scenario 1 · Eligible", text: "Activates at 2 PM and deposits RM1,000.", result: "Eligible to claim RM108." },
    { ok: false, title: "Scenario 2 · Not met", text: "Deposits only RM500.", result: "Not eligible today." },
  ]);
  assert.equal(guide.note, "New joiners: ask a Senior to issue it.");
  assert.deepEqual(guide.replies, { en: ["I have activated your bonus ya!", "You have 4 days."], ms: ["Saya dah aktifkan bonus boss ya!"], zh: ["老板，我已经帮您激活了哦！"] });
});

test("empty optional parts come through empty, so the page can leave them out", () => {
  const guide = recordToGuide(row("recAAAAAAAA9", {}));
  assert.deepEqual([guide.steps, guide.scenarios, guide.replies], [[], [], {}]);
  assert.equal(guide.bonus_table, null);
  assert.equal(guide.note, "");
});

test("scenarios without ok / not ok count as ok, and a bare bar line keeps its text", () => {
  assert.deepEqual(parseScenarios("Title | Body | Result"), [{ ok: true, title: "Title", text: "Body", result: "Result" }]);
  assert.deepEqual(parseSteps("Only title |"), [{ title: "", text: "Only title" }]);
  assert.equal(parseTable("  \n"), null);
});

test("the old Bonus Amounts field still becomes a reference table when Reference Table is empty", () => {
  const guide = recordToGuide(row("recAAAAAAA10", { "Bonus Amounts": "7D: 20%\n14D: 30%" }));
  assert.deepEqual(guide.bonus_table, { title: "Bonus reference", cols: ["Bonus"], rows: [["7D: 20%"], ["14D: 30%"]] });
  const both = recordToGuide(row("recAAAAAAA11", { "Bonus Amounts": "old", "Reference Table": "A | B\n1 | 2" }));
  assert.deepEqual(both.bonus_table.cols, ["A", "B"]);
});

test("a guide row turns into the shape the Knowledge page renders", () => {
  const guide = recordToGuide(ROWS[0]);
  assert.equal(guide.id, "recAAAAAAAA1");
  assert.deepEqual(guide.keywords, ["cannot deposit", "1075"]);
  assert.deepEqual(guide.steps, [{ title: "", text: "Check BO" }, { title: "", text: "Raise ticket" }]);
  assert.deepEqual(guide.bonus_table.rows, [["7D: 20%"], ["14D: 30%"]]);
  assert.deepEqual(guide.replies, { en: ["Done boss"] });
  assert.equal(guide.image, `/knowledge-image?id=recAAAAAAAA1&v=${"tokABCDEFGHIJKLMN".slice(-12)}`);
  assert.equal(guide.sort, 2);
});

test("only Live rows with a title and a category appear", () => {
  assert.equal(recordToGuide(ROWS[1]), null);
  assert.equal(recordToGuide(ROWS[3]), null);
  assert.equal(recordToGuide(row("recAAAAAAAA6", { Status: undefined })), null);
  assert.equal(recordToGuide(row("recAAAAAAAA7", { Status: { text: "Live" } })).id, "recAAAAAAAA7");
});

test("guides sort by Sort first, unsorted ones last by title", () => {
  const order = sortGuides([{ title: "B", sort: null }, { title: "A", sort: null }, { title: "Z", sort: 1 }, { title: "Y", sort: 0 }]).map((guide) => guide.title);
  assert.deepEqual(order, ["Y", "Z", "A", "B"]);
});

test("list answers not-configured when the table id is not set", async (t) => {
  const w = world();
  t.after(w.restore);
  initLarkEnv({ ...ENV, LARK_TABLE_LEARNING_GROUP: undefined });
  clearKnowledgeCache();
  const out = await list();
  assert.deepEqual({ ok: out.ok, configured: out.configured, guides: out.guides }, { ok: true, configured: false, guides: [] });
  assert.equal(w.calls.records, 0);
});

test("list returns Live guides in order, and a trainer's new category comes through as-is", async (t) => {
  const w = world();
  t.after(w.restore);
  const out = await list();
  assert.equal(out.configured, true);
  assert.deepEqual(out.guides.map((guide) => guide.title), ["Trainer's new topic", "Deposit Block", "Evil picture"]);
  assert.deepEqual([...new Set(out.guides.map((guide) => guide.category))], ["Escalation", "Deposit"]);
});

test("list is cached, and fresh=1 skips the cache", async (t) => {
  const w = world();
  t.after(w.restore);
  await list();
  await list();
  assert.equal(w.calls.records, 1);
  const fresh = await list({ fresh: "1" });
  assert.equal(w.calls.records, 2);
  assert.equal(fresh.headers["Cache-Control"], "no-store");
});

test("list says 502 when Lark is down so the page can fall back to its bundled guides", async (t) => {
  const w = world({ larkDown: true });
  t.after(w.restore);
  const out = await list();
  assert.equal(out.status, 502);
  assert.equal(out.ok, false);
});

test("a Live guide's picture is downloaded from Lark with the app token and served as an image", async (t) => {
  const w = world();
  t.after(w.restore);
  const res = await picture("recAAAAAAAA1");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "image/png");
  assert.deepEqual([...res.bytes], [...PNG]);
  assert.equal(w.calls.media.length, 1);
  assert.equal(w.calls.media[0].auth, "Bearer t");
  assert.match(w.calls.media[0].url, /^https:\/\/open\.larksuite\.com\/open-apis\/drive\/v1\/medias\/tokABCDEFGHIJKLMN\/download/);
});

test("a Draft row's picture is served too, so the admin preview can check it", async (t) => {
  const w = world({ rows: [...ROWS, row("recAAAAAAAA8", { Status: "Draft", Picture: [{ file_token: "tokDRAFT12345678" }] })] });
  t.after(w.restore);
  assert.equal((await picture("recAAAAAAAA8")).statusCode, 200);
});

test("rows without a picture and made-up ids are never fetched", async (t) => {
  const w = world();
  t.after(w.restore);
  assert.equal((await picture("recAAAAAAAA3")).statusCode, 404);
  assert.equal((await picture("recZZZZZZZZZ")).statusCode, 404);
  assert.equal((await picture("../../etc/passwd")).statusCode, 404);
  assert.equal((await picture("")).statusCode, 404);
  assert.equal(w.calls.media.length, 0);
});

test("a picture URL pointing anywhere but Lark's media download is ignored", async (t) => {
  const w = world();
  t.after(w.restore);
  await picture("recAAAAAAAA5");
  assert.equal(w.calls.media.length, 1);
  assert.match(w.calls.media[0].url, /^https:\/\/open\.larksuite\.com\/open-apis\/drive\/v1\/medias\/tokEVIL12345678\/download$/);
});

test("a non-image download or a Lark failure is not passed on to the browser", async (t) => {
  let w = world({ mediaType: "text/html" });
  assert.equal((await picture("recAAAAAAAA1")).statusCode, 415);
  w.restore();
  w = world({ mediaOk: false });
  t.after(w.restore);
  assert.equal((await picture("recAAAAAAAA1")).statusCode, 502);
});
