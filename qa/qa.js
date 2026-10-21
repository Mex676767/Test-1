import { attachAgentPicker } from "./agentpicker.js";
import { attachDatePicker } from "./datepicker.js";
import { buildExamples } from "./examples.js";
import { agentChoices, archiveLink, checkKnownUsernames, classifyEntries, countMarks, createClient, describeChatLog, dropOwnUntracked, loadTicks, MARK_LABELS, myt, planAll, scanChats, sortedEntries, summarize, toCsv, windows } from "./scan.js";

const $ = (id) => document.getElementById(id);
const store = {
  get(key) { try { return localStorage.getItem(key) || ""; } catch (_) { return ""; } },
  set(key, value) { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch (_) { } },
};
const FROM = "qa-from";
const WINDOW_MS = 6 * 3_600_000;
const MYT = "+08:00";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dayInMyt = (ms) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
const PREVIEW = new URLSearchParams(location.search).get("preview") === "1";
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

let login = null;
let loginProblem = "";
let result = null;
let running = false;
let agentPicker = null;
let currentRun = null;

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

const TOKEN = (account) => `ca-livechat-agent-token:${account}`;
const EXPIRY = (account) => `ca-livechat-agent-token-expiry:${account}`;
const storedToken = (account) => {
  try { return Number(sessionStorage.getItem(EXPIRY(account))) > Date.now() ? sessionStorage.getItem(TOKEN(account)) || "" : ""; } catch (_) { return ""; }
};

async function acceptLogin(candidate) {
  const data = await createClient({ base: "", login: candidate, pauseMs: 0, retries: 1 })({ step: "agents" });
  login = candidate;
  loginProblem = "";
  if (data && data.ok) agentPicker?.setChoices(agentChoices(data.agents));
  if (chatThread) showChat(chatThread);
}

async function resumeLogin() {
  const tokens = ["lc1", "lc2"].map((account) => [account, storedToken(account)]).filter(([, token]) => token);
  if (!tokens.length) { loginProblem = "Sign in with LiveChat in Settings (⚙) first."; return showChat(chatThread); }
  for (const [account, token] of tokens) {
    try { await acceptLogin({ account, token }); return; } catch (error) { loginProblem = error.status === 403 ? "This LiveChat login is not marked QA." : error.message; }
  }
  showChat(chatThread);
}

let chatThread = "";
let chatToken = 0;

function claimsBlock(claims) {
  if (!claims.length) return "";
  return `<div class="qc-claims"><div class="qc-claims-title">Bonus claimed</div>${claims.map((claim) => `<div class="qc-claim">
      <div class="qc-claim-name">${escapeHtml(claim.label || claim.program)}${claim.source ? ` <span class="qc-muted">· ${escapeHtml(claim.source)}</span>` : ""}</div>
      ${claim.inquiry ? `<div class="qc-check ${claim.inquiryOk ? "ok" : "bad"}">${claim.inquiryOk ? "✓ Inquiry" : "⚠ Inquiry should be"} ${escapeHtml(claim.inquiry)}${claim.inquiryOk ? " (matches)" : ""}</div>` : ""}
      ${claim.expectedAmount !== null ? `<div class="qc-check ${claim.amountOk ? "ok" : "bad"}">${claim.amountOk ? "✓ Amount" : "⚠ Amount should be"} ${escapeHtml(String(claim.expectedAmount))}${claim.amountOk ? " (matches)" : ""}</div>` : '<div class="qc-check">No amount for this bonus</div>'}
    </div>`).join("")}</div>`;
}

