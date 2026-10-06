// This Pages project's output directory is the REPOSITORY ROOT, so every committed file is public unless something says
// otherwise: docs, the deploy script, the test suite, the Durable Object source. None of it holds credentials, but none of it
// belongs on the public internet either. The widget needs only its own files (see _routes.json for the list that bypasses
// this middleware); everything below is answered with a plain 404.
//
// Not authentication: it hides non-widget files. API endpoints are unchanged (see the security notes about auth).
const HIDDEN_PREFIXES = [
  "/claude-lookup-review", "/tests", "/scripts", "/mockups", "/output", "/functions", "/node_modules",
  "/.claude", "/.git", "/.wrangler", "/.playwright-cli",
];
const HIDDEN_ROOT_FILE = /^\/[^/]+\.(md|ps1|zip|log)$/;
// Any top-level dot-file or dot-folder (.github, .gitattributes, .claude, ...).
const HIDDEN_DOT_ROOT = /^\/\./;

export function normalizePath(pathname) {
  let path = String(pathname || "/");
  try { path = decodeURIComponent(path); } catch (_) { /* leave a malformed escape as is: it will not match anything hidden */ }
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
