// The QA page (/qa/, also the QA tab of the admin preview): runs the crosscheck (see scan.js) from the browser and shows the agents with
// the most chats nobody recorded, with a .csv for QA. Read-only: nothing is written to Lark or anywhere else.
import { attachDatePicker } from "./datepicker.js";
import { archiveLink, classifyEntries, countMarks, createClient, dropOwnUntracked, loadLogged, loadTicks, MARK_LABELS, loggedIssues, loggedLink, myt, planAll, scanChats, sortedEntries, summarize, summarizeLogged, toCsv, toLoggedCsv, windows } from "./scan.js";

const $ = (id) => document.getElementById(id);
const store = {
  get(key) { try { return localStorage.getItem(key) || ""; } catch (_) { return ""; } },
  set(key, value) { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch (_) { /* private window: simply not remembered */ } },
};
const FROM = "qa-from";
const WINDOW_MS = 6 * 3_600_000;
const MYT = "+08:00";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dayInMyt = (ms) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);

let result = null; // { entries, byEmail, from, to } of the last finished scan
let running = false;
let currentRun = null; // { stopped } of the scan on screen: every scan has its own flag, so a stopped scan stays stopped when the next one starts

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

// ---- Sign in with LiveChat ----------------------------------------------------------------------------------------------
// The same popup login the widget uses (see /livechat-oauth-config and blast/oauth.html); the token is kept per browser tab under
// the widget's own keys. The server decides who may read: a login marked QA in the Agent Logins table, or the admin's scan key.
const TOKEN = (account) => `ca-livechat-agent-token:${account}`;
const EXPIRY = (account) => `ca-livechat-agent-token-expiry:${account}`;
const PREFERRED = "qa-account";
let login = null; // { account, token } once the server has accepted a LiveChat sign-in

const session = {
  get(key) { try { return sessionStorage.getItem(key) || ""; } catch (_) { return ""; } },
  set(key, value) { try { sessionStorage.setItem(key, value); } catch (_) { /* not remembered */ } },
  remove(key) { try { sessionStorage.removeItem(key); } catch (_) { /* nothing to forget */ } },
};
const storedToken = (account) => (Number(session.get(EXPIRY(account))) > Date.now() ? session.get(TOKEN(account)) : "");
const forgetToken = (account) => { session.remove(TOKEN(account)); session.remove(EXPIRY(account)); };

// Asks the server to accept this sign-in: a cheap read-only step. Throws the site's own refusal (401 = not this account or expired,
// 403 = signed in but not marked QA).
async function acceptLogin(candidate) {
  await createClient({ base: "", login: candidate, pauseMs: 0, retries: 1 })({ step: "agents" });
  login = candidate;
  session.set(PREFERRED, candidate.account);
  showSignedIn(true);
}

function showSignedIn(on) {
  $("signInBtn").hidden = on;
  $("signOutBtn").hidden = !on;
  $("who").textContent = on ? `Signed in with LiveChat (account ${login.account.replace("lc", "")}).` : "Sign in with the LiveChat account you use for QA. Only people marked QA get in.";
  $("who").classList.remove("error");
}

function authorize(client, redirectUri) {
  return new Promise((resolve, reject) => {
    const state = crypto.randomUUID();
    let origin = location.origin;
    try { origin = new URL(redirectUri).origin; } catch (_) { /* same site */ }
    const url = new URL("https://accounts.livechat.com/");
    url.search = new URLSearchParams({ response_type: "token", client_id: client.clientId, redirect_uri: redirectUri, state, prompt: "consent" }).toString();
    const popup = window.open(url, "livechat-agent-oauth", "popup=yes,width=560,height=720");
    if (!popup) return reject(Object.assign(new Error("Your browser blocked the LiveChat login window. Allow popups and click Sign in again."), { blocked: true }));
    const finish = (settle) => { window.removeEventListener("message", onMessage); clearInterval(watch); settle(); };
    const onMessage = (event) => {
      if (event.origin !== origin || event.data?.source !== "ca-livechat-oauth" || event.data.state !== state) return;
      if (event.data.type === "SUCCESS") finish(() => resolve({ token: event.data.token, expiresAt: event.data.expiresAt }));
      else finish(() => reject(new Error(event.data.error || "LiveChat login was not completed.")));
    };
    // The window was closed without finishing: stop waiting, and do not open another one.
    const watch = setInterval(() => { if (popup.closed) finish(() => reject(Object.assign(new Error("The LiveChat window was closed before signing in."), { closed: true }))); }, 700);
    window.addEventListener("message", onMessage);
  });
}