function loggedCard(row) {
  const missing = '<span class="qc-missing">Not filled in</span>';
  const value = (text, extra = "") => (text ? `<dd${extra}>${escapeHtml(text)}</dd>` : `<dd>${missing}</dd>`);
  const chips = (list, extra = "") => (list.length ? `<dd class="qc-chips">${list.map((item) => `<span class="qc-chip ${extra}">${escapeHtml(item)}</span>`).join("")}</dd>` : `<dd>${missing}</dd>`);
  return `<article class="qc">
    <header class="qc-head"><span class="qc-agent">${escapeHtml(row.agent || "(no agent name)")}</span><time class="qc-time">${escapeHtml(myt(row.createdAt))}</time></header>
    <dl class="qc-grid">
      <div><dt>Username</dt>${value(row.username, ' class="qc-mono"')}</div>
      <div><dt>Brand</dt>${value(row.brand)}</div>
      <div class="qc-wide"><dt>Inquiry</dt>${chips(row.inquiry || [])}</div>
      <div><dt>Status</dt>${row.status ? `<dd class="qc-chips"><span class="qc-chip status">${escapeHtml(row.status)}</span></dd>` : `<dd>${missing}</dd>`}</div>
      <div><dt>Released amount</dt><dd>${row.amount === null || row.amount === undefined ? '<span class="qc-muted">—</span>' : escapeHtml(String(row.amount))}</dd></div>
    </dl>
    ${claimsBlock(row.claims || [])}
    <div class="qc-flags"><span class="qc-flag${row.claimSecret ? " on" : ""}">${row.claimSecret ? "✓" : "—"} Claim Secret</span>${row.telegram ? '<span class="qc-flag on">✓ Telegram</span>' : ""}</div>
  </article>`;
}

function claimOnlyCard(agent, claims) {
  return `<article class="qc qc-unknown">
    <header class="qc-head"><span class="qc-agent">${escapeHtml(agent)}</span></header>
    ${claimsBlock(claims.map((claim) => ({ ...claim, inquiryOk: false, amountOk: false, expectedAmount: Number.isFinite(Number.parseFloat(claim.amount)) ? Number.parseFloat(claim.amount) : null })))}
    <p class="qc-note">Nothing was logged by this agent for the chat.</p>
  </article>`;
}

function tickCard(tick) {
  return `<article class="qc qc-unknown">
    <header class="qc-head"><span class="qc-agent">${escapeHtml(tick.agent)}</span><time class="qc-time">${escapeHtml(myt(tick.at))}</time></header>
    <div class="qc-flags"><span class="qc-flag on">✓ Unknown player</span></div>
    <p class="qc-note">${escapeHtml(tick.label)}. Nothing else is recorded for an Unknown player.</p>
  </article>`;
}

function renderChatLog(info, message = "") {
  const box = $("chatResult");
  if (!info) {
    box.innerHTML = `<p class="qc-empty">${escapeHtml(message || "Open a chat in LiveChat to see how it was logged.")}</p>`;
    return;
  }
  const missing = [...new Set(info.rows.flatMap((row) => row.issues))];
  box.innerHTML = `<div class="qc-verdict ${info.verdict}">${escapeHtml(info.headline)}</div>
    ${info.rows.map(loggedCard).join("")}${[...new Set(info.orphanClaims.map((claim) => claim.agent))].map((agent) => claimOnlyCard(agent, info.orphanClaims.filter((claim) => claim.agent === agent))).join("")}${info.ticks.map(tickCard).join("")}
    ${missing.length ? `<p class="qc-note qc-warn">Missing: ${escapeHtml(missing.join(", "))}</p>` : ""}
    ${info.note ? `<p class="qc-note">${escapeHtml(info.note)}</p>` : ""}`;
}

