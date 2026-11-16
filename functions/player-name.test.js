import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "./player-name.js";
import { initEnv } from "./_lib/lark.js";

let sequence = 0;
function world(t, { column = "Title name", usernameColumn = "Username", type = 1, name = "Mr. Wong", fail = false } = {}) {
  const table = `name-table-${++sequence}`;
  initEnv({ LARK_APP_ID: "app", LARK_APP_SECRET: "test-secret", LARK_BASE_APP_TOKEN: "base", LARK_TABLE_PNL: table });
  const updates = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const response = (data) => ({ status: 200, json: async () => data });
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("tenant_access_token")) return response({ code: 0, tenant_access_token: "token", expire: 3600 });
    if (String(url).includes("/fields?")) return response({ code: 0, data: { items: [{ field_name: column, type }] } });
    assert.ok(String(url).includes(`/tables/${table}/records/recPlayer123`));
    if (options.method === "PUT") {
      updates.push(JSON.parse(options.body).fields);
      return response(fail ? { code: 1254045, msg: "Write refused" } : { code: 0, data: { record: {} } });
    }
    return response({ code: 0, data: { record: { fields: { [usernameColumn]: "115257", Brand: "JOM", [column]: name, Tier: "Tier 3" } } } });
  };
  return updates;
}
const body = { recordId: "recPlayer123", username: "115257", brand: "JOM", expectedName: "Mr. Wong", name: "Mr. Tan" };
const call = (changes = {}) => handler({ httpMethod: "POST", body: JSON.stringify({ ...body, ...changes }) });

for (const column of ["Title name", "Tittle name"]) {
  test(`saves only ${column} on the selected P&L player`, async (t) => {
    const updates = world(t, { column });
    const result = await call({ name: "  Mr. Tan  " });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(updates, [{ [column]: "Mr. Tan" }]);
    assert.equal(JSON.parse(result.body).customerName, "Mr. Tan");
  });
}
test("rejects another username or brand without writing", async (t) => {
  const updates = world(t);
  for (const change of [{ username: "other" }, { brand: "LPK" }]) assert.equal((await call(change)).statusCode, 409);
  assert.equal(updates.length, 0);
});
test("also supports P&L files using Username/UID", async (t) => {
  const updates = world(t, { usernameColumn: "Username/UID" });
  assert.equal((await call()).statusCode, 200);
  assert.deepEqual(updates, [{ "Title name": "Mr. Tan" }]);
});
test("rejects a stale name and read-only formula column", async (t) => {
  const updates = world(t, { type: 20 });
  assert.equal((await call({ expectedName: "Old name" })).statusCode, 409);
  assert.equal((await call()).statusCode, 409);
  assert.equal(updates.length, 0);
});
test("rejects blank, oversized, multiline names and malformed requests", async () => {
  for (const name of [" ", "x".repeat(201), "a\nb"]) assert.equal((await call({ name })).statusCode, 400);
  assert.equal((await handler({ httpMethod: "POST", body: "null" })).statusCode, 400);
  assert.equal((await handler({ httpMethod: "POST", body: "{" })).statusCode, 400);
  assert.equal((await handler({ httpMethod: "GET" })).statusCode, 405);
});
test("a failed write is not reported as saved", async (t) => {
  world(t, { fail: true });
  const result = await call();
  assert.equal(result.statusCode, 502);
  assert.equal(JSON.parse(result.body).ok, false);
});
test("retrying an already saved name succeeds without another write", async (t) => {
  const updates = world(t, { name: "Mr. Tan" });
  assert.equal((await call()).statusCode, 200);
  assert.equal(updates.length, 0);
});
