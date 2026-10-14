// The QA page (/qa/, also the QA tab of the admin preview): runs the crosscheck (see scan.js) from the browser and shows the agents with
// the most chats nobody recorded, with a .csv for QA. Read-only: nothing is written to Lark or anywhere else.
import { attachAgentPicker } from "./agentpicker.js";
import { createCache } from "./cache.js";
import { attachDatePicker } from "./datepicker.js";
import { agentChoices, alignedWindows, describeChatLog, threadFromInput, archiveLink, checkKnownUsernames, classifyEntries, countMarks, createClient, dropOwnUntracked, loadLogged, loadTicks, MARK_LABELS, loggedIssues, loggedLink, myt, planAll, scanChats, sortedEntries, summarize, summarizeLogged, toCsv, toLoggedCsv, windows } from "./scan.js";

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
const cache = createCache(); // saved results of earlier searches (this browser only), emptied on sign-out
let agentPicker = null;
let agentsLoaded = false;
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
function setSignInStatus(text, isError = false) {
  $("signinStatus").textContent = text;
  $("signinStatus").classList.toggle("error", isError);
}

async function acceptLogin(candidate) {
  const data = await createClient({ base: "", login: candidate, pauseMs: 0, retries: 1 })({ step: "agents" });
  login = candidate;
  if (data && data.ok) { agentPicker?.setChoices(agentChoices(data.agents)); agentsLoaded = true; }
  session.set(PREFERRED, candidate.account);
  showSignedIn(true);
  if (chatThread) showChat(chatThread); // a chat was opened before the sign-in finished
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
  setSignInStatus("Complete the login in the new window…");
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
        setSignInStatus("");
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
    setSignInStatus(error.message, true);
  } finally {
    $("signInBtn").disabled = false;
  }
}

function signOut() {
  if (login) forgetToken(login.account);
  login = null;
  agentsLoaded = false;
  agentPicker?.setChoices([]);
  agentPicker?.reset();
  cache.clear();
  chatToken += 1;
  renderChatLog(null);
  showSignedIn(false);
  setSignInStatus("");
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

// ---- This chat ------------------------------------------------------------------------------------------------------------
// The chat open in LiveChat (the widget tells this page its thread id), or one pasted here: every agent's record for it, and any Unknown tick.
let chatThread = "";
let chatToken = 0; // an answer for a chat that is no longer the one on screen is dropped

// One logged case as a card shaped like the Retention card (Customer, Case details), but nothing on it can be changed.
function loggedCard(row) {
  const empty = '<span class="rc-missing">not filled in</span>';
  const chips = (list, extra = "") => (list.length ? `<div class="rc-chips">${list.map((item) => `<span class="rc-chip ${extra}">${escapeHtml(item)}</span>`).join("")}</div>` : `<div class="rc-input">${empty}</div>`);
  return `<article class="rc-card">
    <header class="rc-head"><span class="rc-agent">◉ ${escapeHtml(row.agent || "(no agent name)")}</span><span class="rc-readonly">VIEW ONLY</span></header>
    <section class="rc-section">
      <div class="rc-section-title">Customer</div>
      <div class="rc-label">Username or user ID</div>
      <div class="rc-input rc-mono">${row.username ? escapeHtml(row.username) : empty}</div>
      <div class="rc-label">Brand</div>
      <div class="rc-input">${row.brand ? escapeHtml(row.brand) : empty}</div>
      <label class="rc-unknown"><input type="checkbox" disabled /><span>Unknown player</span></label>
    </section>
    <section class="rc-section">
      <div class="rc-section-title">Case details</div>
      <div class="rc-label">Inquiry</div>
      ${chips(row.inquiry || [])}
      <div class="rc-label">Status</div>
      ${row.status ? `<div class="rc-chips"><span class="rc-chip status">${escapeHtml(row.status)}</span></div>` : `<div class="rc-input">${empty}</div>`}
      <div class="rc-label">Released amount</div>
      <div class="rc-input">${row.amount === null || row.amount === undefined ? '<span class="rc-muted">none</span>' : escapeHtml(String(row.amount))}</div>
      <div class="rc-label">Claim Secret</div>
      <label class="rc-unknown"><input type="checkbox" disabled ${row.claimSecret ? "checked" : ""} /><span>${row.claimSecret ? "✓ Ticked" : "— Not ticked"}</span></label>
      ${row.telegram ? '<div class="rc-label">Telegram</div><div class="rc-input">Yes</div>' : ""}
    </section>
    <footer class="rc-foot">Logged ${escapeHtml(myt(row.createdAt))} (Malaysia time)</footer>
  </article>`;
}

// An agent ticked Unknown player on this chat: that is all the system keeps, shown on a card of the same shape.
function tickCard(tick) {
  return `<article class="rc-card rc-card-unknown">
    <header class="rc-head"><span class="rc-agent">◉ ${escapeHtml(tick.agent)}</span><span class="rc-readonly">VIEW ONLY</span></header>
    <section class="rc-section">
      <div class="rc-section-title">Customer</div>
      <label class="rc-unknown"><input type="checkbox" checked disabled /><span>Unknown player</span></label>
      <p class="rc-note">${escapeHtml(tick.label)}. Nothing else is recorded for an Unknown player.</p>
    </section>
    <footer class="rc-foot">Ticked ${escapeHtml(myt(tick.at))} (Malaysia time)</footer>
  </article>`;
}

function renderChatLog(info, message = "") {
  const box = $("chatResult");
  if (!info) {
    box.hidden = !message;
    box.innerHTML = message ? `<p class="uc-hint">${escapeHtml(message)}</p>` : "";
    return;
  }
  box.hidden = false;
  box.innerHTML = `<div class="uc-verdict ${info.verdict}">${escapeHtml(info.headline)}</div>
    ${info.rows.map(loggedCard).join("")}${info.ticks.map(tickCard).join("")}
    ${info.rows.some((row) => row.issues.length) ? `<p class="uc-hint uc-warn">Missing: ${escapeHtml([...new Set(info.rows.flatMap((row) => row.issues))].join(", "))}</p>` : ""}
    ${info.note ? `<p class="uc-hint">${escapeHtml(info.note)}</p>` : ""}`;
}

async function showChat(threadId) {
  chatThread = threadId;
  const mine = (chatToken += 1);
  if (!threadId) return renderChatLog(null);
  const key = $("key").value.trim();
  if (!login && !key) return renderChatLog(null, "Sign in with LiveChat to see how this chat was logged.");
  renderChatLog(null, "Looking up how this chat was logged…");
  try {
    const step = createClient({ base: "", ...(login ? { login } : { key }), pauseMs: 0, retries: 2 });
    const data = await step({ step: "chatlog", threadId });
    if (mine !== chatToken) return;
    if (!data.ok) throw new Error(data.error || "Could not read this chat.");
    renderChatLog(describeChatLog(data));
  } catch (error) {
    if (mine !== chatToken) return;
    if (error.status === 401 && login && error.loginExpired) signOut();
    renderChatLog(null, error.message);
  }
}

$("chatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const threadId = threadFromInput($("chatInput").value);
  if (!threadId) return renderChatLog(null, "That is not a LiveChat chat link or thread id.");
  showChat(threadId);
});