async function showChat(threadId) {
  chatThread = threadId;
  const mine = (chatToken += 1);
  if (!threadId) return renderChatLog(null);
  if (!login) return renderChatLog(null, loginProblem || "Checking your LiveChat login…");
  renderChatLog(null, "Looking up how this chat was logged…");
  try {
    const data = await createClient({ base: "", login, pauseMs: 0, retries: 2 })({ step: "chatlog", threadId });
    if (mine !== chatToken) return;
    if (!data.ok) throw new Error(data.error || "Could not read this chat.");
    renderChatLog(describeChatLog(data));
  } catch (error) {
    if (mine !== chatToken) return;
    if (error.status === 401) { login = null; loginProblem = "Your LiveChat login has expired. Sign in again in Settings (⚙)."; }
    renderChatLog(null, error.message);
  }
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== window.parent || event.data?.source !== "ca-qa-chat" || PREVIEW) return;
  showChat(String(event.data.threadId || ""));
});
if (window.parent !== window) { try { window.parent.postMessage({ source: "ca-qa-ready" }, location.origin); } catch (_) { } }

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
  const from = $("from").value;
  const to = $("to").value;
  const fromMs = Date.parse(`${from}T00:00:00${MYT}`);
  const toMs = to ? Math.min(Date.parse(`${to}T23:59:59.999${MYT}`), Date.now()) : Date.now();
  if (!login) return setStatus(loginProblem || "Sign in with LiveChat in Settings (⚙) first.", true);
  if (!Number.isFinite(fromMs) || fromMs >= toMs) return setStatus("Pick a start date that is before the end date.", true);
  store.set(FROM, from);

  setRunning(true);
  const run = { stopped: false };
  currentRun = run;
  $("bar").firstElementChild.style.width = "0";
  try {
    await findUnknown({ step: createClient({ base: "", login }), fromMs, toMs, run, only: { emails: agentPicker.selectedEmails() } });
  } catch (error) {
    if (error.cancelled) setStatus("Stopped.");
    else if (error.status === 404) setStatus("This page is not switched on yet. Ask the admin.", true);
    else setStatus(error.message, true);
  } finally {
    setRunning(false);
  }
}

async function findUnknown({ step, fromMs, toMs, run, only }) {
  setStatus("Reading Customer Approaching… this can take a minute.");
  $("results").hidden = true;
  $("notes").hidden = false;
  $("log").textContent = "";
  const lines = [];
  const expectedWindows = windows(fromMs, toMs, WINDOW_MS).length * 2;
  let finishedWindows = 0;
  const note = (line, meta) => {
    if (run.stopped) return;
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
  const entries = planAll(scan, { onlyKnown: true, only: only.emails, log: note });
  note("Reading the Unknown ticks agents made…");
  const tickData = await loadTicks(step);
  classifyEntries(entries, tickData, scan.byEmail);
  const shown = await dropOwnUntracked(entries);
  if (shown.some((entry) => entry.mark === "ticked")) {
    note("Checking whether the customers of ticked chats already had a username…");
    const lookup = await checkKnownUsernames(shown, step, { isCancelled: () => run.stopped, onProgress: (done, total) => !run.stopped && setStatus(`Checking ticked chats for a username on file… ${done}/${total}`) });
    note(`${lookup.found} of ${lookup.checked} ticked chats had a username on file${lookup.failed ? `; ${lookup.failed} could not be checked` : ""}.`);
  }
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
$("onlyNotTicked").addEventListener("change", () => { if (result) render(); });
$("onlyKnownUser").addEventListener("change", () => { if (result) render(); });
agentPicker = attachAgentPicker($("agentPicker"), {
  onOpen: () => { if (!login) agentPicker.setMessage(loginProblem || "Sign in with LiveChat in Settings (⚙) first."); },
});
if (new URLSearchParams(location.search).get("preview") === "1") {
  const examples = buildExamples();
  const toolbar = document.createElement("div");
  toolbar.className = "qc-preview";
  toolbar.innerHTML = `<div class="qc-preview-title"><span class="qc-preview-badge">PREVIEW EXAMPLE</span> Sample chats: made-up data, nothing here is real.</div>
    <div class="qc-preview-pick">${examples.map((example) => `<button type="button" data-example="${example.id}">${escapeHtml(example.label)}</button>`).join("")}</div>`;
  $("chatCard").prepend(toolbar);
  const show = (id) => {
    const example = examples.find((item) => item.id === id) || examples[0];
    for (const button of toolbar.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.example === example.id));
    renderChatLog(describeChatLog(example.data));
  };
  toolbar.addEventListener("click", (event) => { const button = event.target.closest("button[data-example]"); if (button) show(button.dataset.example); });
  show(examples[0].id);
} else {
  renderChatLog(null, "Checking your LiveChat login…");
  resumeLogin();
}
