import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isHiddenPath, onRequest } from "./_middleware.js";

const WIDGET_AND_API = [
  "/", "/index.html", "/app.js", "/style.css", "/deployment-refresh.js", "/vendor/livechat-agentapp-1.16.0.min.js",
  "/blast/index.html", "/blast/popup.js", "/blast/web-adapter.js", "/knowledge/", "/knowledge/index.html",
  "/bonus-admin.html", "/lark-search", "/lark-record", "/widget-version", "/app-bootstrap", "/livechat-chat-status", "/ticket-create",
  "/robots.txt", "/favicon.ico", "/release.json",
];
const HIDDEN = [
  "/claude-lookup-review/worker-v2-deploy/wrangler.jsonc", "/claude-lookup-review", "/tests/deployment-refresh.test.mjs", "/scripts/deploy.ps1",
  "/DEPLOYMENT.md", "/BLAST_INTEGRATION.md", "/TICKET_INTEGRATION.md", "/notes.md", "/something.zip", "/mockups/console-ui-concepts.html",
  "/functions/lark-search.js", "/.claude/launch.json", "/.git/config", "/.wrangler/state", "/node_modules/x/index.js", "/output/playwright/a.png",
];

test("widget files and API endpoints are never hidden", () => {
  for (const path of WIDGET_AND_API) assert.equal(isHiddenPath(path), false, path);
});

test("non-widget files are hidden", () => {
  for (const path of HIDDEN) assert.equal(isHiddenPath(path), true, path);
});

test("case, percent-encoding and repeated slashes do not get around it", () => {
  for (const path of ["/TESTS/a.mjs", "/Claude-Lookup-Review/x", "/%74ests/a.mjs", "/%63laude-lookup-review/README.md", "//tests//a.mjs", "/scripts/../scripts/deploy.ps1", "/DEPLOYMENT.MD"]) {
    assert.equal(isHiddenPath(new URL("https://x.test" + path).pathname), true, path);
  }
  assert.equal(isHiddenPath("/%E0%A4%A"), false, "a malformed escape does not throw and is not hidden");
});

test("onRequest answers a plain 404 for hidden paths and passes everything else on untouched", async () => {
  let passed = 0;
  const context = (path, method = "GET") => ({ request: new Request("https://x.test" + path, { method }), next: async () => { passed += 1; return new Response("from next"); } });
  const hidden = await onRequest(context("/claude-lookup-review/README.md"));
  assert.equal(hidden.status, 404);
  assert.equal(await hidden.text(), "Not found");
  assert.equal(hidden.headers.get("Cache-Control"), "no-store");
  assert.equal(passed, 0, "hidden paths never reach the next handler");
  for (const [path, method] of [["/lark-search", "POST"], ["/app.js", "GET"], ["/widget-version", "GET"], ["/", "GET"], ["/blast/popup.js", "GET"]]) {
    const response = await onRequest(context(path, method));
    assert.equal(await response.text(), "from next", `${method} ${path}`);
  }
  assert.equal(passed, 5);
});

test("_routes.json is valid and keeps API routes and hidden paths inside Functions while the widget's own files bypass it", () => {
  const routes = JSON.parse(readFileSync(new URL("../_routes.json", import.meta.url), "utf8"));
  assert.equal(routes.version, 1);
  assert.deepEqual(routes.include, ["/*"]);
  assert.ok(routes.include.length + routes.exclude.length <= 100);
  assert.ok(routes.exclude.every((rule) => typeof rule === "string" && rule.startsWith("/")));
  const excluded = (path) => routes.exclude.some((rule) => rule === path || (rule.endsWith("/*") && path.startsWith(rule.slice(0, -1))));
  for (const path of ["/app.js", "/style.css", "/index.html", "/", "/deployment-refresh.js", "/blast/popup.js", "/vendor/x.js", "/knowledge/index.html"]) {
    assert.equal(excluded(path), true, `${path} is served straight from static assets`);
  }
  for (const path of [...HIDDEN, "/lark-search", "/widget-version", "/lark-record", "/ticket-create"]) {
    assert.equal(excluded(path), false, `${path} must still pass through Functions`);
  }
});

test("every committed top-level path is classified: served as the widget, hidden by the middleware, or a function route", () => {
  let tracked;
  try { tracked = execFileSync("git", ["ls-files"], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).split("\n").filter(Boolean); }
  catch (_) { return; }       // not a git checkout (e.g. a source archive): nothing to check
  const widget = new Set(["index.html", "app.js", "style.css", "deployment-refresh.js", "vendor", "blast", "knowledge",
    "bonus-admin.html", "bonus-admin.css", "bonus-admin.js"]);
  const config = new Set(["_headers", "_routes.json", ".gitignore", "functions"]);
  const unclassified = new Set();
  for (const file of tracked) {
    const top = file.split("/")[0];
    if (widget.has(top) || config.has(top)) continue;
    if (isHiddenPath("/" + file)) continue;
    unclassified.add(top);
  }
  assert.deepEqual([...unclassified], [], "these top-level paths would be PUBLICLY SERVED but are neither widget files nor hidden: add them to the widget list in _routes.json or to the middleware's hidden list");
});
