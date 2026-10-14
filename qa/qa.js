// The QA page (/qa/, also the QA tab of the admin preview): runs the crosscheck (see scan.js) from the browser and shows the agents with
// the most chats nobody recorded, with a .csv for QA. Read-only: nothing is written to Lark or anywhere else.
import { archiveLink, createClient, myt, planAll, scanChats, sortedEntries, summarize, toCsv, windows } from "./scan.js";

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
let stopRequested = false;

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
  if (!login && !key) return setStatus("Sign in with LiveChat first.", true);
  if (!Number.isFinite(fromMs) || fromMs >= toMs) return setStatus("Pick a start date that is before the end date.", true);
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
    const step = createClient({ base: "", ...(login ? { login } : { key }) });
    const scan = await scanChats({ step, fromMs, toMs, windowMs: WINDOW_MS, onlyKnown: true, log: note, isCancelled: () => stopRequested });
    const entries = planAll(scan, { onlyKnown: true, log: note });
    result = { entries, byEmail: scan.byEmail, from: dayInMyt(fromMs), to: dayInMyt(toMs) };
    render();
    setStatus(`Done. ${entries.length} chat${entries.length === 1 ? "" : "s"} found.`);
  } catch (error) {
    if (error.cancelled) setStatus("Stopped.");
    else if (error.status === 404) setStatus("This page is not switched on yet. Ask the admin.", true);
    else if (error.status === 401 || error.status === 403) {
      if (login && error.loginExpired) signOut();
      setStatus(error.message, true);
    }
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
  link.download = `qa-unknown-chats_${result.from}_to_${result.to}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

$("from").value = store.get(FROM) || dayInMyt(Date.now() - 7 * 86_400_000);
$("form").addEventListener("submit", find);
$("stop").addEventListener("click", () => { stopRequested = true; setStatus("Stopping…"); });
$("download").addEventListener("click", download);
$("signInBtn").addEventListener("click", signIn);
$("signOutBtn").addEventListener("click", signOut);
resumeSignIn();
