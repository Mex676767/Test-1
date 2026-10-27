import test from "node:test";
import assert from "node:assert/strict";
import { handler as saveHandler } from "./knowledge-save.js";
import { handler as listHandler } from "./knowledge-list.js";
import { clearKnowledgeCache, guideToFields, recordToGuide } from "./_lib/knowledge.js";
import { initEnv as initLarkEnv } from "./_lib/lark.js";

const ENV = { LARK_APP_ID: "app", LARK_APP_SECRET: "secret", LARK_BASE_APP_TOKEN: "base", LARK_TABLE_LEARNING_GROUP: "learn-table" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const FIELDS = [
  { field_id: "fldCat", field_name: "Category", type: 3, property: { options: [{ id: "o1", name: "Deposit", color: 1 }, { id: "o2", name: "SOP", color: 2 }] } },
  { field_id: "fldBrand", field_name: "Brand", type: 3, property: { options: [{ id: "b1", name: "TC" }, { id: "b2", name: "Zyra" }, { id: "b3", name: "TC & Zyra" }] } },
];
const EXISTING = [
  { record_id: "recEXIST00001", fields: { Title: "Old guide", Category: "Deposit", Status: "Live", Picture: [{ file_token: "tokOLD123456789" }] } },
  { record_id: "recDRAFT00001", fields: { Title: "Draft guide", Category: "SOP", Status: "Draft", Steps: "A | B" } },
];

function world({ categoryRefused = false, larkDown = false, existing = EXISTING } = {}) {
  const log = { calls: [], recordBodies: [], uploads: [], fieldPuts: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    const method = options.method || "GET";
    log.calls.push(`${method} ${url.replace("https://open.larksuite.com/open-apis/", "")}`);
    if (url.includes("tenant_access_token")) return { json: async () => ({ code: 0, tenant_access_token: "t", expire: 3600 }) };
    if (larkDown) throw new Error("Lark is down");
    if (url.endsWith("/tables/learn-table/fields?page_size=100")) return { json: async () => ({ code: 0, data: { items: FIELDS } }) };
    if (method === "PUT" && url.includes("/fields/fldCat")) {
      log.fieldPuts.push(JSON.parse(options.body));
      return { json: async () => (categoryRefused ? { code: 1254060, msg: "no permission" } : { code: 0, data: {} }) };
    }
    if (url.endsWith("/drive/v1/medias/upload_all")) {
      const form = options.body;
      log.uploads.push({ parent_type: form.get("parent_type"), parent_node: form.get("parent_node"), size: form.get("size"), auth: options.headers.Authorization });
      return { json: async () => ({ code: 0, data: { file_token: "tokNEWPICTURE01" } }) };
    }
    if (method === "POST" && url.endsWith("/tables/learn-table/records")) {
      log.recordBodies.push({ method, body: JSON.parse(options.body) });
      return { json: async () => ({ code: 0, data: { record: { record_id: "recCREATED0001" } } }) };
    }
    if (method === "PUT" && /\/tables\/learn-table\/records\/rec/.test(url)) {
      log.recordBodies.push({ method, url, body: JSON.parse(options.body) });
      return { json: async () => ({ code: 0, data: { record: { record_id: url.split("/").pop() } } }) };
    }
    if (url.includes("/tables/learn-table/records")) return { json: async () => ({ code: 0, data: { items: existing } }) };
    throw new Error("unexpected " + method + " " + url);
  };
  clearKnowledgeCache();
  initLarkEnv(ENV);
  return { log, restore: () => { globalThis.fetch = original; } };
}

const GUIDE = {
  title: "Grace Period Bonus", category: "Deposit", brand: "TC", keywords: ["grace period", "激活红利"], summary: "Valid for 4 days.",
  steps: [{ title: "Check the valid period", text: "Valid for 4 days." }, { title: "", text: "Claim on the same day" }],
  table: { cols: ["Item", "Value"], rows: [["Deposit requirement", "RM1,000"], ["", ""], ["Bonus | amount", "RM108"]] },
  scenarios: [{ ok: true, title: "Scenario 1", text: "Deposits RM1,000.", result: "Eligible." }, { ok: false, title: "Scenario 2", text: "Deposits RM500.", result: "" }],
  warning: "Check the activation time.", note: "Ask a Senior.",
  replies: { en: ["I have activated your bonus ya!", "You have 4 days."], ms: ["Saya dah aktifkan bonus."], zh: [] }, status: "Live",
};

const send = async (guide, { picture, method = "POST", env = ENV } = {}) => {
  initLarkEnv(env);
  const formData = new FormData();
  formData.set("guide", typeof guide === "string" ? guide : JSON.stringify(guide));
  if (picture) formData.set("picture", picture);
  const res = await saveHandler({ httpMethod: method, formData });
  return { status: res.statusCode, ...JSON.parse(res.body) };
};
const png = (type = "image/png", bytes = PNG) => new File([bytes], "shot.png", { type });

test("a new guide is written to Lark in the cell formats the Knowledge page reads", async (t) => {
  const w = world();
  t.after(w.restore);
  const out = await send(GUIDE);
  assert.deepEqual([out.status, out.ok, out.created, out.id], [200, true, true, "recCREATED0001"]);
  const { fields } = w.log.recordBodies[0].body;
  assert.equal(fields.Title, "Grace Period Bonus");
  assert.equal(fields.Status, "Live");
  assert.equal(fields.Keywords, "grace period\n激活红利");
  assert.equal(fields.Steps, "Check the valid period | Valid for 4 days.\nClaim on the same day");
  assert.equal(fields["Reference Table"], "Item | Value\nDeposit requirement | RM1,000\nBonus / amount | RM108");
  assert.equal(fields.Scenarios, "ok | Scenario 1 | Deposits RM1,000. | Eligible.\nnot ok | Scenario 2 | Deposits RM500. | ");
  assert.equal(fields["Reply Template"], "I have activated your bonus ya!\nYou have 4 days.");
  assert.equal(fields["Reply MS"], "Saya dah aktifkan bonus.");
  assert.equal(fields["Reply ZH"], "");
  assert.equal(fields["Bonus Amounts"], "");
  assert.equal("Picture" in fields, false);
});

test("what the form saves is what the page reads back", () => {
  const record = { record_id: "recROUND00001", fields: guideToFields(GUIDE) };
  const back = recordToGuide(record);
  assert.deepEqual(back.steps, [{ title: "Check the valid period", text: "Valid for 4 days." }, { title: "", text: "Claim on the same day" }]);
  assert.deepEqual(back.bonus_table, { title: "Reference", cols: ["Item", "Value"], rows: [["Deposit requirement", "RM1,000"], ["Bonus / amount", "RM108"]] });
  assert.deepEqual(back.scenarios.map((s) => [s.ok, s.title, s.result]), [[true, "Scenario 1", "Eligible."], [false, "Scenario 2", ""]]);
  assert.deepEqual(back.replies, { en: ["I have activated your bonus ya!", "You have 4 days."], ms: ["Saya dah aktifkan bonus."] });
  assert.deepEqual(back.keywords, ["grace period", "激活红利"]);
});

test("a Draft guide stays Draft, and a guide with nothing optional is fine", () => {
  const fields = guideToFields({ title: "Small", category: "SOP", status: "Draft" });
  assert.equal(fields.Status, "Draft");
  assert.equal(fields.Steps, "");
  assert.equal(fields["Reference Table"], "");
  assert.equal("Brand" in fields, false);
});

test("a new category is added to the Category field before the guide is written", async (t) => {
  const w = world();
  t.after(w.restore);
  const out = await send({ ...GUIDE, category: "Escalation" });
  assert.equal(out.ok, true);
  assert.equal(w.log.fieldPuts.length, 1);
  assert.deepEqual(w.log.fieldPuts[0].property.options.map((o) => o.name), ["Deposit", "SOP", "Escalation"]);
  assert.deepEqual(w.log.fieldPuts[0].property.options.slice(0, 2).map((o) => o.id), ["o1", "o2"]);
  const put = w.log.calls.findIndex((c) => c.startsWith("PUT") && c.includes("/fields/"));
  const post = w.log.calls.findIndex((c) => c.startsWith("POST") && c.endsWith("/records"));
  assert.ok(put > -1 && put < post);
});

test("an existing category leaves the field alone", async (t) => {
  const w = world();
  t.after(w.restore);
  await send(GUIDE);
  assert.equal(w.log.fieldPuts.length, 0);
});

test("if Lark will not add the category the trainer is told what to do and nothing is written", async (t) => {
  const w = world({ categoryRefused: true });
  t.after(w.restore);
  const out = await send({ ...GUIDE, category: "Escalation" });
  assert.equal(out.status, 400);
  assert.match(out.error, /Add it as an option on the Category field/);
  assert.equal(w.log.recordBodies.length, 0);
});

test("a picture is uploaded to Lark with the app token and attached to the row", async (t) => {
  const w = world();
  t.after(w.restore);
  const out = await send(GUIDE, { picture: png() });
  assert.equal(out.ok, true);
  assert.deepEqual(w.log.uploads, [{ parent_type: "bitable_image", parent_node: "base", size: String(PNG.length), auth: "Bearer t" }]);
  assert.deepEqual(w.log.recordBodies[0].body.fields.Picture, [{ file_token: "tokNEWPICTURE01" }]);
});

test("a picture that is not really an image, or too big, is refused before anything is written", async (t) => {
  const w = world();
  t.after(w.restore);
  const fake = await send(GUIDE, { picture: png("image/png", new TextEncoder().encode("<script>alert(1)</script>")) });
  assert.equal(fake.status, 400);
  assert.match(fake.error, /PNG, JPEG or WebP/);
  const wrongType = await send(GUIDE, { picture: png("application/pdf") });
  assert.equal(wrongType.status, 400);
  const big = new Uint8Array(5 * 1024 * 1024 + 1); big.set(PNG);
  const tooBig = await send(GUIDE, { picture: png("image/png", big) });
  assert.match(tooBig.error, /too large/);
  assert.equal(w.log.uploads.length + w.log.recordBodies.length, 0);
});

test("bad input is explained and never reaches Lark", async (t) => {
  const w = world();
  t.after(w.restore);
  assert.match((await send({ ...GUIDE, title: "  " })).error, /title/);
  assert.match((await send({ ...GUIDE, category: "" })).error, /category/);
  assert.match((await send({ ...GUIDE, brand: "Nope" })).error, /not one of the brands/);
  assert.match((await send({ ...GUIDE, steps: Array.from({ length: 31 }, () => ({ text: "x" })) })).error, /Too many steps/);
  assert.match((await send({ ...GUIDE, summary: "x".repeat(1001) })).error, /summary is too long/);
  assert.match((await send("not json")).error, /could not be read/);
  assert.equal(w.log.recordBodies.length, 0);
});

test("editing a guide updates that row, keeps its picture, and can remove it", async (t) => {
  const w = world();
  t.after(w.restore);
  const kept = await send({ ...GUIDE, id: "recEXIST00001" });
  assert.deepEqual([kept.ok, kept.created, kept.id], [true, false, "recEXIST00001"]);
  assert.equal(w.log.recordBodies[0].method, "PUT");
  assert.equal("Picture" in w.log.recordBodies[0].body.fields, false);
  await send({ ...GUIDE, id: "recEXIST00001", removePicture: true });
  assert.deepEqual(w.log.recordBodies[1].body.fields.Picture, []);
  await send({ ...GUIDE, id: "recEXIST00001", removePicture: true }, { picture: png() });
  assert.deepEqual(w.log.recordBodies[2].body.fields.Picture, [{ file_token: "tokNEWPICTURE01" }]);
});

test("editing a guide that is gone or has a made-up id changes nothing", async (t) => {
  const w = world();
  t.after(w.restore);
  assert.equal((await send({ ...GUIDE, id: "recGONE0000001" })).status, 404);
  assert.equal((await send({ ...GUIDE, id: "../../x" })).status, 400);
  assert.equal(w.log.recordBodies.length, 0);
});

test("only POST saves, and nothing is written when the table is not set up", async (t) => {
  const w = world();
  t.after(w.restore);
  assert.equal((await send(GUIDE, { method: "GET" })).status, 405);
  const unset = await send(GUIDE, { env: { ...ENV, LARK_TABLE_LEARNING_GROUP: undefined } });
  assert.equal(unset.status, 503);
  assert.equal(w.log.recordBodies.length, 0);
});

test("a Lark failure comes back as 502 with a message", async (t) => {
  const w = world({ larkDown: true });
  t.after(w.restore);
  const out = await send(GUIDE);
  assert.equal(out.status, 502);
  assert.match(out.error, /Lark is down/);
});

test("the admin list also returns Draft guides and the Category / Brand options", async (t) => {
  const w = world();
  t.after(w.restore);
  const res = await listHandler({ queryStringParameters: { all: "1" } });
  const data = JSON.parse(res.body);
  assert.deepEqual(data.guides.map((g) => [g.title, g.status]), [["Draft guide", "Draft"], ["Old guide", "Live"]]);
  assert.deepEqual(data.options, { categories: ["Deposit", "SOP"], brands: ["TC", "Zyra", "TC & Zyra"] });
  assert.equal(res.headers["Cache-Control"], "no-store");
  const agents = JSON.parse((await listHandler({ queryStringParameters: {} })).body);
  assert.deepEqual(agents.guides.map((g) => g.title), ["Old guide"]);
  assert.equal("options" in agents, false);
});