// Inside the widget, the page around us says which chat is open in LiveChat (and is asked once when this page has loaded).
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== window.parent || event.data?.source !== "ca-qa-chat") return;
  $("chatInput").value = "";
  showChat(String(event.data.threadId || ""));
});
if (window.parent !== window) { try { window.parent.postMessage({ source: "ca-qa-ready" }, location.origin); } catch (_) { /* standalone */ } }

// ---- Scan ----
// Two views share the sign-in and the dates: what agents LOGGED (Customer Approaching rows, to compare with the chat) and the
// chats nobody logged at all (unknown chats).
let mode = "logged";
let logged = null; // { rows, byEmail, from, to } of the last finished "logged" read

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function render() {
  const { byEmail } = result;
  const all = countMarks(result.entries);
  const entries = result.entries.filter((entry) => (!$("onlyNotTicked").checked || entry.mark === "not-ticked") && (!$("onlyKnownUser").checked || entry.knownUsername));
  const knownCount = result.entries.filter((entry) => entry.knownUsername).length;
  const ranking = summarize(entries);
  $("results").hidden = false;
  $("summary").textContent = result.entries.length
    ? `${plural(result.entries.length, "unrecorded chat")} · ${plural(summarize(result.entries).length, "agent")} · ${all.ticked} ticked Unknown · ${all.notTicked} left without ticking${all.untracked ? ` · ${all.untracked} before tracking` : ""}${knownCount ? ` · ${knownCount} ticked although a username was on file` : ""}`
    : "No unrecorded chats in this period";
  $("download").hidden = !result.entries.length;
  $("tickNote").hidden = !all.untracked && result.tracked;
  const top = ranking.length ? ranking[0][1] : 1;
  const ordered = sortedEntries(entries);
  $("agents").innerHTML = ranking.map(([email, count], index) => {
    const name = byEmail.get(email) || "";
    const chats = ordered.filter((entry) => entry.email === email);
    const marks = countMarks(chats);
    const known = chats.filter((entry) => entry.knownUsername).length;
    return `<div class="uc-agent" data-email="${escapeHtml(email)}">
      <button type="button" aria-expanded="false">
        <span class="uc-rank">${index + 1}</span>
        <span class="uc-name"><b>${escapeHtml(name || email)}</b><span>${escapeHtml(email)}</span><span class="uc-marks">${marks.ticked} ticked Unknown · ${marks.notTicked} left without ticking${marks.untracked ? ` · ${marks.untracked} before tracking` : ""}</span>${known ? `<span class="uc-flagline">${known} ticked Unknown although a username was already on file</span>` : ""}</span>
        <span class="uc-meter" style="width:${Math.max(4, Math.round((count / top) * 100))}%"></span>
        <span class="uc-count">${count}</span>
      </button>
      <div class="uc-chats" hidden><table>
        <thead><tr><th>Date (MYT)</th><th>Customer</th><th>Agent's mark</th><th>Agent msgs</th><th>Customer msgs</th><th></th></tr></thead>
        <tbody>${chats.map((entry) => `<tr class="${entry.knownUsername ? "uc-flagged" : ""}"><td>${escapeHtml(myt(entry.date))}</td><td>${escapeHtml(entry.customer)}</td><td class="uc-mark ${escapeHtml(entry.mark || "")}">${escapeHtml(MARK_LABELS[entry.mark] || "")}${entry.knownUsername ? `<span class="uc-badge-known">Already had username: ${escapeHtml(entry.knownUsername)}</span>` : ""}</td><td>${entry.agentMessages ?? ""}</td><td>${entry.customerMessages ?? ""}</td><td><a href="${escapeHtml(archiveLink(entry.threadId))}" target="_blank" rel="noopener noreferrer">Open chat ↗</a></td></tr>`).join("")}</tbody>
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
    const options = { step, fromMs, toMs, run, fresh: $("fresh").checked, only: { names: agentPicker.selectedNames(), emails: agentPicker.selectedEmails() }, cacheKey: `${from}:${to || "now"}` };
    if (mode === "logged") await findLogged(options);
    else await findUnknown(options);
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

async function findLogged({ step, fromMs, toMs, run, fresh, only, cacheKey }) {
  $("loggedResults").hidden = true;
  setStatus("Reading what agents logged…");
  const read = await loadLogged({ step, fromMs, toMs, only: only.names, cache, cacheKey, fresh, isCancelled: () => run.stopped, onProgress: (scanned) => !run.stopped && setStatus(`Reading what agents logged… ${scanned} rows checked`) });
  logged = { rows: read.rows, byEmail: read.byEmail, from: dayInMyt(fromMs), to: dayInMyt(toMs) };
  renderLogged();
  setStatus(`Done. ${plural(read.rows.length, "logged chat")} found${read.fromSaved ? " (from saved results: tick \"Read everything again\" for the latest)" : ""}.`);
}

async function findUnknown({ step, fromMs, toMs, run, fresh, only }) {
  // The first line of the scan appears only after the whole Customer Approaching table is read: say so, instead of leaving the last message.
  setStatus("Reading Customer Approaching… this can take a minute.");
  $("results").hidden = true;
  $("notes").hidden = false;
  $("log").textContent = "";
  const lines = [];
  // Every finished time window of either LiveChat account moves the bar (two accounts read the same windows).
  const expectedWindows = alignedWindows(fromMs, toMs, WINDOW_MS).length * 2;
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
  const scan = await scanChats({ step, fromMs, toMs, windowMs: WINDOW_MS, onlyKnown: true, log: note, isCancelled: () => run.stopped, cache, fresh });
  const entries = planAll(scan, { onlyKnown: true, only: only.emails, log: note });
  note("Reading the Unknown ticks agents made…");
  const tickData = await loadTicks(step);
  classifyEntries(entries, tickData, scan.byEmail);
  const shown = await dropOwnUntracked(entries);
  // Chats ticked Unknown whose customer already had a player username on file: the lookup is per chat, so it comes last, on what is left.
  if (shown.some((entry) => entry.mark === "ticked")) {
    note("Checking whether the customers of ticked chats already had a username…");
    const lookup = await checkKnownUsernames(shown, step, { cache, fresh, isCancelled: () => run.stopped, onProgress: (done, total) => !run.stopped && setStatus(`Checking ticked chats for a username on file… ${done}/${total}`) });
    note(`${lookup.found} of ${lookup.checked} ticked chats had a username on file${lookup.failed ? `; ${lookup.failed} could not be checked` : ""}.`);
  }
  result = { entries: shown, byEmail: scan.byEmail, from: dayInMyt(fromMs), to: dayInMyt(toMs), tracked: tickData.configured && tickData.since > 0 };
  render();
  const savedWindows = scan.results.reduce((sum, item) => sum + item.fromSaved, 0);
  setStatus(`Done. ${plural(shown.length, "chat")} found${savedWindows ? ` (${savedWindows} time windows from saved results)` : ""}.`);
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
$("onlyKnownUser").addEventListener("change", () => { if (result) render(); });
for (const button of document.querySelectorAll("[data-mode]")) button.addEventListener("click", () => setMode(button.dataset.mode));
$("signInBtn").addEventListener("click", signIn);
$("signOutBtn").addEventListener("click", signOut);
// The "who to check" list: filled when the person signs in; with the admin's scan key it is read when the list is opened.
agentPicker = attachAgentPicker($("agentPicker"), {
  onOpen: async () => {
    if (agentsLoaded) return;
    const key = $("key").value.trim();
    if (!login && !key) { agentPicker.setMessage("Sign in first to see the agents."); return; }
    agentPicker.setMessage("Loading agents…");
    try {
      const data = await createClient({ base: "", ...(login ? { login } : { key }), pauseMs: 0, retries: 1 })({ step: "agents" });
      if (!data.ok) throw new Error(data.error);
      agentPicker.setChoices(agentChoices(data.agents));
      agentsLoaded = true;
    } catch (error) { agentPicker.setMessage(error.message); }
  },
});
setMode("logged");
resumeSignIn();
