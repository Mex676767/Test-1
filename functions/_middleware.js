const HIDDEN_PREFIXES = [
  "/claude-lookup-review", "/tests", "/scripts", "/mockups", "/output", "/functions", "/node_modules",
  "/.claude", "/.git", "/.wrangler", "/.playwright-cli",
  "/widget-release.json",
];
const HIDDEN_ROOT_FILE = /^\/[^/]+\.(md|ps1|zip|log)$/;
const HIDDEN_DOT_ROOT = /^\/\./;

export function normalizePath(pathname) {
  let path = String(pathname || "/");
  try { path = decodeURIComponent(path); } catch (_) { }
  return path.replace(/\/{2,}/g, "/").toLowerCase();
}

export function isHiddenPath(pathname) {
  const path = normalizePath(pathname);
  if (HIDDEN_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + "/"))) return true;
  return HIDDEN_ROOT_FILE.test(path) || HIDDEN_DOT_ROOT.test(path);
}

export async function onRequest(context) {
  if (isHiddenPath(new URL(context.request.url).pathname)) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  return context.next();
}
