import assert from "node:assert/strict";
import test from "node:test";
import { handler, resetWidgetVersionCache } from "./widget-version.js";

// Fake static-asset binding: serves the given files, counting fetches.
function assets(files, { failPath } = {}) {
  const served = [];
  return {
    served,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      served.push(path);
      if (path === failPath || !(path in files)) return new Response("nope", { status: 404 });
      return new Response(files[path]);
    },
  };
}
const FILES = {
  "/": "<html>index</html>", "/app.js": "console.log('app')", "/style.css": "body{}", "/deployment-refresh.js": "// refresh",
  "/blast/index.html": "<html>blast</html>", "/blast/popup.js": "// popup", "/blast/web-adapter.js": "// adapter",
};
const get = async (env) => { const r = await handler({ httpMethod: "GET", env }); return { ...r, body: JSON.parse(r.body) }; };

test("reports a 40-hex release id, never cached by the browser", async () => {
  resetWidgetVersionCache();
  const r = await get({ ASSETS: assets(FILES) });
  assert.equal(r.statusCode, 200);
  assert.match(r.body.version, /^[a-f0-9]{40}$/);
  assert.equal(r.headers["Cache-Control"], "no-store");
});

test("the version is stable for identical files and changes when ANY client file changes", async () => {
  resetWidgetVersionCache();
  const base = (await get({ ASSETS: assets(FILES) })).body.version;
  resetWidgetVersionCache();
  assert.equal((await get({ ASSETS: assets({ ...FILES }) })).body.version, base, "same files, same version");
  for (const path of Object.keys(FILES)) {
    resetWidgetVersionCache();
    const changed = (await get({ ASSETS: assets({ ...FILES, [path]: FILES[path] + " " }) })).body.version;
    assert.notEqual(changed, base, `changing ${path} changes the version`);
  }
});

test("moving content between files does not collide (paths are part of the hash)", async () => {
  resetWidgetVersionCache();
  const a = (await get({ ASSETS: assets({ ...FILES, "/app.js": "AB", "/style.css": "C" }) })).body.version;
  resetWidgetVersionCache();
  const b = (await get({ ASSETS: assets({ ...FILES, "/app.js": "A", "/style.css": "BC" }) })).body.version;
  assert.notEqual(a, b);
});

test("the hash is computed once per 30 s per isolate, not on every poll from every widget", async () => {
  resetWidgetVersionCache();
  const binding = assets(FILES);
  await get({ ASSETS: binding }); await get({ ASSETS: binding }); await get({ ASSETS: binding });
  assert.equal(binding.served.length, 7, "one read of each of the seven files in total");
});

test("an unreadable asset or a missing binding is a 503, never a made-up version", async () => {
  resetWidgetVersionCache();
  const broken = await get({ ASSETS: assets(FILES, { failPath: "/app.js" }) });
  assert.equal(broken.statusCode, 503);
  assert.equal(broken.body.ok, false);
  assert.equal(broken.body.version, undefined);
  resetWidgetVersionCache();
  assert.equal((await get({})).statusCode, 503);
  resetWidgetVersionCache();
  const ok = await get({ ASSETS: assets(FILES) });
  assert.equal(ok.statusCode, 200, "a failure is not cached");
});

test("only GET is allowed", async () => {
  const r = await handler({ httpMethod: "POST", env: { ASSETS: assets(FILES) } });
  assert.equal(r.statusCode, 405);
});