async function signIn() {
  $("signInBtn").disabled = true;
  setStatus("Complete the login in the new window…");
  try {
    const config = await (await fetch("/livechat-oauth-config", { cache: "no-store" })).json();
    const clients = Array.isArray(config.clients) ? config.clients : [];
    if (!clients.length) throw new Error("LiveChat login is not configured on this site.");
    const preferred = session.get(PREFERRED);
    const ordered = [...clients].sort((a, b) => Number(b.key === preferred) - Number(a.key === preferred));
    const redirectUri = config.redirectUri || `${location.origin}/blast/oauth.html`;
    let lastError = null;
    for (const client of ordered) {
      try {
        const { token, expiresAt } = await authorize(client, redirectUri);
        session.set(TOKEN(client.key), token);
        session.set(EXPIRY(client.key), String(expiresAt));
        await acceptLogin({ account: client.key, token });
        setStatus("");
        return;
      } catch (error) {
        forgetToken(client.key);
        if (error.closed || error.blocked || error.status === 403) throw error; // not a wrong-account problem: do not try the other one
        lastError = error; // the other LiveChat account may be this person's
        session.set(PREFERRED, ordered.find((other) => other.key !== client.key)?.key || client.key);
      }
    }
    throw lastError || new Error("LiveChat login was not completed.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    $("signInBtn").disabled = false;
  }
}

function signOut() {
  if (login) forgetToken(login.account);
  login = null;
  showSignedIn(false);
  setStatus("");
}

// A sign-in still valid in this tab (from the widget or an earlier visit) is accepted quietly; a refusal just leaves the button.
async function resumeSignIn() {
  for (const account of ["lc1", "lc2"]) {
    const token = storedToken(account);
    if (!token) continue;
    try { await acceptLogin({ account, token }); return; } catch (_) { /* wrong account, expired, or not QA: the button stays */ }
  }
}

// ---- Scan ----
// Two views share the sign-in and the dates: what agents LOGGED (Customer Approaching rows, to compare with the chat) and the
// chats nobody logged at all (unknown chats).
let mode = "logged";
let logged = null; // { rows, byEmail, from, to } of the last finished "logged" read

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function render() {
  const { byEmail } = result;
  const all = countMarks(result.entries);
  const entries = $("onlyNotTicked").checked ? result.entries.filter((entry) => entry.mark === "not-ticked") : result.entries;
  const ranking = summarize(entries);
  $("results").hidden = false;
  $("summary").textContent = result.entries.length
    ? `${plural(result.entries.length, "unrecorded chat")} · ${plural(summarize(result.entries).length, "agent")} · ${all.ticked} ticked Unknown · ${all.notTicked} left without ticking${all.untracked ? ` · ${all.untracked} before tracking` : ""}`
    : "No unrecorded chats in this period";
  $("download").hidden = !result.entries.length;
  $("tickNote").hidden = !all.untracked && result.tracked;
  const top = ranking.length ? ranking[0][1] : 1;
  const ordered = sortedEntries(entries);
  $("agents").innerHTML = ranking.map(([email, count], index) => {
    const name = byEmail.get(email) || "";
    const chats = ordered.filter((entry) => entry.email === email);
    const marks = countMarks(chats);
    return `<div class="uc-agent" data-email="${escapeHtml(email)}">
      <button type="button" aria-expanded="false">
        <span class="uc-rank">${index + 1}</span>
        <span class="uc-name"><b>${escapeHtml(name || email)}</b><span>${escapeHtml(email)}</span><span class="uc-marks">${marks.ticked} ticked Unknown · ${marks.notTicked} left without ticking${marks.untracked ? ` · ${marks.untracked} before tracking` : ""}</span></span>
        <span class="uc-meter" style="width:${Math.max(4, Math.round((count / top) * 100))}%"></span>
        <span class="uc-count">${count}</span>
      </button>
      <div class="uc-chats" hidden><table>
        <thead><tr><th>Date (MYT)</th><th>Customer</th><th>Agent's mark</th><th>Agent msgs</th><th>Customer msgs</th><th></th></tr></thead>
        <tbody>${chats.map((entry) => `<tr><td>${escapeHtml(myt(entry.date))}</td><td>${escapeHtml(entry.customer)}</td><td class="uc-mark ${escapeHtml(entry.mark || "")}">${escapeHtml(MARK_LABELS[entry.mark] || "")}</td><td>${entry.agentMessages ?? ""}</td><td>${entry.customerMessages ?? ""}</td><td><a href="${escapeHtml(archiveLink(entry.threadId))}" target="_blank" rel="noopener noreferrer">Open chat ↗</a></td></tr>`).join("")}</tbody>
      </table></div>
    </div>`;
  }).join("");
}

// What each agent logged, busiest first; "only incomplete" narrows every agent to the rows with something missing.
function renderLogged() {
  const { rows } = logged;
  const onlyIncomplete = $("onlyIncomplete").checked;
  const shown = onlyIncomplete ? rows.filter((row) => loggedIssues(row).length) : rows;
  const ranking = summarizeLogged(shown);
  const incomplete = rows.filter((row) => loggedIssues(row).length).length;
  $("loggedResults").hidden = false;
  $("loggedSummary").textContent = rows.length
    ? `${plural(rows.length, "logged chat")} · ${plural(summarizeLogged(rows).length, "agent")} · ${incomplete} with something missing`
    : "Nothing was logged in this period";
  $("loggedDownload").hidden = !rows.length;
  const top = ranking.length ? ranking[0].total : 1;
  const byAgent = new Map();
  for (const row of shown) {
    const key = String(row.agent || "").trim().toLowerCase() || "(no agent name)";
    if (!byAgent.has(key)) byAgent.set(key, []);
    byAgent.get(key).push(row);
  }
  $("loggedAgents").innerHTML = ranking.map((entry, index) => {
    const list = (byAgent.get(entry.agent.toLowerCase()) || []).sort((a, b) => b.createdAt - a.createdAt);
    return `<div class="uc-agent">
      <button type="button" aria-expanded="false">
        <span class="uc-rank">${index + 1}</span>
        <span class="uc-name"><b>${escapeHtml(entry.agent)}</b>${entry.incomplete ? `<span class="uc-warn">${entry.incomplete} with something missing</span>` : ""}</span>
        <span class="uc-meter" style="width:${Math.max(4, Math.round((entry.total / top) * 100))}%"></span>
        <span class="uc-count">${entry.total}</span>
      </button>
      <div class="uc-chats" hidden><table>
        <thead><tr><th>Date (MYT)</th><th>Player</th><th>Brand</th><th>Inquiry</th><th>Status</th><th>Amount</th><th>Missing</th><th></th></tr></thead>
        <tbody>${list.map((row) => {
          const issues = loggedIssues(row);
          const link = loggedLink(row);
          return `<tr><td>${escapeHtml(myt(row.createdAt))}</td><td>${escapeHtml(row.username)}</td><td>${escapeHtml(row.brand)}</td><td>${escapeHtml((row.inquiry || []).join(", "))}</td><td>${escapeHtml(row.status)}</td><td>${row.amount ?? ""}</td><td class="uc-warn">${escapeHtml(issues.join(", "))}</td><td>${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Open chat ↗</a>` : ""}</td></tr>`;
        }).join("")}</tbody>
      </table></div>
    </div>`;
  }).join("");
}

for (const id of ["agents", "loggedAgents"]) {
  $(id).addEventListener("click", (event) => {
    const button = event.target.closest(".uc-agent > button");
    if (!button) return;
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(open));
    button.parentElement.querySelector(".uc-chats").hidden = !open;
  });
}

function setMode(next) {
  mode = next;
  for (const button of document.querySelectorAll("[data-mode]")) button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  $("run").textContent = mode === "logged" ? "Show what agents logged" : "Find unknown chats";
  $("loggedPanel").hidden = mode !== "logged";
  $("unknownPanel").hidden = mode !== "unknown";
  $("notes").hidden = mode !== "unknown" || !$("log").textContent;
}

function setRunning(value) {
  running = value;
  $("run").disabled = value;
  $("stop").hidden = !value;
  $("bar").hidden = !value;
  for (const button of document.querySelectorAll("[data-mode]")) button.disabled = value;
}

async function find(event) {
  event.preventDefault();
  if (running) return;
  const key = $("key").value.trim();
  const from = $("from").value;
  const to = $("to").value;
  const fromMs = Date.parse(`${from}T00:00:00${MYT}`);
  const toMs = to ? Math.min(Date.parse(`${to}T23:59:59.999${MYT}`), Date.now()) : Date.now();
  if (!login && !key) return setStatus("Sign in with LiveChat first.", true);
  if (!Number.isFinite(fromMs) || fromMs >= toMs) return setStatus("Pick a start date that is before the end date.", true);
  store.set(FROM, from);

  setRunning(true);
  const run = { stopped: false };
  currentRun = run;
  $("bar").firstElementChild.style.width = "0";
  const step = createClient({ base: "", ...(login ? { login } : { key }) });
  try {
    if (mode === "logged") await findLogged({ step, fromMs, toMs, run });
    else await findUnknown({ step, fromMs, toMs, run });
  } catch (error) {
    if (error.cancelled) setStatus("Stopped.");
    else if (error.status === 404) setStatus("This page is not switched on yet. Ask the admin.", true);
    else if (error.status === 401 || error.status === 403) {
      if (login && error.loginExpired) signOut();
      setStatus(error.message, true);
    } else setStatus(error.message, true);
  } finally {
    setRunning(false);
  }
}

async function findLogged({ step, fromMs, toMs, run }) {
  $("loggedResults").hidden = true;
  setStatus("Reading what agents logged…");
  const read = await loadLogged({ step, fromMs, toMs, isCancelled: () => run.stopped, onProgress: (scanned) => !run.stopped && setStatus(`Reading what agents logged… ${scanned} rows checked`) });
  logged = { rows: read.rows, byEmail: read.byEmail, from: dayInMyt(fromMs), to: dayInMyt(toMs) };
  renderLogged();
  setStatus(`Done. ${plural(read.rows.length, "logged chat")} found.`);
}

async function findUnknown({ step, fromMs, toMs, run }) {
  // The first line of the scan appears only after the whole Customer Approaching table is read: say so, instead of leaving the last message.
  setStatus("Reading Customer Approaching… this can take a minute.");
  $("results").hidden = true;
  $("notes").hidden = false;
  $("log").textContent = "";
  const lines = [];
  // Every finished time window of either LiveChat account moves the bar (two accounts read the same windows).
  const expectedWindows = windows(fromMs, toMs, WINDOW_MS).length * 2;
  let finishedWindows = 0;
  const note = (line, meta) => {
    if (run.stopped) return; // a stopped scan may still finish a request in the background: it must not write over the next one
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
  const scan = await scanChats({ step, fromMs, toMs, windowMs: WINDOW_MS, onlyKnown: true, log: note, isCancelled: () => run.stopped });
  const entries = planAll(scan, { onlyKnown: true, log: note });
  note("Reading the Unknown ticks agents made…");
  const tickData = await loadTicks(step);
  classifyEntries(entries, tickData, scan.byEmail);
  const shown = await dropOwnUntracked(entries);
  result = { entries: shown, byEmail: scan.byEmail, from: dayInMyt(fromMs), to: dayInMyt(toMs), tracked: tickData.configured && tickData.since > 0 };
  render();
  setStatus(`Done. ${plural(shown.length, "chat")} found.`);
}

function saveCsv(text, name) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

attachDatePicker($("toPicker"));
attachDatePicker($("fromPicker")).setValue(store.get(FROM) || dayInMyt(Date.now() - 7 * 86_400_000));
$("form").addEventListener("submit", find);
$("stop").addEventListener("click", () => { if (currentRun) currentRun.stopped = true; setStatus("Stopping…"); });
$("download").addEventListener("click", () => { if (result) saveCsv(toCsv(result.entries, result.byEmail), `qa-unknown-chats_${result.from}_to_${result.to}.csv`); });
$("loggedDownload").addEventListener("click", () => { if (logged) saveCsv(toLoggedCsv(logged.rows), `qa-logged-chats_${logged.from}_to_${logged.to}.csv`); });
$("onlyIncomplete").addEventListener("change", () => { if (logged) renderLogged(); });
$("onlyNotTicked").addEventListener("change", () => { if (result) render(); });
for (const button of document.querySelectorAll("[data-mode]")) button.addEventListener("click", () => setMode(button.dataset.mode));
$("signInBtn").addEventListener("click", signIn);
$("signOutBtn").addEventListener("click", signOut);
setMode("logged");
resumeSignIn();
