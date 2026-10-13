// The "Unknown chats" page of the admin preview: runs the crosscheck (see scan.js) from the browser and shows the agents with
// the most chats nobody recorded, with a .csv for QA. Read-only: nothing is written to Lark or anywhere else.
import { archiveLink, createClient, myt, planAll, scanChats, sortedEntries, summarize, toCsv, windows } from "./scan.js";

const $ = (id) => document.getElementById(id);
const store = {
  get(key) { try { return localStorage.getItem(key) || ""; } catch (_) { return ""; } },
  set(key, value) { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch (_) { /* private window: simply not remembered */ } },
};
const KEY = "unknown-chats-key";
const EXCLUDE = "unknown-chats-exclude";
const FROM = "unknown-chats-from";
const WINDOW_MS = 6 * 3_600_000;
const MYT = "+08:00";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dayInMyt = (ms) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);

let result = null; // { entries, byEmail, from, to } of the last finished scan
let running = false;
let stopRequested = false;

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

function excludedEmails() {
  return $("exclude").value.split(/[\s,;]+/).map((email) => email.trim().toLowerCase()).filter(Boolean);
}

function render() {
  const { entries, byEmail } = result;
  const ranking = summarize(entries);
  $("results").hidden = false;
  $("summary").textContent = entries.length
    ? `${entries.length} unrecorded chat${entries.length === 1 ? "" : "s"} · ${ranking.length} agent${ranking.length === 1 ? "" : "s"}`
    : "No unrecorded chats in this period";
  $("download").hidden = !entries.length;
  const top = ranking.length ? ranking[0][1] : 1;
  const ordered = sortedEntries(entries);
  $("agents").innerHTML = ranking.map(([email, count], index) => {
    const name = byEmail.get(email) || "";
    const chats = ordered.filter((entry) => entry.email === email);
    return `<div class="uc-agent" data-email="${escapeHtml(email)}">
      <button type="button" aria-expanded="false">
        <span class="uc-rank">${index + 1}</span>
        <span class="uc-name"><b>${escapeHtml(name || email)}</b>${name ? `<span>${escapeHtml(email)}</span>` : ""}</span>
        <span class="uc-meter" style="width:${Math.max(4, Math.round((count / top) * 100))}%"></span>
        <span class="uc-count">${count}</span>
      </button>
      <div class="uc-chats" hidden><table>
        <thead><tr><th>Date (MYT)</th><th>Customer</th><th>Agent msgs</th><th>Customer msgs</th><th></th></tr></thead>
        <tbody>${chats.map((entry) => `<tr><td>${escapeHtml(myt(entry.date))}</td><td>${escapeHtml(entry.customer)}</td><td>${entry.agentMessages ?? ""}</td><td>${entry.customerMessages ?? ""}</td><td><a href="${escapeHtml(archiveLink(entry.threadId))}" target="_blank" rel="noopener noreferrer">Open chat ↗</a></td></tr>`).join("")}</tbody>
      </table></div>
    </div>`;
  }).join("");
}

$("agents").addEventListener("click", (event) => {
  const button = event.target.closest(".uc-agent > button");
  if (!button) return;
  const open = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(open));
  button.parentElement.querySelector(".uc-chats").hidden = !open;
});

function setRunning(value) {
  running = value;
  $("run").disabled = value;
  $("stop").hidden = !value;
  $("bar").hidden = !value;
}

async function find(event) {
  event.preventDefault();
  if (running) return;
  const key = $("key").value.trim();
  const from = $("from").value;
  const to = $("to").value;
  const fromMs = Date.parse(`${from}T00:00:00${MYT}`);
  const toMs = to ? Math.min(Date.parse(`${to}T23:59:59.999${MYT}`), Date.now()) : Date.now();
  if (!key) return setStatus("Enter the scan key first.", true);
  if (!Number.isFinite(fromMs) || fromMs >= toMs) return setStatus("Pick a start date that is before the end date.", true);
  store.set(KEY, key);
  store.set(EXCLUDE, $("exclude").value.trim());
  store.set(FROM, from);

  setRunning(true);
  stopRequested = false;
  $("results").hidden = true;
  $("notes").hidden = false;
  $("log").textContent = "";
  const lines = [];
  // Every finished time window of either LiveChat account moves the bar (two accounts read the same windows).
  const expectedWindows = windows(fromMs, toMs, WINDOW_MS).length * 2;
  let finishedWindows = 0;
  $("bar").firstElementChild.style.width = "0";
  const note = (line, meta) => {
    lines.push(line);
    $("log").textContent = lines.join("\n");
    if (meta) {
      finishedWindows += 1;
      const percent = Math.min(100, Math.round((finishedWindows / expectedWindows) * 100));
      $("bar").firstElementChild.style.width = `${percent}%`;
      setStatus(`Reading LiveChat archives… ${percent}%`);
    } else if (!line.startsWith(" ")) {
      setStatus(line);
    }
  };
  try {
    const step = createClient({ base: "", key });
    const scan = await scanChats({ step, fromMs, toMs, windowMs: WINDOW_MS, onlyKnown: true, log: note, isCancelled: () => stopRequested });
    const entries = planAll(scan, { onlyKnown: true, exclude: excludedEmails(), log: note });
    result = { entries, byEmail: scan.byEmail, from: dayInMyt(fromMs), to: dayInMyt(toMs) };
    render();
    setStatus(`Done. ${entries.length} chat${entries.length === 1 ? "" : "s"} found.`);
  } catch (error) {
    if (error.cancelled) setStatus("Stopped.");
    else if (error.status === 404) setStatus("The site has no SCAN_KEY set (Cloudflare Pages → Settings → Variables). Without it this page cannot read the chats.", true);
    else if (error.status === 401) setStatus("Wrong scan key.", true);
    else setStatus(error.message, true);
  } finally {
    setRunning(false);
  }
}

function download() {
  if (!result) return;
  const blob = new Blob([toCsv(result.entries, result.byEmail)], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `unknown-chats_${result.from}_to_${result.to}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

$("key").value = store.get(KEY);
$("exclude").value = store.get(EXCLUDE);
$("from").value = store.get(FROM) || dayInMyt(Date.now() - 7 * 86_400_000);
$("form").addEventListener("submit", find);
$("stop").addEventListener("click", () => { stopRequested = true; setStatus("Stopping…"); });
$("download").addEventListener("click", download);
$("forgetKey").addEventListener("click", () => { store.set(KEY, ""); $("key").value = ""; setStatus("Key forgotten."); });
