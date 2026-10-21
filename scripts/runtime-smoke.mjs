import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRANGLER = process.env.WRANGLER_VERSION || "3.114.17";
const PORT = Number(process.env.SMOKE_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const STARTUP_MS = 120_000;

const state = mkdtempSync(join(tmpdir(), "pages-smoke-"));
const useShell = process.platform === "win32";
const child = spawn(useShell ? "npx.cmd" : "npx", ["--yes", `wrangler@${WRANGLER}`, "pages", "dev", ".", "--port", String(PORT), "--ip", "127.0.0.1",
  "--compatibility-date", "2024-09-23", "--compatibility-flag", "nodejs_compat", "--persist-to", state],
  { stdio: ["ignore", "pipe", "pipe"], shell: useShell, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" } });

let log = "";
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });
let exited = null;
child.on("exit", (code) => { exited = code ?? 1; });

const stop = () => new Promise((resolve) => {
  if (exited !== null) return resolve();
  child.on("exit", resolve);
  if (useShell) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); else child.kill("SIGTERM");
  setTimeout(resolve, 5_000);
});
const fail = async (message) => {
  console.error(`runtime smoke FAILED: ${message}\n--- wrangler output (last 60 lines) ---\n${log.trim().split("\n").slice(-60).join("\n")}`);
  await stop(); rmSync(state, { recursive: true, force: true });
  process.exit(1);
};

const deadline = Date.now() + STARTUP_MS;
let hello = null;
while (Date.now() < deadline) {
  if (exited !== null) await fail(`wrangler exited early with code ${exited}`);
  try {
    const res = await fetch(`${BASE}/hello`);
    const text = await res.text();
    if (res.status === 200 && /"ok":\s*true/.test(text)) { hello = text; break; }
    if (res.status >= 500 || /Disallowed operation|Uncaught|Script startup/i.test(text + log)) await fail(`/hello answered ${res.status}: ${text.slice(0, 300)}`);
  } catch { }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
if (!hello) await fail(`no healthy answer from /hello within ${STARTUP_MS / 1000}s`);

const hidden = await fetch(`${BASE}/HANDOVER.md`);
if (hidden.status !== 404) await fail(`/HANDOVER.md should be hidden (404) but answered ${hidden.status}`);
const release = await fetch(`${BASE}/widget-release.json`);
if (release.status !== 404) await fail(`/widget-release.json should be hidden (404) but answered ${release.status}`);
const version = await fetch(`${BASE}/widget-version`);
const versionText = await version.text();
if (version.status !== 200 || !/"version":"[a-f0-9]{40}"/.test(versionText)) await fail(`/widget-version should answer a 40-hex version but answered ${version.status}: ${versionText.slice(0, 200)}`);
if (/Disallowed operation|Uncaught|Error: /.test(log.replace(/\[wrangler:[^\]]*\][^\n]*\n/g, ""))) await fail("the runtime logged an error while loading");

console.log(`runtime smoke ok: /hello -> ${hello.slice(0, 80)}...; /HANDOVER.md -> 404`);
await stop();
rmSync(state, { recursive: true, force: true });
process.exit(0);
