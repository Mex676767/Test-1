const ESCALATION_TICKET_ENABLED = true;
const IS_EMBEDDED_APP = window.self !== window.top;
const DEPARTMENT_TABS_LIVE = true;
const AUTO_TICKET_LIVE = true;
const BLAST_LIVE = true;
const KNOWLEDGE_TAB_ENABLED = false;
const DEPARTMENT_SEPARATION_ENABLED = true;
const PREVIEW_LOGIN_GATE = false;
const AUTOMATIC_DEPARTMENT_DETECTION = false;
const MANUAL_DEPARTMENT_SESSION_KEY = "rc-manual-department";
const AGENT_LOGIN_LIVE = new URLSearchParams(location.search).get("agentLogin") !== "0";
const QA_VIEW_LIVE = new URLSearchParams(location.search).get("qaView") !== "0";
const QA_VIEW_ALSO_KNOWLEDGE = false;
let qaView = !IS_EMBEDDED_APP && new URLSearchParams(location.search).get("department") === "qa";

const root = document.documentElement;
const themeToggle = document.getElementById("themeToggle");

function applyTheme(theme) {
  root.setAttribute("data-theme", theme);
  localStorage.setItem("rc-theme", theme);
}
applyTheme(localStorage.getItem("rc-theme") || "dark");

themeToggle.addEventListener("click", () => {
  const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
});

const AGENT_KEY = "rc-agent-name";
const BLAST_SYNC_STORAGE_KEY = "ca-livechat-engagement:sync";
const BLAST_LOCAL_STORAGE_KEY = "ca-livechat-engagement:local";
const CONFIGURED_LIVECHAT_ACCOUNT = /^lc[12]$/.test(new URLSearchParams(location.search).get("account") || "")
  ? new URLSearchParams(location.search).get("account")
  : "";
let selectedAgent = AGENT_LOGIN_LIVE ? "" : (localStorage.getItem(AGENT_KEY) || "");
let agentLocked = false;
const OPTIONS_CACHE_KEY = "rc-options-cache";
function readCachedOptions() { try { return JSON.parse(localStorage.getItem(OPTIONS_CACHE_KEY) || "{}") || {}; } catch (_) { return {}; } }
function writeCachedOptions(patch) { try { localStorage.setItem(OPTIONS_CACHE_KEY, JSON.stringify({ ...readCachedOptions(), ...patch })); } catch (_) { } }
let agentOptions = Array.isArray(readCachedOptions().agents) ? readCachedOptions().agents : [];
function setAgentOptions(list) {
  if (!Array.isArray(list) || !list.length) return;
  agentOptions = list;
  writeCachedOptions({ agents: list });
}

function readBlastStorage(key) {
  try { return JSON.parse(localStorage.getItem(key) || "{}"); }
  catch (_) { return {}; }
}

function saveBlastMessages(messages) {
  const current = readBlastStorage(BLAST_SYNC_STORAGE_KEY);
  const cannedMessages = messages.map((message) => message.trim()).filter(Boolean).slice(0, 6);
  localStorage.setItem(BLAST_SYNC_STORAGE_KEY, JSON.stringify({ ...current, cannedMessages }));
  document.querySelector("#blastView iframe")?.contentWindow?.postMessage({
    type: "blast-settings-updated",
    cannedMessages,
  }, window.location.origin);
}

const LOGGING_TABS = new Set(["customer"]);
let blastLoggingLock = false;
let blastRunInProgress = false;
function isLoggingPaused() { return blastRunInProgress || blastLoggingLock || !LOGGING_TABS.has(activeMainTab); }
try { localStorage.removeItem("rc-logging-paused"); localStorage.removeItem("rc-blast-logging-previous"); } catch (_) {}

async function fetchAgentOptions({ fresh = false } = {}) {
  try {
    const res = await fetch("/lark-pic-list", fresh ? { cache: "no-store" } : undefined);
    const data = await res.json();
    if (data.ok) setAgentOptions(data.pics);
  } catch (_) { }
}

let brandOptions = Array.isArray(readCachedOptions().brands) ? readCachedOptions().brands : [];
function setBrandOptions(list) {
  if (!Array.isArray(list) || !list.length) return;
  brandOptions = list;
  writeCachedOptions({ brands: list });
  retryMissingBrandDetection();
}
const brandRetryAttempts = new Map();
let lastBrandListRefreshAt = 0;
function scheduleBrandRetry(chatId, groupID) {
  if (!chatId || !groupID) return;
  const attempt = brandRetryAttempts.get(chatId) || 0;
  if (attempt >= 4) return;
  brandRetryAttempts.set(chatId, attempt + 1);
  setTimeout(() => {
    if (state[chatId] && !state[chatId].brand) resolveBrandFromGroupId(chatId, groupID);
  }, [2_000, 5_000, 15_000, 40_000][attempt]);
}
function retryMissingBrandDetection() {
  for (const [chatId, groupID] of groupIdFor) {
    if (state[chatId] && !state[chatId].brand) resolveBrandFromGroupId(chatId, groupID);
  }
}
async function fetchBrandOptions({ fresh = false } = {}) {
  try {
    const res = await fetch("/lark-brand-list", fresh ? { cache: "no-store" } : undefined);
    const data = await res.json();
    if (data.ok) setBrandOptions(data.brands);
  } catch (_) { }
}

let ticketFields = [];
let ticketDepartments = [];
let ticketMarkets = [];
let ticketConfigError = "";
const TICKET_DEPARTMENT_FALLBACKS = [
  ["CS", "Customer Service"], ["IA", "Internal Audit"], ["PYM", "Payment"], ["PYM_MYR", "PAYMENT MYR/PHP/PKR"],
  ["CMP", "Compliance"], ["QA", "Quality Assurance"], ["RTN", "Retention"], ["DEV", "Developer"],
  ["MXNCS", "MXN Customer Service"], ["MYRCS", "MYR Customer Service"], ["THBCS", "THB Customer Service"],
].map(([code, name]) => ({ id: code, code, name }));
const TICKET_MARKET_FALLBACKS = [
  ["BDT", "Bangladesh"], ["IDR", "Indonesia"], ["MXN", "Mexico"], ["MYR", "Malaysia"], ["PHP", "Philippines"],
  ["PKR", "Pakistan"], ["THB", "Thailand"], ["WOWMYR", "WOW88 Malaysia"], ["WOWIDR", "WOW88 Indonesia"],
].map(([code, label]) => ({ id: code, code, label }));

function mergeTicketChoices(live, fallback) {
  const seen = new Set();
  return [...live, ...fallback].filter((item) => {
    const key = String(item.code || item.name || item.label || item.id).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
const ticketEmailKey = (accountKey) => `rc-ticket-email:${accountKey || ""}`;
function storedTicketEmail(accountKey) { try { return localStorage.getItem(ticketEmailKey(accountKey)) || ""; } catch (_) { return ""; } }
function storeTicketEmail(accountKey, email) { try { localStorage.setItem(ticketEmailKey(accountKey), String(email || "").trim().toLowerCase()); } catch (_) { } }
function ticketReadAuthor(s) {
  const agentToken = liveChatAgentTokens()[currentLiveChatAccount];
  if (!agentToken || !currentLiveChatAccount) return undefined;
  return { accountKey: currentLiveChatAccount, agentToken, ticketEmail: s?.escalation?.ticketEmail || storedTicketEmail(currentLiveChatAccount) };
}
async function fetchTicketConfig({ fresh = false } = {}) {
  if (!ESCALATION_TICKET_ENABLED) return;
  try {
    const author = ticketReadAuthor();
    const res = author
      ? await fetch("/ticket-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ author, fresh }) })
      : await fetch(fresh ? "/ticket-config?fresh=1" : "/ticket-config", fresh ? { cache: "no-store" } : undefined);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Ticket integration is unavailable");
    ticketFields = data.fields || [];
    ticketDepartments = mergeTicketChoices(data.departments || [], TICKET_DEPARTMENT_FALLBACKS);
    ticketMarkets = mergeTicketChoices(data.markets || [], TICKET_MARKET_FALLBACKS);
    for (const s of Object.values(state)) {
      if (!s?.escalation) continue;
      if (!s.escalation.departmentId && data.defaultDepartmentId) s.escalation.departmentId = String(data.defaultDepartmentId);
      if (!s.escalation.marketId && data.defaultMarketId) s.escalation.marketId = String(data.defaultMarketId);
      if (!s.escalation.departmentId && ticketDepartments.length === 1) s.escalation.departmentId = String(ticketDepartments[0].id);
      if (!s.escalation.marketId && ticketMarkets.length === 1) s.escalation.marketId = String(ticketMarkets[0].id);
    }
    ticketConfigError = "";
  } catch (err) {
    ticketFields = [];
    ticketDepartments = [];
    ticketMarkets = [];
    ticketConfigError = err.message;
  }
}


function saveAgent(name) {
  selectedAgent = name.trim();
  localStorage.setItem(AGENT_KEY, selectedAgent);
  if (typeof resumePendingLookups === "function") resumePendingLookups();
}

const SETTINGS_ICONS = {
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  ticket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 1 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z"/><path d="M13 5v14" stroke-dasharray="2 3"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>',
};

function openSettingsPanel() {
  const customerService = isCustomerServiceView() || qaView;
  document.getElementById("settingsOverlay")?.remove();
  const blastFailures = readBlastStorage(BLAST_LOCAL_STORAGE_KEY).failureLog;
  const failureLog = Array.isArray(blastFailures) ? blastFailures : [];
  const overlay = document.createElement("div");
  overlay.id = "settingsOverlay";
  overlay.className = "settings-overlay";
  const accountRole = qaView ? "QA" : "Customer Service";
  const accountTabs = qaView ? ["QA", "Retention", "Blast", "Tickets"] : ["Tickets", "Knowledge"];
  const accountInitial = (String(selectedAgent || "").match(/[A-Za-z]/) || [accountRole.charAt(0)])[0].toUpperCase();
  overlay.innerHTML = `
    <div class="settings-panel">
      <div class="settings-head">
        <div class="settings-title-wrap">
          <span class="settings-head-icon">${SETTINGS_ICONS.gear}</span>
          <div class="settings-title-block">
            <span>Settings</span>
            <small>Agent preferences and diagnostics</small>
          </div>
        </div>
        ${selectedAgent || customerService ? `<button class="settings-close" id="settingsClose">✕</button>` : ""}
      </div>
      ${customerService ? `<div class="settings-card"><div class="settings-section-title"><span class="settings-section-icon">${SETTINGS_ICONS.user}</span><span>Account</span></div><div class="settings-identity"><span class="settings-avatar">${escapeHtml(accountInitial)}</span><div class="settings-identity-text"><strong>${selectedAgent ? escapeHtml(selectedAgent) : "No agent name yet"}</strong><span class="settings-role">${accountRole}</span></div></div><div class="settings-chips" aria-label="Tabs available to you">${accountTabs.map((tab) => `<span>${tab}</span>`).join("")}</div><p class="settings-hint">${qaView ? (selectedAgent ? "Signed in with LiveChat as QA. Chats you take on Retention are recorded under this name." : "Signed in with LiveChat as QA. To record chats you cover on Retention you need an agent name: choose it with the button below.") : "Signed in with LiveChat as Customer Service."}</p>${qaView && !selectedAgent ? `<button type="button" class="secondary-btn" id="settingsQaName">Choose my agent name</button>` : ""}${AGENT_LOGIN_LIVE ? `<button type="button" class="secondary-btn settings-signout" id="settingsSignOut">Sign out of LiveChat</button>` : ""}</div>` : `
      <div class="settings-card">
        <div class="settings-section-title"><span class="settings-section-icon">${SETTINGS_ICONS.user}</span><span>Agent</span>${AGENT_LOGIN_LIVE && agentLocked ? `<span class="settings-role settings-role-end">Retention</span>` : ""}</div>${AGENT_LOGIN_LIVE && agentLocked ? `<div class="settings-chips" aria-label="Tabs available to you">${(BLAST_LIVE ? ["Retention", "Blast"] : ["Retention"]).map((tab) => `<span>${tab}</span>`).join("")}</div>` : ""}
        <p class="settings-hint">${AGENT_LOGIN_LIVE ? (agentLocked ? "Your name comes from your LiveChat login and can't be changed here." : "Your name comes from your LiveChat login. It appears here as soon as the sign-in finishes.") : "Choose the name recorded on every submitted case."}</p>
        ${AGENT_LOGIN_LIVE
          ? `<div class="input settings-text" id="agentLockedName"${agentLocked ? ` data-initial="${escapeHtml(accountInitial)}"` : ""}>${agentLocked ? escapeHtml(selectedAgent) : "Signing in with LiveChat…"}</div>${agentLocked ? `<button type="button" class="secondary-btn settings-signout" id="settingsSignOut">Sign out of LiveChat</button>` : ""}`
          : agentOptions.length
          ? `<select class="input settings-select" id="agentSelect">
               <option value="">Choose your name</option>
               ${agentOptions.map((a) => `<option value="${a}" ${a === selectedAgent ? "selected" : ""}>${a}</option>`).join("")}
             </select>`
          : `<input type="text" class="input settings-text" id="agentSelect" placeholder="Type your name (e.g. 96 Edwin)" value="${selectedAgent}" />`
        }
      </div>
      `}
      ${ticketAccountSettingsVisible() ? `<div class="settings-card" id="settingsTicketAccountCard">${renderTicketAccountSettings()}</div>` : ""}

      <div class="settings-card">
        <div class="settings-section-title"><span class="settings-section-icon">${SETTINGS_ICONS.send}</span><span>Blast history</span></div>
        <details class="settings-failures">
          <summary>Skipped or failed chats <span>${failureLog.length}</span></summary>
          <div class="settings-failure-list">
            ${failureLog.length ? failureLog.slice(0, 20).map((entry) => `
              <div class="settings-failure-item">
                <strong>${escapeHtml(entry.stage || "Failed")}</strong>
                <span>${escapeHtml(entry.reason || "Unknown error")}</span>
              </div>
            `).join("") : `<div class="diag-empty">No skipped or failed chats recorded.</div>`}
          </div>
          ${failureLog.length ? `<button class="settings-clear-failures" id="settingsClearFailures" type="button">Clear failed-chat log</button>` : ""}
        </details>
      </div>

      <button class="submit-btn settings-save" id="settingsSave">Save changes</button>

      <details class="settings-diagnostics">
        <summary>Diagnostics</summary>
        <div class="settings-diagnostics-list">${renderDiagnosticsLog()}</div>
      </details>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById("settingsSignOut")?.addEventListener("click", () => { signOutLiveChat(); });
  document.getElementById("settingsQaName")?.addEventListener("click", () => { chooseQaAgentName(); });
  const accountCard = document.getElementById("settingsTicketAccountCard");
  if (accountCard) {
    const repaint = () => { accountCard.innerHTML = renderTicketAccountSettings(); };
    accountCard.addEventListener("click", async (event) => {
      const chatId = ticketAccountSettingsChat();
      if (!chatId) return;
      if (event.target.closest("[data-settings-ticket-recheck]")) {
        repaint();
        const done = checkTicketAccount(chatId, { force: true });
        repaint();
        await done;
        repaint();
      } else if (event.target.closest('[data-action="enterTicketEmail"]')) {
        showTicketProblem(chatId, { needTicketEmail: true, triedEmail: ticketAccount.email, error: "Enter the email of your ticket-system account." }, async () => { await checkTicketAccount(chatId, { force: true }); repaint(); });
      }
    });
  }
  if (customerService) {
    overlay.querySelector(".settings-failures")?.closest(".settings-card")?.remove();
    document.getElementById("settingsSave")?.remove();
  }

  document.getElementById("settingsClearFailures")?.addEventListener("click", () => {
    const current = readBlastStorage(BLAST_LOCAL_STORAGE_KEY);
    delete current.failureLog;
    localStorage.setItem(BLAST_LOCAL_STORAGE_KEY, JSON.stringify(current));
    document.getElementById("settingsClearFailures")?.closest(".settings-failures")?.remove();
  });

  document.getElementById("settingsSave")?.addEventListener("click", () => {
    if (AGENT_LOGIN_LIVE) { overlay.remove(); return; }
    const val = document.getElementById("agentSelect").value.trim();
    if (!val) { setStatus("Choose your name before continuing.", "error"); return; }
    saveAgent(val);
    overlay.remove();
    updateAgentBadge();
    staleRecords = [];
    fetchStaleRecords();
    if (liveWidget) applyProfile(liveWidget.getCustomerProfile());
    setStatus(`Agent set to ${selectedAgent}.`, "success");
  });

  document.getElementById("settingsClose")?.addEventListener("click", () => overlay.remove());
}

function renderDiagnosticsLog() {
  if (!diagnosticsLog.length) return `<div class="diag-empty">No activity logged yet.</div>`;
  return diagnosticsLog.map((e) => `
    <div class="diag-entry diag-${e.kind}">
      <span class="diag-time">${e.time.toLocaleTimeString()}</span> ${e.text}
    </div>`).join("");
}

let agentSigningIn = false;
function updateAgentBadge() {
  const badge = document.getElementById("agentBadge");
  const signingIn = !selectedAgent && agentSigningIn;
  if (badge) badge.textContent = selectedAgent ? `◉ ${selectedAgent}` : signingIn ? "◌ Signing in with LiveChat…" : "⚠︎ No agent set";
  if (badge) badge.className = `agent-badge ${selectedAgent ? "set" : signingIn ? "" : "unset"}`;
}

const BONUS_PROGRAMS = [
  { key: "riskPlayer", label: "Risk Player" },
  { key: "topPnl", label: "Top 10 P&L" },
  { key: "gracePeriod", label: "Grace Period" },
  { key: "ltvTest", label: "LTV" },
  { key: "vipBooster", label: "12h VIP Deposit Booster" },
  { key: "mooncake", label: "Mooncake Bonus" },
  { key: "vs96Feedback", label: "VS96 Feedback" },
];
const BONUS_CARD_TONES = {
  riskPlayer: "amber",
  topPnl: "blue",
  gracePeriod: "teal",
  ltvTest: "violet",
  vipBooster: "cyan",
  mooncake: "pink",
  vs96Feedback: "rose",
  telegram28: "green",
  redeemCode: "indigo",
  specialReload: "orange",
};
const BONUS_CARD_MARKS = {
  riskPlayer: "!",
  topPnl: "↗",
  gracePeriod: "◷",
  ltvTest: "L",
  vipBooster: "12",
  mooncake: "☾",
  vs96Feedback: "✎",
  telegram28: "T",
  redeemCode: "#",
  specialReload: "✦",
};
const BONUS_CARD_TONE_NAMES = ["amber", "blue", "teal", "violet", "cyan", "pink", "rose", "green", "indigo", "orange"];
function bonusCardTone(key) {
  if (BONUS_CARD_TONES[key]) return BONUS_CARD_TONES[key];
  let hash = 0;
  for (const character of String(key || "")) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return BONUS_CARD_TONE_NAMES[Math.abs(hash) % BONUS_CARD_TONE_NAMES.length];
}
let configuredBonusPrograms = [];
function allBonusPrograms() { return [...BONUS_PROGRAMS, ...configuredBonusPrograms]; }
async function fetchConfiguredBonusPrograms({ fresh = false } = {}) {
  try {
    const res = await fetch(fresh ? "/bonus-config?fresh=1" : "/bonus-config", fresh ? { cache: "no-store" } : undefined);
    const data = await res.json();
    configuredBonusPrograms = data.ok && Array.isArray(data.configs) ? data.configs : [];
  } catch (_) {
    configuredBonusPrograms = [];
  }
}

function applyDepartmentChrome() {
  if (!DEPARTMENT_SEPARATION_ENABLED || (!previewMode && !DEPARTMENT_TABS_LIVE)) {
    document.getElementById("settingsBtn")?.removeAttribute("hidden");
    document.getElementById("agentBadge")?.removeAttribute("hidden");
    return;
  }
  const rtn = !departmentKnown || currentDepartment === "rtn";
  const settingsButton = document.getElementById("settingsBtn");
  const agentBadge = document.getElementById("agentBadge");
  if (settingsButton) settingsButton.hidden = false;
  if (agentBadge) agentBadge.hidden = !rtn;
}

async function resolveLoggedInDepartment(accountKey, token) {
  const response = await fetch("/livechat-agent-department", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountKey, agentToken: token }),
    ...(typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(10_000) } : {}),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || "Could not identify this LiveChat agent.");
  setCurrentLiveChatAccount(accountKey);
  setDepartmentFromGroups(data.groups || []);
  applyDepartmentChrome();
  syncMainTabs();
  renderChats(activeChats);
  return data;
}

function applyManualDepartment(accountKey, department) {
  setCurrentLiveChatAccount(accountKey);
  currentDepartment = department === "rtn" ? "rtn" : "cs";
  departmentKnown = true;
  try { sessionStorage.setItem(DEPARTMENT_SESSION_KEY, currentDepartment); } catch (_) {}
  try { sessionStorage.setItem(MANUAL_DEPARTMENT_SESSION_KEY, currentDepartment); } catch (_) {}
  activeMainTab = currentDepartment === "rtn" ? "customer" : "tickets";
  applyDepartmentChrome();
  syncMainTabs();
  renderChats(activeChats);
}

function requireManualDepartment(accountKey, existingOverlay = null) {
  return new Promise((resolve) => {
    const overlay = existingOverlay || document.createElement("div");
    overlay.id = "liveChatLoginOverlay";
    overlay.className = "settings-overlay";
    overlay.innerHTML = `
      <div class="settings-panel login-panel">
        <div class="login-mark">◆</div>
        <div class="settings-head">Choose your department</div>
        <p class="settings-hint">This is temporary while automatic LiveChat group detection is being tested.</p>
        <div class="login-actions">
          <button type="button" class="submit-btn" data-department="rtn">Retention</button>
          <button type="button" class="secondary-btn department-choice" data-department="cs">Customer Service</button>
        </div>
      </div>`;
    if (!existingOverlay) document.body.appendChild(overlay);
    overlay.querySelectorAll("[data-department]").forEach((button) => {
      button.addEventListener("click", () => {
        applyManualDepartment(accountKey, button.dataset.department);
        overlay.remove();
        resolve();
      });
    });
  });
}

async function requirePreviewLiveChatLogin() {
  if (!PREVIEW_LOGIN_GATE) return;
  const response = await fetch("/livechat-oauth-config", { cache: "no-store" });
  const config = await response.json();
  const clients = Array.isArray(config.clients) ? config.clients : [];
  if (!clients.length) throw new Error("LiveChat login has not been configured yet.");

  const validToken = (accountKey) => {
    try {
      const expiry = Number(sessionStorage.getItem(`ca-livechat-agent-token-expiry:${accountKey}`) || 0);
      return expiry > Date.now() ? sessionStorage.getItem(`ca-livechat-agent-token:${accountKey}`) || "" : "";
    } catch (_) { return ""; }
  };
  const previouslySelected = (() => {
    try { return sessionStorage.getItem("ca-livechat-selected-account") || ""; } catch (_) { return ""; }
  })();
  const connected = clients.filter((client) => validToken(client.key));
  const automatic = connected.find((client) => client.key === previouslySelected) || (connected.length === 1 ? connected[0] : null);
  if (automatic) {
    try {
      if (AUTOMATIC_DEPARTMENT_DETECTION) await resolveLoggedInDepartment(automatic.key, validToken(automatic.key));
      else {
        let savedManualDepartment = "";
        try { savedManualDepartment = sessionStorage.getItem(MANUAL_DEPARTMENT_SESSION_KEY) || ""; } catch (_) {}
        if (savedManualDepartment === "rtn" || savedManualDepartment === "cs") {
          applyManualDepartment(automatic.key, savedManualDepartment);
        } else {
          await requireManualDepartment(automatic.key);
        }
      }
      return;
    } catch (_) { }
  }

  return new Promise((resolve) => {
    const preferredKey = currentLiveChatAccount || previouslySelected;
    const orderedClients = [...clients].sort((left, right) => Number(right.key === preferredKey) - Number(left.key === preferredKey));
    const overlay = document.createElement("div");
    overlay.id = "liveChatLoginOverlay";
    overlay.className = "settings-overlay";
    overlay.innerHTML = `
      <div class="settings-panel login-panel">
        <div class="login-mark">◆</div>
        <div class="settings-head">Connect LiveChat</div>
        <p class="settings-hint">Sign in with your own agent account first. Your assigned groups will set up the correct workspace automatically.</p>
        <div class="login-actions">
          <button type="button" class="submit-btn" id="liveChatConnectButton">Connect LiveChat</button>
        </div>
        <div id="liveChatLoginStatus" class="login-status"></div>
      </div>`;
    document.body.appendChild(overlay);

    const status = overlay.querySelector("#liveChatLoginStatus");
    let pendingState = "";
    let pendingClient = null;
    let attemptIndex = -1;
    const connectButton = overlay.querySelector("#liveChatConnectButton");
    const showError = (message) => {
      status.textContent = message;
      status.className = "login-status error";
      connectButton.disabled = false;
    };
    const startNextAttempt = () => {
      attemptIndex += 1;
      pendingClient = orderedClients[attemptIndex] || null;
      if (!pendingClient) return false;
      pendingState = crypto.randomUUID();
      connectButton.disabled = true;
      status.textContent = attemptIndex ? "Checking your other LiveChat workspace…" : "Complete the login in the new window…";
      status.className = "login-status";
      const redirectUri = config.redirectUri || `${location.origin}/blast/oauth.html`;
      const url = new URL("https://accounts.livechat.com/");
      url.search = new URLSearchParams({ response_type: "token", client_id: pendingClient.clientId, redirect_uri: redirectUri, state: pendingState, prompt: "consent" }).toString();
      const popup = window.open(url, "livechat-agent-oauth", "popup=yes,width=560,height=720");
      if (!popup) showError("Your browser blocked the LiveChat login window. Allow popups and try again.");
      return Boolean(popup);
    };
    const onMessage = async (event) => {
      let callbackOrigin = location.origin;
      try { callbackOrigin = new URL(config.redirectUri).origin; } catch (_) {}
      if (event.origin !== callbackOrigin || event.data?.source !== "ca-livechat-oauth" || event.data.state !== pendingState) return;
      if (event.data.type !== "SUCCESS" || !pendingClient) {
        if (!startNextAttempt()) showError(event.data.error || "LiveChat login was not completed.");
        return;
      }
      try {
        sessionStorage.setItem(`ca-livechat-agent-token:${pendingClient.key}`, event.data.token);
        sessionStorage.setItem(`ca-livechat-agent-token-expiry:${pendingClient.key}`, String(event.data.expiresAt));
        sessionStorage.setItem("ca-livechat-selected-account", pendingClient.key);
        status.textContent = AUTOMATIC_DEPARTMENT_DETECTION ? "Checking your assigned groups…" : "LiveChat connected.";
        status.className = "login-status";
        if (AUTOMATIC_DEPARTMENT_DETECTION) {
          await resolveLoggedInDepartment(pendingClient.key, event.data.token);
        } else {
          await requireManualDepartment(pendingClient.key, overlay);
        }
        window.removeEventListener("message", onMessage);
        overlay.remove();
        resolve();
      } catch (error) {
        try {
          sessionStorage.removeItem(`ca-livechat-agent-token:${pendingClient?.key || ""}`);
          sessionStorage.removeItem(`ca-livechat-agent-token-expiry:${pendingClient?.key || ""}`);
        } catch (_) {}
        if (!startNextAttempt()) showError(error.message);
      }
    };
    window.addEventListener("message", onMessage);
    connectButton.addEventListener("click", () => {
      attemptIndex = -1;
      startNextAttempt();
    });
  });
}

function dropLiveChatToken(accountKey) {
  forgetLiveChatLogin(accountKey);
}

async function postAgentLogin(accountKey, token, name) {
  const response = await fetch("/agent-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountKey, agentToken: token, ...(name ? { name } : {}) }),
    ...(typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(25_000) } : {}),
  });
  return response.json();
}

function agentLoginPanel(innerHtml) {
  let overlay = document.getElementById("agentLoginOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "agentLoginOverlay";
    overlay.className = "settings-overlay agent-login-overlay";
    document.body.appendChild(overlay);
  }
  agentSigningIn = false;
  updateAgentBadge();
  overlay.innerHTML = `<div class="agent-login-card"><div class="login-mark">◆</div><div class="agent-login-app">Console</div>${innerHtml}</div>`;
  return overlay;
}

const LAST_LIVECHAT_ACCOUNT_KEY = "rc-last-livechat-account";
const LOGIN_POPUP_POLL_MS = 500;
const LOGIN_POPUP_GRACE_MS = 800;
function rememberLiveChatAccount(accountKey) {
  try { localStorage.setItem(LAST_LIVECHAT_ACCOUNT_KEY, accountKey); } catch (_) { }
}
function accountsLastUsedFirst(clients) {
  let last = "";
  try { last = localStorage.getItem(LAST_LIVECHAT_ACCOUNT_KEY) || ""; } catch (_) { }
  return [...clients].sort((a, b) => Number(b.key === last) - Number(a.key === last));
}

function connectLiveChatLogin(clients, redirectUri, onProgress) {
  return new Promise((resolve, reject) => {
    const ordered = accountsLastUsedFirst(clients);
    let callbackOrigin = location.origin;
    try { callbackOrigin = new URL(redirectUri).origin; } catch (_) { }
    let index = -1;
    let pendingClient = null;
    let pendingState = "";
    let popup = null;
    let watcher = 0;
    let done = false;
    const stopWatching = () => { if (watcher) { clearInterval(watcher); watcher = 0; } };
    const finish = (settle, value) => { done = true; stopWatching(); window.removeEventListener("message", onMessage); settle(value); };
    const watch = (state) => {
      stopWatching();
      watcher = setInterval(() => {
        if (!popup || !popup.closed) return;
        stopWatching();
        setTimeout(() => {
          if (done || state !== pendingState) return;
          if (!advance()) finish(reject, new Error("The LiveChat login window was closed before the login finished."));
        }, LOGIN_POPUP_GRACE_MS);
      }, LOGIN_POPUP_POLL_MS);
    };
    const next = () => {
      index += 1;
      pendingClient = ordered[index] || null;
      if (!pendingClient) return false;
      pendingState = crypto.randomUUID();
      onProgress(index ? "Checking your other LiveChat workspace…" : "Complete the login in the new window…");
      const url = new URL("https://accounts.livechat.com/");
      url.search = new URLSearchParams({ response_type: "token", client_id: pendingClient.clientId, redirect_uri: redirectUri, state: pendingState, prompt: "consent" }).toString();
      popup = window.open(url, "livechat-agent-oauth", "popup=yes,width=560,height=720");
      if (popup) watch(pendingState);
      return Boolean(popup);
    };
    const advance = () => {
      const upcoming = ordered[index + 1];
      if (!upcoming) return false;
      if (next()) return true;
      rememberLiveChatAccount(upcoming.key);
      finish(reject, new Error("Your browser blocked the next LiveChat window. Click Connect LiveChat to continue."));
      return true;
    };
    const onMessage = (event) => {
      if (event.origin !== callbackOrigin || event.data?.source !== "ca-livechat-oauth" || event.data.state !== pendingState) return;
      if (event.data.type === "SUCCESS" && pendingClient) {
        rememberLiveChatAccount(pendingClient.key);
        finish(resolve, { accountKey: pendingClient.key, token: event.data.token, expiresAt: event.data.expiresAt });
        return;
      }
      if (!advance()) finish(reject, new Error(event.data.error || "LiveChat login was not completed."));
    };
    window.addEventListener("message", onMessage);
    if (!next()) finish(reject, new Error("Your browser blocked the LiveChat login window. Allow popups and try again."));
  });
}

function applyBoundAgent(name, accountKey) {
  const changed = selectedAgent !== name;
  agentLocked = true;
  agentSigningIn = false;
  saveAgent(name);
  setCurrentLiveChatAccount(accountKey);
  updateAgentBadge();
  document.getElementById("agentLoginOverlay")?.remove();
  if (changed) {
    staleRecords = [];
    fetchStaleRecords();
    if (liveWidget) applyProfile(liveWidget.getCustomerProfile());
  }
  logDiagnostic(`Signed in with LiveChat as ${name}.`, "success");
  fetchUnrecordedChats();
}

async function signOutLiveChat() {
  if (!confirm("Sign out of LiveChat in this widget? Nothing can be recorded until you sign in again.")) return;
  for (const accountKey of ["lc1", "lc2"]) forgetLiveChatLogin(accountKey);
  try { localStorage.removeItem(AGENT_KEY); } catch (_) { }
  if (qaView && IS_EMBEDDED_APP) { qaView = false; syncMainTabs(); }
  selectedAgent = "";
  agentLocked = false;
  staleRecords = [];
  unrecordedChats = [];
  unrecordedLoaded = false;
  document.getElementById("settingsOverlay")?.remove();
  updateAgentBadge();
  renderNeedsAttentionPanel();
  renderChats(activeChats);
  logDiagnostic("Signed out of LiveChat in this widget.", "info");
  await requireAgentLogin();
}

function pickAgentName(accountKey, token, available, { skippable = false } = {}) {
  return new Promise((resolve) => {
    const render = (names, error = "") => {
      const overlay = agentLoginPanel(`
        <div class="settings-head">Choose your agent name</div>
        <p class="settings-hint">This is saved to your LiveChat login and <strong>can't be changed later</strong>. If you pick the wrong one, ask your admin.</p>
        ${names.length
          ? `<select class="input settings-select" id="agentLoginSelect"><option value="">Choose your name</option>${names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("")}</select>
             <div class="login-actions"><button type="button" class="submit-btn" id="agentLoginConfirm">Save my name</button>${skippable ? `<button type="button" class="secondary-btn" id="agentLoginSkip">Not now</button>` : ""}</div>`
          : `<p class="settings-hint">No free agent names are left on this LiveChat account — ask your admin.</p>${skippable ? `<div class="login-actions"><button type="button" class="secondary-btn" id="agentLoginSkip">Continue without a name</button></div>` : ""}`}
        <div class="login-status error" id="agentLoginStatus">${escapeHtml(error)}</div>`);
      overlay.querySelector("#agentLoginSkip")?.addEventListener("click", () => resolve());
      const confirmButton = overlay.querySelector("#agentLoginConfirm");
      if (!confirmButton) return;
      confirmButton.addEventListener("click", async () => {
        const name = overlay.querySelector("#agentLoginSelect").value.trim();
        const status = overlay.querySelector("#agentLoginStatus");
        if (!name) { status.textContent = "Choose your name first."; return; }
        if (!confirm(`Use "${name}" as your agent name?\n\nIt can't be changed afterwards.`)) return;
        confirmButton.disabled = true;
        status.textContent = "";
        let data;
        try { data = await postAgentLogin(accountKey, token, name); } catch (_) { data = { ok: false, error: "Couldn't reach the server — try again." }; }
        if (data.ok && data.bound) { applyBoundAgent(data.name, accountKey); resolve(); return; }
        render(Array.isArray(data.available) ? data.available : names, data.error || "Couldn't save your name — try again.");
      });
    };
    render(available);
  });
}

async function detectDepartment(accountKey, token) {
  if (!DEPARTMENT_SEPARATION_ENABLED || (!previewMode && !DEPARTMENT_TABS_LIVE)) return "";
  const forced = previewMode ? new URLSearchParams(location.search).get("department") : "";
  if (forced === "cs" || forced === "rtn") { setDepartmentFromGroups(forced === "rtn" ? ["Priority 96"] : []); return forced; }
  try { return (await resolveLoggedInDepartment(accountKey, token)).department; }
  catch (error) { logDiagnostic(`Department check failed, full view kept: ${error.message}`, "warn"); forgetDepartment(); return ""; }
}

function applyCustomerServiceAgent(accountKey) {
  agentSigningIn = false;
  setCurrentLiveChatAccount(accountKey);
  updateAgentBadge();
  document.getElementById("agentLoginOverlay")?.remove();
  logDiagnostic("Signed in with LiveChat as Customer Service (Tickets and Knowledge).", "success");
}

async function detectQaRole(accountKey, token) {
  if (!QA_VIEW_LIVE || !IS_EMBEDDED_APP) return false;
  try {
    const response = await fetch("/qa-role", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountKey, agentToken: token }),
      ...(typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(8_000) } : {}),
    });
    const data = await response.json();
    return Boolean(data.ok && data.qa);
  } catch (_) { return false; }
}

function applyQaAgent(accountKey) {
  qaView = true;
  agentSigningIn = false;
  setCurrentLiveChatAccount(accountKey);
  updateAgentBadge();
  document.getElementById("agentLoginOverlay")?.remove();
  activeMainTab = "unknownChats";
  syncMainTabs();
  logDiagnostic("Signed in with LiveChat as QA.", "success");
}

async function chooseQaAgentName() {
  const token = liveChatAgentTokens()[currentLiveChatAccount];
  if (!token) return;
  document.getElementById("settingsOverlay")?.remove();
  let data;
  try { data = await postAgentLogin(currentLiveChatAccount, token); } catch (_) { return; }
  if (data.ok && data.bound) { applyBoundAgent(data.name, currentLiveChatAccount); syncMainTabs(); return; }
  if (data.ok) await pickAgentName(currentLiveChatAccount, token, Array.isArray(data.available) ? data.available : [], { skippable: true });
  document.getElementById("agentLoginOverlay")?.remove();
  syncMainTabs();
}

let qaOpenChat = "";
function postQaChat() {
  if (!qaView) return;
  try { document.querySelector("#unknownChatsView iframe")?.contentWindow?.postMessage({ source: "ca-qa-chat", threadId: qaOpenChat }, location.origin); } catch (_) { }
}
function reportQaChat(profile) {
  const id = profile && profile.chat && profile.chat.id && profile.source !== "customers" ? String(profile.chat.id) : "";
  if (id === qaOpenChat) return;
  qaOpenChat = id;
  postQaChat();
}
window.addEventListener("message", (event) => {
  if (event.origin === location.origin && event.data && event.data.source === "ca-qa-ready") postQaChat();
});

async function requireAgentLogin() {
  agentSigningIn = true;
  updateAgentBadge();
  let config = null;
  try { config = await (await fetch("/livechat-oauth-config", { cache: "no-store" })).json(); } catch (_) { }
  let clients = Array.isArray(config?.clients) ? config.clients : [];
  if (CONFIGURED_LIVECHAT_ACCOUNT) clients = clients.filter((client) => client.key === CONFIGURED_LIVECHAT_ACCOUNT);
  if (!clients.length) {
    agentLoginPanel(`<div class="settings-head">LiveChat login unavailable</div><p class="settings-hint">LiveChat login has not been configured for this widget.</p>`);
    return new Promise(() => {});
  }
  const redirectUri = config.redirectUri || `${location.origin}/blast/oauth.html`;
  let failure = "";
  for (;;) {
    const tokens = liveChatAgentTokens();
    const usable = clients.map((client) => client.key).filter((key) => tokens[key]);
    for (const key of usable) {
      if (await detectDepartment(key, tokens[key]) === "cs") { applyCustomerServiceAgent(key); return; }
      const qaCheck = detectQaRole(key, tokens[key]);
      let data;
      try { data = await postAgentLogin(key, tokens[key]); } catch (_) { failure = "Couldn't reach the server — check your connection."; continue; }
      if (await qaCheck) {
        if (data.ok && data.bound) applyBoundAgent(data.name, key);
        else if (data.ok) await pickAgentName(key, tokens[key], Array.isArray(data.available) ? data.available : [], { skippable: true });
        applyQaAgent(key);
        return;
      }
      if (data.loginExpired) { dropLiveChatToken(key); failure = data.error || ""; continue; }
      if (data.ok && data.bound) { applyBoundAgent(data.name, key); return; }
      if (data.ok) { await pickAgentName(key, tokens[key], Array.isArray(data.available) ? data.available : []); return; }
      failure = data.error || "Agent login failed.";
    }
    await new Promise((resolve) => {
      const stored = liveChatAgentTokens();
      const retry = Boolean(failure && clients.some((client) => stored[client.key]));
      const overlay = agentLoginPanel(`
        <div class="settings-head">Sign in with LiveChat</div>
        <p class="settings-hint">Sign in with your own LiveChat account. Your agent name is set from it.</p>
        <div class="login-actions"><button type="button" class="submit-btn" id="agentLoginConnect">${retry ? "Try again" : "Connect LiveChat"}</button></div>
        <div class="login-status error" id="agentLoginStatus">${escapeHtml(failure)}</div>`);
      const button = overlay.querySelector("#agentLoginConnect");
      const status = overlay.querySelector("#agentLoginStatus");
      button.addEventListener("click", async () => {
        failure = "";
        if (retry) { resolve(); return; }
        button.disabled = true;
        status.className = "login-status";
        try {
          const login = await connectLiveChatLogin(clients, redirectUri, (text) => { status.textContent = text; });
          saveLiveChatLogin(login.accountKey, login.token, login.expiresAt);
          resolve();
        } catch (error) {
          failure = error.message;
          status.className = "login-status error";
          status.textContent = failure;
          button.disabled = false;
        }
      });
    });
  }
}

const AGENT_WROTE_VERSION = 3;
function agentWroteVerdict(s) {
  if (!s) return undefined;
  if ((s.agentWrote === false || s.agentWrote === true) && s.agentWroteV !== AGENT_WROTE_VERSION) return undefined;
  return s.agentWrote;
}
async function agentWroteInChat(chatId) {
  const s = state[chatId];
  if (!AGENT_LOGIN_LIVE || !s) return false;
  const known = agentWroteVerdict(s);
  if (known === true) return true;
  if (known === false) return false;
  if (s.agentWrote === false || s.agentWrote === true) delete s.agentWrote;
  const token = liveChatAgentTokens()[currentLiveChatAccount];
  const link = String(s.chatUrl || "").match(/\/chats\/([^/]+)\/([^/]+)/);
  if (token && !link) return false;
  let data = null;
  if (token && link) {
    try {
      const response = await fetch("/livechat-agent-wrote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountKey: currentLiveChatAccount, agentToken: token, chatId: link[1], threadId: link[2] }),
      });
      data = await response.json();
    } catch (_) { data = null; }
  }
  if (!data || !data.ok || data.wrote === null) {
    if (s.agentWrote !== "unsure") {
      logDiagnostic(`Couldn't check whether you wrote in this chat (${data?.error || (token ? "no chat link yet" : "LiveChat is not connected")}) — keeping it on your list.`, "warn");
    }
    s.agentWrote = "unsure";
    return true;
  }
  const theirs = !!data.wrote && data.customerWrote !== false;
  s.agentWrote = theirs;
  s.agentWroteV = AGENT_WROTE_VERSION;
  if (!theirs) {
    logDiagnostic(data.wrote
      ? "Not on your list: the customer never wrote in this chat (you reached out), so there is nothing to record."
      : `Not on your list: no message from you (${(data.me || []).join(" / ")}) in this chat. Agent messages by: ${(data.authors || []).join(", ") || "nobody"}.`, "info");
  }
  return s.agentWrote;
}

async function fetchBootstrapOptions({ fresh = false } = {}) {
  try {
    const res = await fetch(fresh ? "/app-bootstrap?fresh=1" : "/app-bootstrap", fresh ? { cache: "no-store" } : undefined);
    const data = await res.json();
    if (!res.ok || !data.ok) return false;
    if (Array.isArray(data.agents)) setAgentOptions(data.agents);
    if (Array.isArray(data.brands)) setBrandOptions(data.brands);
    if (Array.isArray(data.inquiries) && data.inquiries.length) inquiryOptions = data.inquiries;
    if (Array.isArray(data.statuses) && data.statuses.length) statusOptions = data.statuses;
    if (Array.isArray(data.bonuses)) configuredBonusPrograms = data.bonuses;
    return true;
  } catch (_) {
    return false;
  }
}
const NO_BONUS_PATTERN = /^\s*\d+D\s*No Bonus\s*$/i;

const AMOUNT_ELIGIBLE_PROGRAMS = new Set(["topPnl", "ltvTest", "gracePeriod", "telegram28"]);

function extractAmountNumber(str) {
  const s = String(str || "");
  const rmMatch = s.match(/RM\s*(-?\d+(?:\.\d+)?)/i);
  if (rmMatch) return rmMatch[1];
  const match = s.match(/-?\d+(?:\.\d+)?/);
  return match ? match[0] : "";
}

function graceClaimAmount(display) {
  const text = String(display || "");
  const bonus = text.match(/Bonus\s*[:\-]?\s*(-?\d+(?:\.\d+)?)/i);
  if (bonus) return bonus[1];
  const afterPass = text.match(/Pass\s*-\s*(-?\d+(?:\.\d+)?)\s*$/i);
  return afterPass ? afterPass[1] : "";
}

const RISK_PLAYER_CAPS = { 20: 188, 30: 288, 40: 388 };

function riskPlayerCalculation(display, reloadAmount) {
  const percentageMatch = String(display || "").match(/\b(20|30|40)\s*%/i);
  const percentage = percentageMatch ? Number(percentageMatch[1]) : 0;
  const cap = RISK_PLAYER_CAPS[percentage] || 0;
  const reload = Number(String(reloadAmount || "").trim());
  if (!percentage || !Number.isFinite(reload) || reload <= 0) {
    return { valid: false, percentage, cap, reload: 0, claim: 0, formattedClaim: "" };
  }
  const claim = Math.min(reload * percentage / 100, cap);
  const rounded = Math.round((claim + Number.EPSILON) * 100) / 100;
  return {
    valid: true,
    percentage,
    cap,
    reload,
    claim: rounded,
    formattedClaim: Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""),
  };
}

function hasAnyBonus(chatId) {
  const r = state[chatId].matchedRow;
  if (!r) return false;
  if (allBonusPrograms().some((p) => isClaimableValue(r[p.key]))) return true;
  if (r.telegram28 && !isHiddenStatus(r.telegram28.status)) return true;
  if (r.redeemCode && !isHiddenStatus(r.redeemCode.status)) return true;
  if (r.specialReload) return true;
  if (halloweenActionable(r.halloween)) return true;
  return false;
}

function getChatSummary(chatId) {
  const s = state[chatId];
  if (s.isUnknown) return { text: "Unknown — not recorded", cls: "neutral" };
  if (s.attentionIgnored) return { text: "Ignored — not recorded", cls: "neutral" };
  if (s.autoRecordError) return { text: "⚠︎ Needs attention", cls: "attention" };
  if (s.logged) return { text: "✓ Logged", cls: "done" };
  if (s.matchedRow === undefined) return { text: "Not looked up", cls: "neutral" };
  if (s.matchedRow === null) return { text: "No record found", cls: "neutral" };
  return hasAnyBonus(chatId) ? { text: "Bonuses ready", cls: "ready" } : { text: "No active bonuses", cls: "neutral" };
}

function isHiddenStatus(v) {
  const t = String(v || "").trim().toLowerCase();
  return /\b(claimed|expired|failed|not\s+eligible|ineligible)\b/.test(t);
}

function isClaimableValue(v) {
  const s = String(v || "").trim();
  return !!(s && !NO_BONUS_PATTERN.test(s) && !isHiddenStatus(s));
}

function waitBeforeLookupRetry(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException("Lookup canceled", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, 650);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException("Lookup canceled", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchBonusRow(username, brand, link, telegram, picName, previousRecordId, signal) {
  const body = JSON.stringify({ username, brand, link, telegram, picName, previousRecordId, preview: previewMode });
  const canSafelyRetry = previewMode || !!String(link || "").trim();
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    let data;
    try {
      res = await fetch("/lark-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal,
        cache: "no-store",
      });
      const responseText = await res.text();
      try { data = JSON.parse(responseText); } catch (_) { data = null; }
    } catch (err) {
      if (signal?.aborted || !canSafelyRetry || attempt > 0) throw err;
      await waitBeforeLookupRetry(signal);
      continue;
    }

    if (data?.ok) {
      return {
        row: data.row,
        otherBrands: data.otherBrands || [],
        lookupWarnings: data.lookupWarnings || [],
        caRecordId: data.caRecordId,
        caseRowError: data.caseRowError || "",
        justCreated: data.justCreated,
        notVip: data.notVip,
      };
    }

    const transientResponse = !data && (res.ok || res.status === 408 || res.status === 429 || res.status >= 500);
    if (transientResponse && canSafelyRetry && attempt === 0 && !signal?.aborted) {
      await waitBeforeLookupRetry(signal);
      continue;
    }
    if (!data) throw new Error(`Lookup service returned an invalid response (HTTP ${res.status}).${canSafelyRetry ? " Please try again." : " The chat link is unavailable, so it was not retried automatically."}`);
    throw new Error(data.error || `Lookup failed (HTTP ${res.status})`);
  }
  throw new Error("Lookup failed. Please try again.");
}

const SAMPLE_CHATS = [
  { chatId: "preview-test", customerName: "Bonus Test Preview", link: "", isTelegram: false, groupName: "VS96 Priority Support" },
];

let activeChats = IS_EMBEDDED_APP ? [] : SAMPLE_CHATS;
let previewMode = !IS_EMBEDDED_APP;
const BONUS_SHOWCASE_PREVIEW = !IS_EMBEDDED_APP;
let showPreviewClosedChat = false;
let activeMainTab = "customer";
const MAIN_TAB_SESSION_KEY = `rc-main-tab:${CONFIGURED_LIVECHAT_ACCOUNT || "default"}`;
try { if (sessionStorage.getItem(MAIN_TAB_SESSION_KEY) === "blast") activeMainTab = "blast"; } catch (_) {}

const DEPARTMENT_SESSION_KEY = "rc-agent-department";
let currentDepartment = "cs";
let departmentKnown = false;
try {
  const savedDepartment = sessionStorage.getItem(DEPARTMENT_SESSION_KEY);
  if (savedDepartment === "rtn" || savedDepartment === "cs") { currentDepartment = savedDepartment; departmentKnown = true; }
} catch (_) { }

function departmentFromGroups(groups) {
  const names = Array.isArray(groups) ? groups.map((name) => String(name || "").trim()) : [];
  return names.some((name) => /^priority\s+(?:96|tc)$/i.test(name)) ? "rtn" : "cs";
}

function isCustomerServiceView() {
  return DEPARTMENT_SEPARATION_ENABLED && (previewMode || DEPARTMENT_TABS_LIVE) && departmentKnown && currentDepartment === "cs";
}

function forgetDepartment() {
  departmentKnown = false;
  try { sessionStorage.removeItem(DEPARTMENT_SESSION_KEY); } catch (_) {}
  applyDepartmentChrome();
  syncMainTabs();
  renderChats(activeChats);
}

function setDepartmentFromGroups(groups) {
  if (!Array.isArray(groups)) return;
  const previousTab = activeMainTab;
  currentDepartment = departmentFromGroups(groups);
  departmentKnown = true;
  try { sessionStorage.setItem(DEPARTMENT_SESSION_KEY, currentDepartment); } catch (_) {}
  syncMainTabs();
  applyDepartmentChrome();
  if (activeMainTab !== previousTab) renderChats(activeChats);
}

function mainTabAvailability() {
  if (!previewMode && !DEPARTMENT_TABS_LIVE) {
    return { customer: true, tickets: false, blast: BLAST_LIVE, knowledge: false };
  }
  if (!DEPARTMENT_SEPARATION_ENABLED) {
    return { customer: true, tickets: ESCALATION_TICKET_ENABLED, blast: previewMode || BLAST_LIVE, knowledge: previewMode || KNOWLEDGE_TAB_ENABLED };
  }
  const rtn = !departmentKnown || currentDepartment === "rtn";
  return {
    customer: rtn,
    tickets: ESCALATION_TICKET_ENABLED,
    blast: rtn && (previewMode || BLAST_LIVE),
    knowledge: previewMode || KNOWLEDGE_TAB_ENABLED,
  };
}

function syncMainTabs() {
  const available = mainTabAvailability();
  if (qaView) Object.assign(available, { customer: true, blast: BLAST_LIVE, tickets: ESCALATION_TICKET_ENABLED, knowledge: QA_VIEW_ALSO_KNOWLEDGE });
  const { tickets: ticketsAvailable, blast: blastAvailable, knowledge: knowledgeAvailable } = available;
  if (blastRunInProgress && blastAvailable) activeMainTab = "blast";
  const unknownChatsAvailable = previewMode || qaView;
  if (!available[activeMainTab] && !(activeMainTab === "unknownChats" && unknownChatsAvailable)) {
    activeMainTab = qaView ? "unknownChats" : ticketsAvailable ? "tickets" : knowledgeAvailable ? "knowledge" : available.customer ? "customer" : "blast";
  }
  const mainTabs = document.getElementById("mainTabs");
  if (mainTabs) mainTabs.hidden = !previewMode && !DEPARTMENT_TABS_LIVE && !BLAST_LIVE;
  const retentionTab = document.getElementById("retentionTab");
  if (retentionTab) retentionTab.hidden = !available.customer;
  const ticketsTab = document.getElementById("ticketsTab");
  if (ticketsTab) ticketsTab.hidden = !ticketsAvailable;
  const blastTab = document.getElementById("blastTab");
  if (blastTab) blastTab.hidden = !blastAvailable;
  const knowledgeTab = document.getElementById("knowledgeTab");
  if (knowledgeTab) knowledgeTab.hidden = !knowledgeAvailable;
  const unknownChatsTab = document.getElementById("unknownChatsTab");
  if (unknownChatsTab) unknownChatsTab.hidden = !unknownChatsAvailable;
  const agentBadge = document.getElementById("agentBadge");
  if (agentBadge && qaView) agentBadge.hidden = !selectedAgent && activeMainTab !== "customer";
  document.querySelectorAll("[data-main-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mainTab === activeMainTab);
  });
  const chatList = document.getElementById("chatList");
  if (chatList) chatList.hidden = activeMainTab === "knowledge" || activeMainTab === "blast" || activeMainTab === "unknownChats";
  const blastView = document.getElementById("blastView");
  if (blastView) blastView.hidden = activeMainTab !== "blast";
  if (blastAvailable && activeMainTab === "blast") {
    const frame = blastView?.querySelector("iframe[data-src]");
    if (frame && !frame.src) {
      const source = new URL(frame.dataset.src, location.origin);
      if (CONFIGURED_LIVECHAT_ACCOUNT) source.searchParams.set("account", CONFIGURED_LIVECHAT_ACCOUNT);
      frame.src = source.toString();
    }
  }
  const knowledgeView = document.getElementById("knowledgeView");
  if (knowledgeView) knowledgeView.hidden = activeMainTab !== "knowledge";
  if (knowledgeAvailable && activeMainTab === "knowledge") {
    const frame = knowledgeView?.querySelector("iframe[data-src]");
    if (frame && !frame.src) frame.src = frame.dataset.src;
  }
  const unknownChatsView = document.getElementById("unknownChatsView");
  if (unknownChatsView) unknownChatsView.hidden = activeMainTab !== "unknownChats";
  if (unknownChatsAvailable && activeMainTab === "unknownChats") {
    const frame = unknownChatsView?.querySelector("iframe[data-src]");
    if (frame && !frame.src) frame.src = frame.dataset.src + (previewMode ? "?preview=1" : "");
  }
  const needsAttention = document.getElementById("needsAttentionPanel");
  if (needsAttention) needsAttention.style.display = activeMainTab === "customer" ? "" : "none";
}

function chatFromProfile(profile) {
  return {
    chatId: profile.chat.id,
    customerName: profile.name || "Unknown customer",
    link: "",
    isTelegram: false,
    groupName: "",
  };
}

function findTrackedChatByThread(profile) {
  const chat = (profile && profile.chat) || {};
  const candidates = new Set(
    [chat.id, chat.threadId, chat.thread_id, chat.thread && chat.thread.id]
      .filter(Boolean)
      .map(String)
  );
  if (!candidates.size) return "";
  for (const [key, s] of Object.entries(state)) {
    if (!s) continue;
    if (candidates.has(key)) return key;
    const m = String(s.chatUrl || "").match(/\/chats\/[^/]+\/([^/?#]+)/);
    if (m && candidates.has(m[1])) return key;
  }
  return "";
}

function showTrackedArchivedChat(trackedId, profile) {
  const s = state[trackedId];
  stopChatStatusPolling();
  activeChats = [{
    chatId: trackedId,
    customerName: (profile && profile.name) || (s.matchedRow && s.matchedRow.customerName) || s.username || "Unknown customer",
    link: s.chatUrl || "",
    isTelegram: !!s.telegram,
    groupName: "",
  }];
  s.expanded = true;
  renderChats(activeChats);
  setStatus("Archived chat — showing its saved card.");
}

let liveWidget = null;

let chatToastTimer = null;
function showChatToast(text, kind) {
  let el = document.getElementById("chatToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "chatToast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = "chat-toast " + (kind || "info") + " visible";
  clearTimeout(chatToastTimer);
  chatToastTimer = setTimeout(() => el.classList.remove("visible"), kind === "warn" ? 6000 : 3000);
}

function announceChatSwitch(prevChatId, nextChat) {
  const prev = prevChatId ? state[prevChatId] : null;
  const nextLabel = nextChat.customerName || nextChat.chatId;
  if (prev && prev.usernameDraft) {
    showChatToast(`⚠ Switched chats before "${prev.usernameDraft}" was submitted — now viewing ${nextLabel}. Come back to the other chat to finish it.`, "warn");
  } else if (prev && prev.lookupInFlight && prevChatId !== nextChat.chatId) {
    showChatToast(`Lookup for ${prev.pendingLookup?.username || prev.username || "this player"} keeps running — results will be waiting when you come back.`, "info");
  } else if (prevChatId && prevChatId !== nextChat.chatId) {
    showChatToast(`Now viewing ${nextLabel}`, "info");
  }
}

const LOOKUP_RESUME_MAX_AGE_MS = 40_000;
const LOOKUP_LOCK_MS = 10_000;
const LOOKUP_LOCK_BEAT_MS = 3_000;
const LOOKUP_DONE_PILL_MS = 10_000;
const LOOKUP_INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let bgLookupDone = null;
let bgLookupPillTimer = null;
let lookupResumeTimer = null;
let lookupResumeCandidates = null;

function isFocusedChat(chatId) {
  return !!chatId && activeChats[0]?.chatId === chatId;
}

function lookupSay(chatId, text, kind, attention = false) {
  const s = state[chatId];
  if (s) s.lookupMessage = { text, kind: kind || "info", attention: !!attention, at: Date.now() };
  if (isFocusedChat(chatId)) setStatus(text, kind);
  else logDiagnostic(`(other chat) ${text}`, kind);
}

function refreshBackgroundLookupPill() {
  let el = document.getElementById("bgLookupPill");
  if (!el) {
    el = document.createElement("div");
    el.id = "bgLookupPill";
    const anchor = document.getElementById("statusBar");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(el, anchor.nextSibling); else document.body.appendChild(el);
  }
  const focused = activeChats[0]?.chatId;
  const running = Object.entries(state).filter(([id, s]) => id !== focused && s?.lookupInFlight).length;
  const showDone = !running && bgLookupDone && bgLookupDone.until > Date.now();
  let text = "", cls = "";
  if (running) { text = running === 1 ? "1 lookup running in another chat" : `${running} lookups running in other chats`; cls = "running"; }
  else if (showDone) { text = bgLookupDone.text; cls = bgLookupDone.attention ? "attention" : "done"; }
  el.textContent = text;
  el.className = `bg-lookup-pill ${cls}${text ? "" : " hidden"}`;
  clearTimeout(bgLookupPillTimer);
  if (showDone) bgLookupPillTimer = setTimeout(refreshBackgroundLookupPill, Math.max(50, bgLookupDone.until - Date.now() + 50));
}

function announceLookupFinishedElsewhere(chatId, username) {
  const s = state[chatId];
  const who = username || s?.username || "a player";
  const attention = !!s?.lookupMessage?.attention;
  showChatToast(attention ? `⚠ Lookup for ${who} needs attention (other chat)` : `Lookup for ${who} finished (other chat)`, attention ? "warn" : "info");
  bgLookupDone = { chatId, text: attention ? `⚠ Lookup for ${who} needs a retry` : `✓ Lookup for ${who} done`, attention, until: Date.now() + LOOKUP_DONE_PILL_MS };
}

const lookupLockKey = (chatId) => `ca-lookup-lock:${chatId}`;
function lookupLockHeldByOther(chatId) {
  try {
    const lock = JSON.parse(localStorage.getItem(lookupLockKey(chatId)) || "null");
    return !!(lock && lock.instance !== LOOKUP_INSTANCE_ID && Number(lock.until) > Date.now());
  } catch (_) { return false; }
}
function takeLookupLock(chatId) {
  try { localStorage.setItem(lookupLockKey(chatId), JSON.stringify({ instance: LOOKUP_INSTANCE_ID, until: Date.now() + LOOKUP_LOCK_MS })); } catch (_) { }
}
function releaseLookupLock(chatId) {
  try {
    const lock = JSON.parse(localStorage.getItem(lookupLockKey(chatId)) || "null");
    if (lock && lock.instance === LOOKUP_INSTANCE_ID) localStorage.removeItem(lookupLockKey(chatId));
  } catch (_) { }
}

async function runLookup(chatId, { username, brand, telegramNow = false, link = "", previousRecordId = null, forcing = false, resumed = false, btn = null }) {
  const s = state[chatId];
  if (!s || s.lookupInFlight) return;
  let needFullRender = forcing;
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 45000);
  lookupControllers.set(chatId, controller);
  s.lookupInFlight = true;
  s.lookupMessage = null;
  s.pendingLookup = { username, brand, link, telegram: !!telegramNow, previousRecordId, forcing: !!forcing, agent: selectedAgent, startedAt: Date.now(), resumed: !!resumed };
  takeLookupLock(chatId);
  const lockBeat = setInterval(() => takeLookupLock(chatId), LOOKUP_LOCK_BEAT_MS);
  if (btn) {
    btn.dataset.action = "cancelLookup";
    btn.classList.add("lookup-cancel-btn");
    btn.title = "Cancel this lookup";
    btn.disabled = false;
    btn.textContent = "Cancel";
  } else if (isFocusedChat(chatId)) {
    renderChats(activeChats);
  }
  refreshBackgroundLookupPill();
  saveState();
  try {
    const { row, otherBrands, lookupWarnings, caRecordId, caseRowError, notVip } = await fetchBonusRow(username, brand, link, telegramNow, selectedAgent, previousRecordId, controller.signal);
    s.caLinkSaved = !!link;
    s.matchedRow = row;
    s.otherBrandMatches = otherBrands;
    s.caRecordId = caRecordId;
    if (previousRecordId && caRecordId !== previousRecordId) rememberDeletedRecord(previousRecordId);
    s.caOwner = selectedAgent;
    s.claimedPrograms = {};
    s.vs96FeedbackQuery1 = "";
    s.vs96FeedbackQuery2 = "";
    s.riskReloadAmount = ""; resetHalloweenInput(s);
    s.gracePeriodActivated = false;
    s.releasedBonusAmount = "";
    s.releasedAmountRaw = "";
    s.claimSecret = false;
    s.claimSecretManual = false;
    const sameForced = !!s.forcedVipFor && s.forcedVipFor.toLowerCase() === username.toLowerCase();
    if (isFocusedChat(chatId)) showChatToast(`✓ Looked up "${username}" — ${brand}`, "info");
    if (notVip && !forcing && !sameForced) {
      s.notVipResult = true;
      s.forcedVipFor = "";
      setUnknown(chatId, true, { silent: true });
      needFullRender = true;
      lookupSay(chatId, 'Not VVIP — marked Unknown player. Use "Force lookup" if they are VIP but not on the list yet.', "error");
    } else if (notVip) {
      s.notVipResult = false;
      s.forcedVipFor = username;
      lookupSay(chatId, `Force lookup: ${username} isn't on the VIP list yet — kept as a VIP.`);
    } else {
      s.notVipResult = false;
      s.forcedVipFor = "";
      lookupSay(chatId, row ? `Found ${username} under ${brand}.` : "No record found.");
    }
    if (lookupWarnings.length) {
      lookupSay(chatId, `Lookup completed with some checks unavailable: ${lookupWarnings.join(", ")}. Click Look up to retry.`, "error", true);
    }
    if (caseRowError) {
      lookupSay(chatId, lookupWarnings.length ? `${caseRowError} Also unavailable: ${lookupWarnings.join(", ")}.` : caseRowError, "error", true);
    }
  } catch (err) {
    if (forcing) { s.isUnknown = true; reportUnknownTick(chatId, true, true); }
    if (controller.signal.aborted) {
      lookupSay(chatId, timedOut ? "Lookup timed out after 45 seconds. Try again." : "Lookup canceled.", timedOut ? "error" : "info", timedOut);
    } else {
      lookupSay(chatId, "Lookup failed: " + err.message, "error", true);
    }
  } finally {
    clearTimeout(timeoutId);
    clearInterval(lockBeat);
    if (lookupControllers.get(chatId) === controller) lookupControllers.delete(chatId);
    scheduleNeedsAttentionRefresh(1500);
    s.lookupInFlight = false;
    s.pendingLookup = null;
    releaseLookupLock(chatId);
    if (isFocusedChat(chatId)) {
      if (needFullRender) {
        renderChats(activeChats);
      } else {
        const currentCard = Array.from(chatListEl.querySelectorAll(".chat-card")).find((item) => item.dataset.chatId === chatId);
        if (currentCard) {
          const currentButton = currentCard.querySelector('button[data-action="cancelLookup"], button[data-action="lookup"]');
          if (currentButton) {
            currentButton.dataset.action = "lookup";
            currentButton.classList.toggle("lookup-cancel-btn", false);
            currentButton.classList.toggle("force", !!s.notVipResult);
            currentButton.title = s.notVipResult ? "Not on the VIP list — look up again anyway and keep them as a VIP" : "";
            currentButton.disabled = s.isUnknown && !s.notVipResult;
            currentButton.textContent = s.notVipResult ? "Force lookup" : "Look up";
          }
          const playerInfo = currentCard.querySelector(".player-info-slot");
          const ticketSlot = currentCard.querySelector(".ticket-slot");
          const autoFields = currentCard.querySelector(".auto-fields-slot");
          const noteSlot = currentCard.querySelector(".note-slot");
          if (playerInfo) playerInfo.innerHTML = renderPlayerInfo(chatId);
          if (noteSlot) noteSlot.innerHTML = renderNoteSection(chatId);
          if (ticketSlot) ticketSlot.innerHTML = renderTickets(chatId);
          if (autoFields) autoFields.innerHTML = renderAutoFields(chatId);
        }
      }
    } else {
      announceLookupFinishedElsewhere(chatId, username);
    }
    refreshBackgroundLookupPill();
    saveState();
  }
}

function resumePendingLookups() {
  clearTimeout(lookupResumeTimer);
  if (!selectedAgent || !lookupResumeCandidates) return;
  let waiting = false;
  for (const chatId of [...lookupResumeCandidates]) {
    const s = state[chatId];
    const p = s?.pendingLookup;
    if (!p || s.lookupInFlight) { lookupResumeCandidates.delete(chatId); continue; }
    const age = Date.now() - Number(p.startedAt || 0);
    if (s.lookupMessage && Number(s.lookupMessage.at) >= Number(p.startedAt || 0)) { s.pendingLookup = null; lookupResumeCandidates.delete(chatId); continue; }
    if (p.agent !== selectedAgent || (s.caOwner && s.caOwner !== selectedAgent)) { lookupResumeCandidates.delete(chatId); continue; }
    if (p.resumed || !(age >= 0 && age < LOOKUP_RESUME_MAX_AGE_MS)) {
      s.pendingLookup = null;
      lookupResumeCandidates.delete(chatId);
      lookupSay(chatId, "Lookup was interrupted — click Look up.", "info", true);
      saveState();
      continue;
    }
    if (lookupLockHeldByOther(chatId)) { waiting = true; continue; }
    lookupResumeCandidates.delete(chatId);
    takeLookupLock(chatId);
    void runLookup(chatId, { username: p.username, brand: p.brand, telegramNow: p.telegram, link: p.link || "", previousRecordId: p.previousRecordId || null, forcing: !!p.forcing, resumed: true });
  }
  if (waiting) lookupResumeTimer = setTimeout(resumePendingLookups, 2_000);
}
function startLookupResume() {
  lookupResumeCandidates = new Set(Object.entries(state).filter(([, s]) => s?.pendingLookup).map(([chatId]) => chatId));
  resumePendingLookups();
}

let archiveOpening = "";

function openFreshArchivedCard(threadId, entry, profile) {
  if (!state[threadId]) {
    ensureChatState({ chatId: threadId, customerName: (profile && profile.name) || entry.customer || "", link: "", isTelegram: false, groupName: "" });
  }
  const s = state[threadId];
  s.chatOpen = false;
  if (!s.chatUrl && entry.chatId) s.chatUrl = `https://my.livechatinc.com/chats/${entry.chatId}/${threadId}`;
  saveState();
  resolveBrandFromGroupId(threadId, profile && profile.chat && profile.chat.groupID);
  showTrackedArchivedChat(threadId, profile);
  setStatus("Archived chat from your unrecorded list — look the player up and record it, or tick Unknown player.");
}

function applyProfile(profile) {
  reportQaChat(profile);
  archiveOpening = "";
  if (!profile || !profile.chat || !profile.chat.id) {
    stopChatStatusPolling();
    activeChats = [];
    renderChats(activeChats);
    return;
  }
  if (profile.source === "archives") {
    const trackedId = findTrackedChatByThread(profile);
    if (trackedId) {
      showTrackedArchivedChat(trackedId, profile);
      return;
    }
    const threadId = String(profile.chat.id);
    archiveOpening = threadId;
    restoreCardFromLark(threadId, { archived: true, customerName: profile.name || "" }).then((restored) => {
      if (restored && state[threadId]) { showTrackedArchivedChat(threadId, profile); return; }
      if (archiveOpening !== threadId) return;
      const entry = unrecordedChats.find((chat) => chat.threadId === threadId);
      if (entry) openFreshArchivedCard(threadId, entry, profile);
      else logDiagnostic(unrecordedLoaded ? `Archived chat ${threadId}: not on your unrecorded list, so no card is made for it.` : `Archived chat ${threadId}: your unrecorded list is still loading — its card opens when it arrives.`, "info");
    });
  }
  if (profile.source && profile.source !== "chats") {
    stopChatStatusPolling();
    activeChats = [];
    renderChats(activeChats);
    setStatus(
      profile.source === "archives"
        ? "Viewing an archived chat — this widget only tracks live chats."
        : "Viewing a customer profile — this widget only tracks live chats.",
    );
    return;
  }
  const chat = chatFromProfile(profile);
  announceChatSwitch(activeChats[0]?.chatId, chat);
  activeChats = [chat];
  if (bgLookupDone && bgLookupDone.chatId === chat.chatId) bgLookupDone = null;
  refreshBackgroundLookupPill();
  ensureChatState(chat);
  state[chat.chatId].expanded = true;
  renderChats(activeChats);
  resolveBrandFromGroupId(chat.chatId, profile.chat.groupID);
  startChatStatusPolling(chat.chatId);
  if (!state[chat.chatId].caRecordId) restoreCardFromLark(chat.chatId, { customerName: chat.customerName });
}

const detectedBrandFor = new Map();
const groupIdFor = new Map();

function liveChatAgentTokens() {
  const tokens = {};
  try {
    for (const accountKey of ["lc1", "lc2"]) {
      const expiry = Number(sessionStorage.getItem(`ca-livechat-agent-token-expiry:${accountKey}`) || 0);
      const token = sessionStorage.getItem(`ca-livechat-agent-token:${accountKey}`) || "";
      if (token && expiry > Date.now()) tokens[accountKey] = token;
    }
  } catch (_) { }
  return tokens;
}

const LIVECHAT_LOGIN_BACKUP = "ca-livechat-login-backup";
function saveLiveChatLogin(accountKey, token, expiresAt) {
  try {
    sessionStorage.setItem(`ca-livechat-agent-token:${accountKey}`, token);
    sessionStorage.setItem(`ca-livechat-agent-token-expiry:${accountKey}`, String(expiresAt));
    sessionStorage.setItem("ca-livechat-selected-account", accountKey);
  } catch (_) { }
  try { localStorage.setItem(`${LIVECHAT_LOGIN_BACKUP}:${accountKey}`, JSON.stringify({ token, expiresAt: Number(expiresAt) })); } catch (_) { }
}
function forgetLiveChatLogin(accountKey) {
  try {
    sessionStorage.removeItem(`ca-livechat-agent-token:${accountKey}`);
    sessionStorage.removeItem(`ca-livechat-agent-token-expiry:${accountKey}`);
  } catch (_) { }
  try { localStorage.removeItem(`${LIVECHAT_LOGIN_BACKUP}:${accountKey}`); } catch (_) { }
}
function restoreLiveChatLogins() {
  for (const accountKey of ["lc1", "lc2"]) {
    try {
      const own = Number(sessionStorage.getItem(`ca-livechat-agent-token-expiry:${accountKey}`) || 0) > Date.now()
        && sessionStorage.getItem(`ca-livechat-agent-token:${accountKey}`);
      if (own) continue;
      const shared = JSON.parse(localStorage.getItem(`${LIVECHAT_LOGIN_BACKUP}:${accountKey}`) || "null");
      if (!shared || !shared.token) continue;
      if (!(shared.expiresAt > Date.now())) { localStorage.removeItem(`${LIVECHAT_LOGIN_BACKUP}:${accountKey}`); continue; }
      sessionStorage.setItem(`ca-livechat-agent-token:${accountKey}`, shared.token);
      sessionStorage.setItem(`ca-livechat-agent-token-expiry:${accountKey}`, String(shared.expiresAt));
      if (!sessionStorage.getItem("ca-livechat-selected-account")) sessionStorage.setItem("ca-livechat-selected-account", accountKey);
    } catch (_) { }
  }
}

const LIVECHAT_TOKEN_EPOCH = "2026-10-08-accounts-scopes";
const LIVECHAT_TOKEN_EPOCH_KEY = "ca-livechat-token-epoch";
function dropOldLiveChatTokens() {
  let done = false;
  try { done = sessionStorage.getItem(LIVECHAT_TOKEN_EPOCH_KEY) === LIVECHAT_TOKEN_EPOCH; } catch (_) { }
  try { done = done || localStorage.getItem(LIVECHAT_TOKEN_EPOCH_KEY) === LIVECHAT_TOKEN_EPOCH; } catch (_) { }
  if (!done) for (const accountKey of ["lc1", "lc2"]) forgetLiveChatLogin(accountKey);
  try { sessionStorage.setItem(LIVECHAT_TOKEN_EPOCH_KEY, LIVECHAT_TOKEN_EPOCH); } catch (_) { }
  try { localStorage.setItem(LIVECHAT_TOKEN_EPOCH_KEY, LIVECHAT_TOKEN_EPOCH); } catch (_) { }
}
dropOldLiveChatTokens();
restoreLiveChatLogins();

async function resolveBrandFromGroupId(chatId, groupID) {
  if (groupID) groupIdFor.set(chatId, groupID);
  if (!chatId) return;
  if (!groupID) {
    if (!rawGroupIdMissingLoggedFor.has(chatId)) {
      rawGroupIdMissingLoggedFor.add(chatId);
      logDiagnostic(`Brand auto-detect skipped for this chat — LiveChat's SDK profile had no groupID.`, "warn");
    }
  }
  try {
    const res = await fetch("/livechat-group-name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupID, threadId: chatId, agentTokens: liveChatAgentTokens() }),
    });
    const data = await res.json();
    if (data.accountKey) setCurrentLiveChatAccount(data.accountKey, chatId);
    if (data.ok && Array.isArray(data.departmentGroups)) {
      setDepartmentFromGroups(data.departmentGroups);
    }
    if (!data.ok || !data.groupName) {
      logDiagnostic(
        `Brand auto-detect failed for group ID "${groupID}"${data.error ? `: ${data.error}` : " — group not found in LiveChat's group list."}`,
        "warn"
      );
      scheduleBrandRetry(chatId, groupID);
      return;
    }
    const s = state[chatId];
    if (!s || s.brand) return;
    const derived = deriveBrandFromGroup(data.groupName);
    const matchedBrand = brandOptions.find((b) => b.toLowerCase() === derived.toLowerCase());
    if (!matchedBrand) {
      if (!brandOptions.length) scheduleBrandRetry(chatId, groupID);
      if (derived && Date.now() - lastBrandListRefreshAt > 30_000) {
        lastBrandListRefreshAt = Date.now();
        if (!(await fetchBootstrapOptions({ fresh: true }))) await fetchBrandOptions({ fresh: true });
        if (brandOptions.some((b) => b.toLowerCase() === derived.toLowerCase())) return resolveBrandFromGroupId(chatId, groupID);
      }
      if (derived) {
        logDiagnostic(
          `Brand auto-detect found "${derived}" from group "${data.groupName}", but that's not an existing Brand option (${brandOptions.length} options loaded) — left blank for manual pick.`,
          "warn"
        );
      }
      return;
    }
    detectedBrandFor.set(chatId, matchedBrand);
    brandRetryAttempts.delete(chatId);
    s.brand = matchedBrand;
    if (!s.escalation.brand) s.escalation.brand = deriveFullBrandCode(data.groupName);
    logDiagnostic(`Auto-detected brand "${s.brand}" from group "${data.groupName}"${data.groups && data.groups.length > 1 ? ` (chat's groups: ${data.groups.join(", ")})` : ""}.`);
    if (activeChats[0]?.chatId === chatId) renderChats(activeChats);
    checkLastUsername(chatId);
  } catch (err) {
    logDiagnostic(`Brand auto-detect request failed: ${err.message}`, "warn");
    scheduleBrandRetry(chatId, groupID);
  }
}
const rawGroupIdMissingLoggedFor = new Set();

function extractStableChatId(link) {
  const m = String(link || "").match(/\/chats\/([^/]+)\/[^/]+/);
  return m ? m[1] : "";
}

async function checkLastUsername(chatId) {
  const s = state[chatId];
  if (!s || s.lastUsernameStarted) return;
  const chatDef = activeChats.find((c) => c.chatId === chatId);
  const stableId = extractStableChatId(s.chatUrl || chatDef?.link);
  if (!stableId || !s.brand) return;
  s.lastUsernameStarted = true;
  s.lastUsernameLoading = true;
  updateLastUsernameUi(chatId);
  try {
    const res = await fetch("/lark-last-username", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: stableId, brand: s.brand }),
    });
    const data = await res.json();
    if (data.ok && data.found) {
      s.lastUsernameFound = true;
      s.lastUsernameValue = data.username;
      logDiagnostic(`Recognized this chat — last recorded username was "${data.username}".`, "success");
      if (!s.username) s.username = data.username;
    } else {
      s.lastUsernameFound = false;
      if (data.error) logDiagnostic(`Last-username lookup failed: ${data.error}`, "warn");
    }
  } catch (_) { }
  s.lastUsernameLoading = false;
  s.lastUsernameChecked = true;
  updateLastUsernameUi(chatId);
}

function updateLastUsernameUi(chatId) {
  const s = state[chatId];
  const card = chatListEl.querySelector(`.chat-card[data-chat-id="${chatId}"]`);
  if (!s || !card) return;
  const usernameInput = card.querySelector(".username-input");
  if (usernameInput) {
    usernameInput.placeholder = s.lastUsernameLoading ? "Checking for a previous record…" : "Player username / UID";
    if (!usernameInput.value && s.username) usernameInput.value = s.username;
  }
  const slot = card.querySelector(".player-info-slot");
  if (slot) slot.innerHTML = renderPlayerInfo(chatId);
}

let chatStatusPollTimer = null;
const CHAT_STATUS_POLL_MS = 2_000;
const CLOSE_STATUS_CONFIRMATIONS = 2;
const closeStatusEvidenceByChat = new Map();
const rawStatusDebugLoggedFor = new Set();
const firstCheckLoggedFor = new Set();
const errorLoggedFor = new Set();
const autoMissingLoggedFor = new Map();

let chatStatusPollTick = null;
function stopChatStatusPolling() {
  chatStatusPollTick = null;
  if (chatStatusPollTimer) {
    clearInterval(chatStatusPollTimer);
    chatStatusPollTimer = null;
  }
}

function startChatStatusPolling(chatId) {
  stopChatStatusPolling();
  const tick = () => {
    const s = state[chatId];
    if (!s || !s.chatOpen || s.logged) { stopChatStatusPolling(); return; }
    if (document.hidden) return;
    checkChatStatus(chatId);
  };
  chatStatusPollTick = tick;
  tick();
  chatStatusPollTimer = setInterval(tick, CHAT_STATUS_POLL_MS);
}

async function checkChatStatus(chatId) {
  const s = state[chatId];
  if (!s || !s.chatOpen || s.logged) return;
  try {
    const realChatId = s.chatUrl?.match(/\/chats\/([^/]+)\//)?.[1] || null;
    const res = await fetch("/livechat-chat-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, realChatId, accountKey: s.liveChatAccount || currentLiveChatAccount || undefined, debug: !firstCheckLoggedFor.has(chatId) || undefined }),
    });
    const data = await res.json();
    if (!data.ok) return;
    if (data.accountKey) setCurrentLiveChatAccount(data.accountKey, chatId);

    const linkSuffix = data.chatUrl ? ` (${data.chatUrl})` : ` (thread ${chatId}, chat id not yet resolved)`;

    if (data.chatUrl && s.chatUrl !== data.chatUrl) {
      s.chatUrl = data.chatUrl;
      const chatEntry = activeChats.find((c) => c.chatId === chatId);
      if (chatEntry) chatEntry.link = data.chatUrl;
      if (activeChats[0]?.chatId === chatId) renderChats(activeChats);
      checkLastUsername(chatId);
    }
    saveLinkToRecord(chatId);

    if (data.error) {
      if (!errorLoggedFor.has(chatId)) {
        errorLoggedFor.add(chatId);
        logDiagnostic(`Chat status check failed for thread "${chatId}": ${data.error}`, "error");
      }
      return;
    }

    if (data.notConfigured) {
      if (!rawStatusDebugLoggedFor.has(chatId)) {
        rawStatusDebugLoggedFor.add(chatId);
        logDiagnostic("Telegram/auto-close detection is off — LIVECHAT_PAT isn't set on this site.", "warn");
      }
      return;
    }

    if (data.notFound) {
      if (!rawStatusDebugLoggedFor.has(chatId)) {
        rawStatusDebugLoggedFor.add(chatId);
        logDiagnostic(`Chat lookup for thread "${chatId}" found no match in list_chats — raw: ${JSON.stringify(data.raw ?? null)}`, "warn");
      }
      return;
    }

    if (!firstCheckLoggedFor.has(chatId)) {
      firstCheckLoggedFor.add(chatId);
      logDiagnostic(`First chat status check succeeded: isActive=${data.isActive}, isTelegram=${data.isTelegram}.${linkSuffix}`);
    }

    if (typeof data.isTelegram === "boolean" && data.isTelegram !== s.telegram && !s.telegramManual) {
      s.telegram = data.isTelegram;
      logDiagnostic(`Auto-detected Telegram chat = ${data.isTelegram}.${linkSuffix}`);
      if (activeChats[0]?.chatId === chatId) renderChats(activeChats);
    } else if (data.isActive === null && !rawStatusDebugLoggedFor.has(chatId)) {
      rawStatusDebugLoggedFor.add(chatId);
      logDiagnostic("Chat status fields not recognized — raw: " + JSON.stringify(data.raw ?? null).slice(0, 500), "warn");
    }

    if (data.isActive !== false) closeStatusEvidenceByChat.delete(chatId);

    if (data.isActive === false && s.chatOpen) {
      if (!realChatId) return;
      const now = Date.now();
      const previousEvidence = closeStatusEvidenceByChat.get(chatId);
      let confirmations = 1;
      if (previousEvidence) {
        if (now - previousEvidence.at < CHAT_STATUS_POLL_MS * 0.75) return;
        confirmations = previousEvidence.count + 1;
      }
      closeStatusEvidenceByChat.set(chatId, { count: confirmations, at: now });
      if (confirmations < CLOSE_STATUS_CONFIRMATIONS) return;

      closeStatusEvidenceByChat.delete(chatId);
      logDiagnostic(`Auto-detected chat closed — auto-recording.${linkSuffix}`, "success");
      if (activeChats[0]?.chatId === chatId) stopChatStatusPolling();
      s.chatOpen = false;
      if (activeChats[0]?.chatId === chatId) renderChats(activeChats);
      await submitRecord(chatId, { auto: true });
      renderNeedsAttentionPanel();
    }
  } catch (_) { }
}

function initLiveChatSdk() {
  if (typeof LiveChat === "undefined" || !LiveChat.createDetailsWidget) {
    logDiagnostic("LiveChat Agent App SDK script not found — staying in demo/preview mode.");
    return;
  }
  LiveChat.createDetailsWidget().then((widget) => {
    logDiagnostic("Connected to LiveChat Agent App SDK — showing the real active chat.", "success");
    liveWidget = widget;
    previewMode = false;
    syncMainTabs();
    activeChats = [];
    renderChats(activeChats);
    applyProfile(widget.getCustomerProfile());
    widget.on("customer_profile", applyProfile);
  }).catch((err) => {
    logDiagnostic("LiveChat Agent App SDK failed to connect (" + err.message + ") — staying in demo/preview mode.", "error");
  });
}

function deriveBrandFromGroup(groupName) {
  if (!groupName) return "";
  return groupName
    .replace(/\s*(prior\w*\s+support|general)\s*/i, "")
    .replace(/\d+/g, "")
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveFullBrandCode(groupName) {
  if (!groupName) return "";
  return groupName
    .replace(/\s*(prior\w*\s+support|general)\s*/i, "")
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

let inquiryOptions = [
  "Free Spin", "Ang Pao", "Deposit Challenge", "Feedback", "TOP P&L",
  "TOP LTV", "Grace Period", "1D", "3D", "7D", "14D", "19D", "21D",
  "24D", "30D", "Complain", "Ask free credit", "WD/DP problem",
  "Angpao request", "Game Tips", "Transition", "System problem",
  "Promotion", "Referral Bonus", "Bank problem", "Technical Issue",
  "Betting inquiries", "Others", "Unknown", "Account Inquiries",
  "Rebate", "Game Bonus", "Pg Maintenance", "VIP Salary",
  "Unable to Access Game", "Bonus Checking", "Unrelated", "Unable Log In",
  "RAYA PROMOTION", "No Inquiry", "Sportsbook", "Unable To Access Website",
  "Reload - Free Spin", "Reload - Ang Pao", "Free Spin Request",
  "Website Inquiries", "Lucky Wheel", "Plinko", "VIP Upgrade SMS",
  "Apps Download", "Cashback", "VIP SMS", "Redeem Code",
  "12hour VIP Deposit Boost", "Telegram RM28", "VVIP COMPLAINT",
  "KYC", "OTP Failure", "Forgot Username", "Forgot Password",
  "Missing Fund", "Sms Promo", "Telegram", "Birthday", "LuckyDraw",
  "Goal321", "TO NOT UPDATED", "Rescue Bonus", "TOP Deposit",
  "Maintenance", "Telegram Transition Message", "Unclear Inquiries",
  "Halloween Day 1", "Halloween Day 2", "Halloween Day 3",
];
async function fetchInquiryOptions({ fresh = false } = {}) {
  try {
    const res = await fetch("/lark-inquiry-list", fresh ? { cache: "no-store" } : undefined);
    const data = await res.json();
    if (data.ok && data.options && data.options.length) inquiryOptions = data.options;
  } catch (_) { }
}

const BONUS_INQUIRY_MAP = {
  riskPlayer: "Bonus Checking",
  topPnl: "TOP P&L",
  gracePeriod: "Grace Period",
  ltvTest: "TOP LTV",
  vipBooster: "12hour VIP Deposit Boost",
  telegram28: "Telegram RM28",
  redeemCode: "Redeem Code",
  specialReload: "Reload - Ang Pao",
  mooncake: "Moon Bonus",
  vs96Feedback: "VS96 Feedback bonus",
};

function resolveInquiryForProgram(key, display) {
  if (key === "riskPlayer") {
    const match = String(display || "").match(/^\s*(\d+D)\b/i);
    const tag = match ? match[1].toUpperCase() : null;
    if (tag && inquiryOptions.includes(tag)) return tag;
  }
  return BONUS_INQUIRY_MAP[key] || configuredBonusPrograms.find((item) => item.key === key)?.inquiry;
}

function programHasAmount(key) {
  return AMOUNT_ELIGIBLE_PROGRAMS.has(key)
    || configuredBonusPrograms.some((item) => item.key === key && item.amountEligible);
}

let statusOptions = ["Solved", "Unsolved", "Given", "Not given", "Activated"];
async function fetchStatusOptions({ fresh = false } = {}) {
  try {
    const res = await fetch("/lark-status-list", fresh ? { cache: "no-store" } : undefined);
    const data = await res.json();
    if (data.ok && data.options && data.options.length) statusOptions = data.options;
  } catch (_) { }
}

const chatListEl = document.getElementById("chatList");
document.getElementById("mainTabs")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-main-tab]");
  if (!button || button.hidden) return;
  activeMainTab = button.dataset.mainTab;
  syncMainTabs();
  try { sessionStorage.setItem(MAIN_TAB_SESSION_KEY, activeMainTab); } catch (_) {}
  if (activeMainTab !== "knowledge" && activeMainTab !== "blast" && activeMainTab !== "unknownChats") renderChats(activeChats);
});
const statusEl = document.getElementById("statusBar");
const state = {};
const lookupControllers = new Map();
let hasAutoExpandedOnce = false;

const LIVECHAT_ACCOUNT_SESSION_KEY = "rc-livechat-account";
let currentLiveChatAccount = "";
try {
  const savedAccount = CONFIGURED_LIVECHAT_ACCOUNT || sessionStorage.getItem(LIVECHAT_ACCOUNT_SESSION_KEY) || "";
  if (/^lc[12]$/.test(savedAccount)) currentLiveChatAccount = savedAccount;
} catch (_) { }

function setCurrentLiveChatAccount(accountKey, chatId) {
  if (!/^lc[12]$/.test(String(accountKey || ""))) return;
  const changed = currentLiveChatAccount !== accountKey;
  currentLiveChatAccount = accountKey;
  try { sessionStorage.setItem(LIVECHAT_ACCOUNT_SESSION_KEY, accountKey); } catch (_) { }
  const targetId = chatId || activeChats[0]?.chatId;
  if (targetId && state[targetId]) state[targetId].liveChatAccount = accountKey;
  if (changed) {
    staleRecords = [];
    renderNeedsAttentionPanel();
    scheduleNeedsAttentionRefresh(0);
    logDiagnostic(`This tab is connected to LiveChat ${accountKey === "lc1" ? "account 1" : "account 2"}.`, "success");
  }
}

const STATE_STORAGE_KEY = "rc-chat-state";
const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const lastSyncedJson = new Map();
function stateSnapshot(s) {
  const { _savedAt, lookupInFlight, unclaimInFlight, ...rest } = s || {};
  return JSON.stringify(rest);
}
function persistableState(s, savedAt) {
  const { lookupInFlight, unclaimInFlight, ...rest } = s;
  return { ...rest, _savedAt: savedAt };
}
const knownBrandFor = new Map();
function keepBrand(chatId, s) {
  if (s && !s.brand && knownBrandFor.get(chatId)) { s.brand = knownBrandFor.get(chatId); return true; }
  return false;
}
function markStateSynced(chatId) {
  lastSyncedJson.set(chatId, stateSnapshot(state[chatId]));
}

let storageDirty = true;
let lastFullStateSyncAt = 0;
const FULL_STATE_SYNC_MS = 60_000;
function hasLocalStateChanges() {
  for (const [chatId, s] of Object.entries(state)) {
    const synced = lastSyncedJson.get(chatId);
    if (synced === undefined || stateSnapshot(s) !== synced) return true;
  }
  return false;
}

function saveState() {
  try {
    if (!storageDirty && Date.now() - lastFullStateSyncAt < FULL_STATE_SYNC_MS && !hasLocalStateChanges()) return;
    storageDirty = false;
    lastFullStateSyncAt = Date.now();
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(STATE_STORAGE_KEY) || "{}") || {}; } catch (_) { raw = {}; }
    const now = Date.now();
    let dirty = false;
    let adopted = false;
    for (const [chatId, s] of Object.entries(state)) {
      if (s && s.brand) knownBrandFor.set(chatId, s.brand);
      const cur = stateSnapshot(s);
      const synced = lastSyncedJson.get(chatId);
      const stored = raw[chatId];
      const storedJson = stored ? stateSnapshot(stored) : undefined;
      if (synced !== undefined && cur !== synced && storedJson !== undefined && storedJson !== synced) {
        const base = JSON.parse(synced);
        const theirs = JSON.parse(storedJson);
        const merged = { ...theirs };
        for (const k of Object.keys(s)) {
          if (JSON.stringify(s[k]) !== JSON.stringify(base[k])) merged[k] = s[k];
        }
        for (const k of Object.keys(base)) {
          if (!(k in s) && JSON.stringify(theirs[k]) === JSON.stringify(base[k])) delete merged[k];
        }
        for (const k of Object.keys(s)) delete s[k];
        Object.assign(s, JSON.parse(JSON.stringify(merged)));
        keepBrand(chatId, s);
        raw[chatId] = persistableState(s, now);
        lastSyncedJson.set(chatId, stateSnapshot(s));
        dirty = true;
        adopted = true;
        if (agentActed(s)) logCaseOrigin(chatId, "case content came from another tab of this browser");
        continue;
      }
      if (synced !== undefined && cur === synced) {
        if (stored) {
          const { _savedAt, ...rest } = stored;
          if (storedJson !== cur) {
            const { lookupInFlight, unclaimInFlight } = s;
            for (const k of Object.keys(s)) delete s[k];
            const storedSnapshot = stateSnapshot(rest);
            Object.assign(s, rest);
            if (lookupInFlight) s.lookupInFlight = true;
            if (unclaimInFlight) s.unclaimInFlight = true;
            const restoredBrand = keepBrand(chatId, s);
            lastSyncedJson.set(chatId, restoredBrand ? storedSnapshot : stateSnapshot(s));
            adopted = true;
            if (agentActed(s)) logCaseOrigin(chatId, "case content came from another tab of this browser");
          }
        }
        continue;
      }
      raw[chatId] = persistableState(s, now);
      lastSyncedJson.set(chatId, cur);
      dirty = true;
    }
    if (dirty) {
      for (const [chatId, entry] of Object.entries(raw)) {
        if (!entry || now - (entry._savedAt || 0) >= STATE_MAX_AGE_MS) delete raw[chatId];
      }
      localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(raw));
    }
    if (adopted && typeof renderNeedsAttentionPanel === "function") renderNeedsAttentionPanel();
  } catch (_) { }
}

function loadPersistedState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_STORAGE_KEY) || "{}");
    const now = Date.now();
    const fresh = {};
    for (const [chatId, s] of Object.entries(raw)) {
      if (s && now - (s._savedAt || 0) < STATE_MAX_AGE_MS) {
        delete s._savedAt;
        delete s.lookupInFlight;
        delete s.unclaimInFlight;
        fresh[chatId] = s;
      }
    }
    return fresh;
  } catch (_) {
    return {};
  }
}

function renderStatusChip(chatId) {
  const s = state[chatId];
  if (!s.status) return "";
  return `<span class="inquiry-chip">${s.status}<button type="button" class="inquiry-chip-remove" data-action="clearStatus" data-chat="${chatId}" aria-label="Clear status">✕</button></span>`;
}

function renderStatusDropdown(chatId, query) {
  const s = state[chatId];
  const q = (query || "").trim().toLowerCase();
  const filtered = statusOptions.filter((opt) => !q || opt.toLowerCase().includes(q));
  if (!filtered.length) return `<div class="inquiry-option-empty">No matching status</div>`;
  return filtered.map((opt) => {
    const active = s.status === opt;
    return `
    <button type="button" class="inquiry-option ${active ? "active" : ""}" data-action="selectStatus" data-chat="${chatId}" data-value="${opt}">
      <span class="inquiry-option-check">${active ? "✓" : ""}</span>${opt}
    </button>`;
  }).join("");
}

function refreshStatusChip(card, chatId) {
  card.querySelector(".status-chip-slot").innerHTML = renderStatusChip(chatId);
  const searchInput = card.querySelector(".status-search");
  if (searchInput) searchInput.placeholder = state[chatId].status ? "" : "Select status…";
}

function renderBrandDisplay(chatId) {
  const s = state[chatId];
  const empty = !s.brand;
  return `<span class="status-value ${empty ? "placeholder" : ""}">${s.brand || "Select brand…"}</span><span class="status-caret">▾</span>`;
}

function renderBrandOptions(chatId, query) {
  const s = state[chatId];
  const q = (query || "").trim().toLowerCase();
  const filtered = brandOptions.filter((b) => !q || b.toLowerCase().includes(q));
  if (!filtered.length) return `<div class="inquiry-option-empty">No matching brand</div>`;
  return filtered.map((b) => {
    const active = s.brand === b;
    return `
    <button type="button" class="inquiry-option ${active ? "active" : ""}" data-action="selectBrand" data-chat="${chatId}" data-value="${b}">
      <span class="inquiry-option-check">${active ? "✓" : ""}</span>${b}
    </button>`;
  }).join("");
}

function renderBrandDropdown(chatId) {
  return `
    <input type="text" class="brand-search" placeholder="Search brand…" autocomplete="off" />
    <div class="brand-options">${renderBrandOptions(chatId, "")}</div>
  `;
}

const DOB_MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOB_WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const pad2 = (n) => String(n).padStart(2, "0");
const dobKey = (y, m, day) => `${y}-${pad2(m + 1)}-${pad2(day)}`;
function dobYearOptions(includeYear) {
  const nowY = new Date().getFullYear();
  const top = Math.max(nowY, includeYear);
  const bottom = Math.min(nowY - 100, includeYear);
  const years = [];
  for (let y = top; y >= bottom; y--) years.push(y);
  return years;
}

function formatDobDisplay(dob) {
  if (!dob) return "";
  const [y, m, d] = dob.split("-");
  return `${d}/${m}/${y}`;
}

function renderDobDisplay(chatId) {
  const s = state[chatId];
  const empty = !s.dob;
  return `<span class="status-value ${empty ? "placeholder" : ""}">${empty ? "dd/mm/yyyy" : formatDobDisplay(s.dob)}</span><span class="status-caret">▾</span>`;
}

function buildDobCalendarDays(year, month) {
  const firstWeekday = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const daysInThisMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const daysInPrevMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prevY = month === 0 ? year - 1 : year, prevM = month === 0 ? 11 : month - 1;
  const nextY = month === 11 ? year + 1 : year, nextM = month === 11 ? 0 : month + 1;
  const cells = [];
  for (let i = 0; i < firstWeekday; i++) {
    cells.push({ y: prevY, m: prevM, day: daysInPrevMonth - firstWeekday + i + 1, otherMonth: true });
  }
  for (let d = 1; d <= daysInThisMonth; d++) cells.push({ y: year, m: month, day: d, otherMonth: false });
  let nextDay = 1;
  while (cells.length < 42) cells.push({ y: nextY, m: nextM, day: nextDay++, otherMonth: true });
  return cells;
}

function renderDobMonthOptions(chatId, query) {
  const { month } = state[chatId].dobView;
  const q = (query || "").trim().toLowerCase();
  const filtered = DOB_MONTH_NAMES.map((name, i) => ({ name, i })).filter(({ name }) => !q || name.toLowerCase().includes(q));
  if (!filtered.length) return `<div class="inquiry-option-empty">No matching month</div>`;
  return filtered.map(({ name, i }) => {
    const active = i === month;
    return `
    <button type="button" class="dob-cal-jump-option ${active ? "active" : ""}" data-action="selectDobMonthValue" data-chat="${chatId}" data-value="${i}">${name}</button>`;
  }).join("");
}

function renderDobYearOptions(chatId, query) {
  const { year } = state[chatId].dobView;
  const q = (query || "").trim();
  const filtered = dobYearOptions(year).filter((y) => !q || String(y).includes(q));
  if (!filtered.length) return `<div class="inquiry-option-empty">No matching year</div>`;
  return filtered.map((y) => {
    const active = y === year;
    return `
    <button type="button" class="dob-cal-jump-option ${active ? "active" : ""}" data-action="selectDobYearValue" data-chat="${chatId}" data-value="${y}">${y}</button>`;
  }).join("");
}

function renderDobMonthDropdown(chatId) {
  return `
    <input type="text" class="dob-cal-month-search" placeholder="Search month…" autocomplete="off" />
    <div class="dob-cal-month-options">${renderDobMonthOptions(chatId, "")}</div>
  `;
}

function renderDobYearDropdown(chatId) {
  return `
    <input type="text" class="dob-cal-year-search" placeholder="Search year…" autocomplete="off" />
    <div class="dob-cal-year-options">${renderDobYearOptions(chatId, "")}</div>
  `;
}

function renderDobCalendar(chatId) {
  const s = state[chatId];
  const today = new Date();
  const todayY = today.getFullYear(), todayM = today.getMonth(), todayD = today.getDate();
  if (!s.dobView) {
    if (s.dob) {
      const [y, m] = s.dob.split("-").map(Number);
      s.dobView = { year: y, month: m - 1 };
    } else {
      s.dobView = { year: todayY, month: todayM };
    }
  }
  const { year, month } = s.dobView;
  const cells = buildDobCalendarDays(year, month);
  const rows = [];
  for (let r = 0; r < 6; r++) rows.push(cells.slice(r * 7, r * 7 + 7));
  return `
    <div class="dob-cal-header">
      <button type="button" class="dob-cal-nav" data-action="dobNavMonth" data-chat="${chatId}" data-dir="-1" title="Previous month">‹</button>
      <div class="dob-cal-jump-picker">
        <button type="button" class="dob-cal-jump-display" data-action="toggleDobMonthDropdown" data-chat="${chatId}">${DOB_MONTH_NAMES[month]}</button>
        <div class="dob-cal-month-dropdown dob-cal-jump-dropdown hidden">${renderDobMonthDropdown(chatId)}</div>
      </div>
      <div class="dob-cal-jump-picker">
        <button type="button" class="dob-cal-jump-display" data-action="toggleDobYearDropdown" data-chat="${chatId}">${year}</button>
        <div class="dob-cal-year-dropdown dob-cal-jump-dropdown hidden">${renderDobYearDropdown(chatId)}</div>
      </div>
      <button type="button" class="dob-cal-nav" data-action="dobNavMonth" data-chat="${chatId}" data-dir="1" title="Next month">›</button>
    </div>
    <div class="dob-cal-weekdays">${DOB_WEEKDAY_LABELS.map((w) => `<span>${w}</span>`).join("")}</div>
    <div class="dob-cal-grid">${rows.map((row) => row.map((cell) => {
      const key = dobKey(cell.y, cell.m, cell.day);
      const isToday = cell.y === todayY && cell.m === todayM && cell.day === todayD;
      const isSelected = s.dob === key;
      return `<button type="button" class="dob-cal-day ${cell.otherMonth ? "other-month" : ""} ${isToday ? "today" : ""} ${isSelected ? "selected" : ""}" data-action="selectDobDay" data-chat="${chatId}" data-value="${key}">${cell.day}</button>`;
    }).join("")).join("")}</div>
    <div class="dob-cal-footer">
      <button type="button" class="dob-cal-link" data-action="dobClear" data-chat="${chatId}">Clear</button>
      <button type="button" class="dob-cal-link" data-action="dobToday" data-chat="${chatId}">Today</button>
    </div>
  `;
}

const COPY_ICON_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"></path></svg>`;

function renderPlayerInfo(chatId) {
  const s = state[chatId];
  const parts = [];
  if (s.lastUsernameLoading) {
    parts.push(`<span><span class="pi-label">Last username recorded</span> Checking…</span>`);
  } else if (s.lastUsernameChecked) {
    parts.push(s.lastUsernameFound
      ? `<span><span class="pi-label">Last username recorded</span> ${s.lastUsernameValue}</span>`
      : `<span><span class="pi-label">Last username recorded</span> : N/A</span>`);
  }
  if (s.matchedRow) {
    if (s.matchedRow.customerName) {
      parts.push(`<span class="player-name-line"><span><span class="pi-label">Name</span> ${escapeHtml(s.matchedRow.customerName)}</span><button type="button" class="player-name-copy" data-action="copyPlayerName" data-chat="${escapeHtml(chatId)}" title="Copy full name" aria-label="Copy full name">${COPY_ICON_SVG}</button></span>`);
    }
    const tier = String(s.matchedRow.tier || "—").trim();
    const tierDisplay = tier === "—" || /^tier\b/i.test(tier) ? tier : `Tier ${tier}`;
    parts.push(`<span>${escapeHtml(tierDisplay)}</span>`);
    if (s.forcedVipFor && !s.matchedRow.tier) {
      parts.push(`<span><span class="pi-label">Note</span> Not on the VIP list yet — force looked up</span>`);
    }
  }
  return parts.length ? `<div class="player-info">${parts.join("")}</div>` : "";
}

async function copyPlainText(value) {
  const text = String(value || "");
  if (!text) throw new Error("Nothing to copy");
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (_) { }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Copy was blocked by the browser");
}

const CASE_CONTENT_KEYS = [
  "inquiry", "status", "releasedBonusAmount", "releasedAmountRaw", "claimSecret",
  "dob", "telegram", "claimedPrograms", "gracePeriodActivated",
  "vs96FeedbackQuery1", "vs96FeedbackQuery2", "riskReloadAmount",
  "halloweenChoice", "halloweenDeposit", "halloweenShared", "halloweenMethod", "halloweenPostLink", "halloweenClaim",
];
const CASE_KEYS = [
  ...CASE_CONTENT_KEYS,
  "caseNo", "caRecordId", "matchedRow", "otherBrandMatches", "claimSecretManual",
  "logged", "autoRecordError", "loggedSnapshot", "caLinkSaved", "caOwner",
  "claimTickets",
];

function ownsCaseRecord(s) {
  return !s.caOwner || s.caOwner === selectedAgent;
}

function agentActed(s) {
  if (!s) return false;
  return !!(s.caRecordId || (s.inquiry && s.inquiry.length) || s.status || String(s.usernameDraft || "").trim()
    || (s.logs && s.logs.length) || Object.values(s.claimedPrograms || {}).some(Boolean));
}
function agentTouchedChat(s) {
  return agentActed(s) || (!!s && (s.agentWrote === true || s.agentWrote === "unsure"));
}
function caseNeverLookedUp(s) {
  return !!s && !s.username && !s.caRecordId;
}
const caseOriginLogged = new Set();
function logCaseOrigin(chatId, how) {
  const s = state[chatId];
  const key = `${chatId}:${how}`;
  if (!s || caseOriginLogged.has(key)) return;
  caseOriginLogged.add(key);
  logDiagnostic(`Chat ${chatId}: ${how} (player: ${s.username || "none"}, Lark record: ${s.caRecordId ? "yes" : "no"}, agent: ${selectedAgent || "none"}).`, "info");
}
const addingCaseFor = new Set();

function caseContentJson(s) {
  const o = {};
  for (const k of CASE_CONTENT_KEYS) o[k] = s[k] === undefined ? null : s[k];
  return JSON.stringify(o);
}
function markCaseRecorded(s) { s.loggedSnapshot = caseContentJson(s); }
function isCaseDirty(s) {
  return !!s.logged && !!s.loggedSnapshot && caseContentJson(s) !== s.loggedSnapshot;
}
function isCaseEmpty(s) {
  return !s.logged && !(s.inquiry || []).length && !s.status
    && !Object.values(s.claimedPrograms || {}).some(Boolean) && !s.gracePeriodActivated;
}
function snapshotCase(s) {
  const o = {};
  for (const k of CASE_KEYS) if (s[k] !== undefined) o[k] = JSON.parse(JSON.stringify(s[k]));
  return o;
}
function loadCaseInto(s, snap) {
  s.vs96FeedbackQuery1 = "";
  s.vs96FeedbackQuery2 = "";
  s.riskReloadAmount = ""; resetHalloweenInput(s);
  s.claimTickets = {};
  for (const k of CASE_KEYS) if (snap[k] !== undefined) s[k] = JSON.parse(JSON.stringify(snap[k]));
}
function usedProgramsInOtherCases(s) {
  const used = new Set();
  for (const c of (s.logs || [])) {
    for (const [k, v] of Object.entries(c.claimedPrograms || {})) if (v) used.add(k);
    for (const key of Object.keys(claimedProgramsFromSavedCase(c))) used.add(key);
  }
  return used;
}
function caseAmountText(c) {
  const raw = String(c.releasedAmountRaw || c.releasedBonusAmount || "").trim();
  const rm = raw.match(/RM\s*-?\d+(?:\.\d+)?/i);
  if (rm) return rm[0].replace(/\s+/g, "");
  return /^-?\d+(?:\.\d+)?$/.test(raw) ? "RM" + raw : "";
}
function caseSummaryText(c) {
  const parts = [(c.inquiry || []).join(" + ") || "no inquiry", c.status || "no status"];
  const amt = caseAmountText(c);
  if (amt) parts.push(amt);
  return parts.join(" · ");
}

function renderCasesBar(chatId) {
  if (previewMode) return "";
  const s = state[chatId];
  if (!s || s.isUnknown) return "";
  const logs = (s.logs || []).slice().sort((a, b) => (a.caseNo || 0) - (b.caseNo || 0));
  if (!s.caRecordId && !logs.length) return "";
  const busy = addingCaseFor.has(chatId) || s.lookupInFlight;
  const dirty = isCaseDirty(s);
  const rows = logs.map((c) => `
    <div class="case-row">
      <span class="case-tag">Case ${c.caseNo}</span>
      <span class="case-summary">${caseSummaryText(c)}</span>
      <button type="button" class="case-edit-btn" data-action="editCase" data-case="${c.caseNo}" data-chat="${chatId}" ${busy ? "disabled" : ""}>Edit</button>
    </div>`).join("");
  const current = logs.length ? `
    <div class="case-row current">
      <span class="case-tag">Case ${s.caseNo || 1} · open</span>
      <span class="case-summary">${caseSummaryText(s)}</span>
    </div>` : "";
  return `
    <div class="cases-bar">
      ${logs.length ? `<label class="field-label">Cases in this chat</label>${rows}${current}` : ""}
      <div class="cases-actions">
        ${dirty ? `<button type="button" class="save-case-btn" data-action="saveCase" data-chat="${chatId}" ${busy ? "disabled" : ""}>Save changes</button>` : ""}
        <button type="button" class="add-case-btn" data-action="addCase" data-chat="${chatId}" ${busy || !s.caRecordId ? "disabled" : ""} title="Record this case, then start another one for the same customer">+ Log another case</button>
      </div>
    </div>`;
}

async function ensureActiveCaseSaved(chatId) {
  const s = state[chatId];
  if (s.logged && !isCaseDirty(s)) return true;
  if (s.logged) return resyncLoggedRecord(chatId);
  await submitRecord(chatId, { auto: false });
  return !!s.logged;
}

async function addCaseFlow(chatId) {
  const s = state[chatId];
  if (!s || addingCaseFor.has(chatId) || s.lookupInFlight) return;
  if (!s.username || !s.caRecordId || !s.brand || s.isUnknown) {
    setStatus("Look up the username first.", "error");
    return;
  }
  if (!selectedAgent) { openSettingsPanel(); return; }
  addingCaseFor.add(chatId);
  renderChats(activeChats);
  try {
    if (!(await ensureActiveCaseSaved(chatId))) return;
    const chatDef = activeChats.find((c) => c.chatId === chatId);
    const { row, otherBrands, caRecordId } = await fetchBonusRow(
      s.username, s.brand, s.chatUrl || (chatDef && chatDef.link) || "", !!s.telegram, selectedAgent, null
    );
    s.logs = s.logs || [];
    s.logs.push(snapshotCase(s));
    const nextNo = Math.max(s.caseNo || 1, ...s.logs.map((c) => c.caseNo || 0)) + 1;
    s.caseNo = nextNo;
    s.caRecordId = caRecordId;
    s.caOwner = selectedAgent;
    s.caLinkSaved = !!(s.chatUrl || (chatDef && chatDef.link));
    s.matchedRow = row;
    s.otherBrandMatches = otherBrands;
    s.claimedPrograms = {};
    s.claimTickets = {};
    s.gracePeriodActivated = false;
    s.vs96FeedbackQuery1 = "";
    s.vs96FeedbackQuery2 = "";
    s.riskReloadAmount = ""; resetHalloweenInput(s);
    s.inquiry = [];
    s.status = "";
    s.releasedBonusAmount = "";
    s.releasedAmountRaw = "";
    s.claimSecret = false;
    s.claimSecretManual = false;
    s.logged = false;
    s.autoRecordError = "";
    s.loggedSnapshot = "";
    setStatus(`Case ${nextNo} started — fill in its inquiry and status.`, "success");
    if (s.chatOpen && activeChats[0] && activeChats[0].chatId === chatId) startChatStatusPolling(chatId);
  } catch (err) {
    setStatus("Couldn't start another case: " + err.message, "error");
  } finally {
    addingCaseFor.delete(chatId);
    renderChats(activeChats);
    saveState();
  }
}

async function editCaseFlow(chatId, caseNo) {
  const s = state[chatId];
  if (!s || addingCaseFor.has(chatId)) return;
  if (!(s.logs || []).some((c) => c.caseNo === caseNo)) return;
  addingCaseFor.add(chatId);
  renderChats(activeChats);
  try {
    if (isCaseEmpty(s)) {
      if (s.caRecordId) {
        rememberDeletedRecord(s.caRecordId);
        fetch("/lark-delete-record", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recordId: s.caRecordId, agentName: selectedAgent }),
        }).catch(() => { });
      }
    } else {
      if (!(await ensureActiveCaseSaved(chatId))) return;
      s.logs.push(snapshotCase(s));
    }
    const i = s.logs.findIndex((c) => c.caseNo === caseNo);
    const [target] = s.logs.splice(i, 1);
    loadCaseInto(s, target);
    s.logged = true;
    markCaseRecorded(s);
    setStatus(`Editing case ${s.caseNo}. Click "Save changes" when you're done.`);
  } catch (err) {
    setStatus("Couldn't open that case: " + err.message, "error");
  } finally {
    addingCaseFor.delete(chatId);
    renderChats(activeChats);
    saveState();
  }
}

// ---- Halloween "Trick or Treat" card -------------------------------------------------------
// The server decides the day, the tier and what is allowed (row.halloween). The card only collects input.
const HALLOWEEN_INQUIRY_PREFIX = "Halloween Day ";
const HALLOWEEN_METHODS = ["Social post", "5 friends"];

function resetHalloweenInput(s) {
  s.halloweenChoice = "";
  s.halloweenDeposit = "";
  s.halloweenShared = false;
  s.halloweenMethod = "";
  s.halloweenPostLink = "";
  s.halloweenClaim = null;
}

function halloweenActionable(h) {
  return !!h && (h.state === "day1" || h.state === "day2" || h.state === "day3");
}

// What the agent has entered so far and what it would pay. Mirrors the server rules; the server re-checks everything.
function halloweenInput(s, h) {
  const result = { valid: false, amount: 0, error: "", sub: "", next: "" };
  if (!halloweenActionable(h)) return result;
  if (h.state === "day1") {
    const raw = String(s.halloweenDeposit || "").replace(/,/g, "").trim();
    const deposit = Number(raw);
    const table = Array.isArray(h.table) ? h.table : [];
    if (!s.halloweenChoice) { result.error = "Pick TRICK or TREAT first."; return result; }
    if (!raw || !Number.isFinite(deposit) || deposit <= 0) { result.error = "Enter the customer's Day 1 deposit."; return result; }
    const row = table.find((item) => deposit >= item.min);
    if (!row) { result.error = "A deposit below RM50 does not qualify."; return result; }
    result.valid = true;
    result.amount = s.halloweenChoice === "TRICK" ? row.trick : row.treat;
    result.sub = `${s.halloweenChoice} · RM${row.min} row · x3 turnover`;
    result.next = deposit >= 300
      ? `Unlocks Day 2 and Day 3: RM${h.redPacket} each, or RM${h.redPacket + h.shareExtra} if the player shares.`
      : "Below RM300: Day 1 bonus only, no Day 2 or Day 3.";
    return result;
  }
  const sharing = h.state === "day2" ? !!s.halloweenShared : !!s.halloweenShared && !!h.canShare;
  const method = h.state === "day3" ? h.shareMethod : s.halloweenMethod;
  if (sharing && h.state === "day2") {
    if (!method) { result.error = "Choose how the player shared."; return result; }
    if (method === "Social post" && !String(s.halloweenPostLink || "").trim()) { result.error = "Enter the link of the player's post."; return result; }
  }
  result.valid = true;
  result.amount = h.redPacket + (sharing ? h.shareExtra : 0);
  result.sub = sharing ? `RM${h.redPacket} red packet + RM${h.shareExtra} share extra · x3 turnover` : `RM${h.redPacket} red packet · x3 turnover`;
  result.next = h.state === "day2" ? "Sharing today is also needed for the Day 3 share extra." : "";
  return result;
}

function halloweenChip(chatId, field, value, label, active) {
  return `<button type="button" class="hw-chip ${active ? "on" : ""}" data-action="halloweenPick" data-chat="${chatId}" data-field="${field}" data-value="${escapeHtml(value)}">${escapeHtml(label)}</button>`;
}

function renderHalloweenCard(chatId) {
  const s = state[chatId];
  const h = s.matchedRow?.halloween;
  if (!h) return "";
  const claimed = !!s.claimedPrograms.halloween;
  const otherClaimed = Object.entries(s.claimedPrograms || {}).some(([key, active]) => key !== "halloween" && active);
  const title = `<div class="ticket-name">Halloween · Trick or Treat</div>`;
  const wrap = (inner, extraClass = "") => `
    <div class="ticket bonus-tone-orange ticket-halloween ${extraClass}">
      <div class="ticket-main">
        <div class="ticket-icon" aria-hidden="true">🎃</div>
        <div class="ticket-body">${inner}</div>
      </div>
    </div>`;
  const subLine = h.day ? `Day ${h.day} of 3 · ${escapeHtml(h.fullBrand || "")} · ${escapeHtml(h.tier || "")}` : "";

  if (!claimed && !halloweenActionable(h)) {
    return wrap(`${title}<div class="ticket-meta">${subLine}</div><div class="hw-note ${h.state === "done" ? "ok" : ""}">${escapeHtml(h.message || "")}</div>`, "locked");
  }

  const history = h.state === "day1" ? "" : `
    <div class="hw-history">
      <div><span>Day 1</span><span>${escapeHtml(h.choice || "")} · RM${escapeHtml(String(h.day1Deposit || 0))} → RM${escapeHtml(String(h.day1Bonus || 0))}</span></div>
      ${h.state === "day3" ? `<div><span>Day 2</span><span>RM${escapeHtml(String(h.day2Total || 0))}${h.day2Shared ? ` · shared (${escapeHtml(h.shareMethod || "")})` : " · not shared"}</span></div>` : ""}
    </div>`;

  if (claimed) {
    const info = s.halloweenClaim || {};
    const day = info.day || h.day;
    const amount = info.amount ?? String(s.releasedBonusAmount || "").split(" | ")[0];
    return `
    <div class="ticket bonus-tone-orange ticket-halloween">
      <div class="ticket-main">
        <div class="ticket-icon" aria-hidden="true">🎃</div>
        <div class="ticket-body">${title}<div class="ticket-meta">Day ${escapeHtml(String(day))} claimed${amount ? ` · RM${escapeHtml(String(amount))}` : ""}</div></div>
      </div>
      <div class="ticket-btns"><button class="claim-btn claimed" data-action="unclaim" data-program="halloween" data-chat="${chatId}" title="Click again to unclaim">✓ Claimed</button></div>
    </div>`;
  }

  const input = halloweenInput(s, h);
  let controls = "";
  if (h.state === "day1") {
    controls = `
      <div class="hw-label">Player's choice (once per campaign)</div>
      <div class="hw-chips">${["TRICK", "TREAT"].map((value) => halloweenChip(chatId, "choice", value, value, s.halloweenChoice === value)).join("")}</div>
      <label class="hw-field"><span>Customer deposit (RM)</span>
        <input type="text" inputmode="decimal" class="hw-deposit" data-chat="${chatId}" placeholder="Enter deposit amount" value="${escapeHtml(s.halloweenDeposit || "")}" />
      </label>`;
  } else if (h.state === "day2") {
    controls = `
      <div class="hw-label">Did the player share today?</div>
      <div class="hw-chips">${halloweenChip(chatId, "shared", "no", "Not shared", !s.halloweenShared)}${halloweenChip(chatId, "shared", "yes", "Shared", !!s.halloweenShared)}</div>
      ${s.halloweenShared ? `
        <div class="hw-label">How did they share?</div>
        <div class="hw-chips">${HALLOWEEN_METHODS.map((value) => halloweenChip(chatId, "method", value, value === "Social post" ? "Social post" : "5 friends", s.halloweenMethod === value)).join("")}</div>
        ${s.halloweenMethod === "Social post" ? `<input type="text" class="hw-link" data-chat="${chatId}" placeholder="Link of the player's post" value="${escapeHtml(s.halloweenPostLink || "")}" />` : ""}
        ${s.halloweenMethod === "5 friends" ? `<div class="hw-hint">Check the screenshot shows the image sent to 5 different friends today.</div>` : ""}` : ""}`;
  } else if (h.state === "day3") {
    const safeLink = /^https?:\/\//i.test(h.postLink || "") ? h.postLink : "";
    controls = h.canShare ? `
      <div class="hw-label">Did the player share again today?</div>
      <div class="hw-chips">${halloweenChip(chatId, "shared", "no", "Not shared", !s.halloweenShared)}${halloweenChip(chatId, "shared", "yes", "Shared", !!s.halloweenShared)}</div>
      ${s.halloweenShared ? (h.shareMethod === "Social post"
        ? `<div class="hw-hint">Same post as Day 2 must still be live${safeLink ? `: <a href="${escapeHtml(safeLink)}" target="_blank" rel="noopener">open the post</a>` : ""}</div>`
        : `<div class="hw-hint">Check the screenshot shows the image sent to 5 different friends today.</div>`) : ""}`
      : `<div class="hw-hint">No share extra today: the player did not share on Day 2. Base red packet only.</div>`;
  }

  const disabled = otherClaimed || !input.valid;
  const title2 = otherClaimed ? "Another bonus is already claimed on this chat" : (input.valid ? "" : input.error);
  return `
    <div class="ticket bonus-tone-orange ticket-halloween hw-active ${otherClaimed ? "locked" : ""}">
      <div class="ticket-main">
        <div class="ticket-icon" aria-hidden="true">🎃</div>
        <div class="ticket-body">${title}<div class="ticket-meta">${subLine}</div></div>
      </div>
      <div class="hw-body">
        ${history}
        ${controls}
        <div class="hw-preview ${input.valid ? "ready" : ""}">
          <span>Claim amount</span>
          <strong class="hw-amount">${input.valid ? `RM${input.amount}` : "—"}</strong>
          <small class="hw-sub">${escapeHtml(input.valid ? input.sub : input.error)}</small>
        </div>
        <div class="hw-note hw-next">${escapeHtml(input.next)}</div>
      </div>
      <div class="ticket-btns">
        <button class="claim-btn hw-claim" data-action="claim" data-program="halloween" data-chat="${chatId}" ${title2 ? `title="${escapeHtml(title2)}"` : ""} ${disabled ? "disabled" : ""}>Claim Day ${h.day}</button>
      </div>
      <div class="hw-hint">${previewMode ? "Admin preview: no ticket is raised and nothing is saved." : "Claiming raises a VVIP Complain Players ticket."}</div>
    </div>`;
}

// Refresh the amount line and the Claim button while the agent types, without redrawing the inputs.
function patchHalloweenCard(chatId, scope) {
  const s = state[chatId];
  const h = s?.matchedRow?.halloween;
  const ticket = scope?.closest(".ticket-halloween");
  if (!h || !ticket) return;
  const input = halloweenInput(s, h);
  const otherClaimed = Object.entries(s.claimedPrograms || {}).some(([key, active]) => key !== "halloween" && active);
  ticket.querySelector(".hw-preview")?.classList.toggle("ready", input.valid);
  const amount = ticket.querySelector(".hw-amount");
  if (amount) amount.textContent = input.valid ? `RM${input.amount}` : "—";
  const sub = ticket.querySelector(".hw-sub");
  if (sub) sub.textContent = input.valid ? input.sub : input.error;
  const next = ticket.querySelector(".hw-next");
  if (next) next.textContent = input.next;
  const button = ticket.querySelector(".hw-claim");
  if (button) {
    button.disabled = otherClaimed || !input.valid;
    button.title = otherClaimed ? "Another bonus is already claimed on this chat" : (input.valid ? "" : input.error);
  }
}

function halloweenDayClaimed(s) {
  for (const inquiry of s.inquiry || []) {
    if (String(inquiry).startsWith(HALLOWEEN_INQUIRY_PREFIX)) return Number(String(inquiry).slice(HALLOWEEN_INQUIRY_PREFIX.length)) || 0;
  }
  return s.halloweenClaim?.day || 0;
}

async function claimHalloween(chatId, btn, card) {
  const s = state[chatId];
  const h = s?.matchedRow?.halloween;
  if (!s || !halloweenActionable(h)) return;
  const input = halloweenInput(s, h);
  if (!input.valid) { setStatus(input.error, "error"); return; }
  const inquiry = `${HALLOWEEN_INQUIRY_PREFIX}${h.day}`;
  if (!inquiryOptions.includes(inquiry)) {
    setStatus(`Add "${inquiry}" to the Inquiry options in the Customer Approaching table first. Nothing was claimed.`, "error");
    return;
  }
  if (!s.brand || !s.username) { setStatus("Look up the player first. Nothing was claimed.", "error"); return; }

  const chatDef = activeChats.find((c) => c.chatId === chatId);
  const claimBody = (preview) => JSON.stringify({
    action: "claim", preview, day: h.day, username: s.username, brand: s.brand,
    choice: s.halloweenChoice, deposit: s.halloweenDeposit,
    shared: h.state === "day2" ? !!s.halloweenShared : !!s.halloweenShared && !!h.canShare,
    shareMethod: s.halloweenMethod, postLink: s.halloweenPostLink,
    agentName: selectedAgent, chatLink: s.chatUrl || chatDef?.link || "",
  });
  const postClaim = async (preview) => (await fetch("/halloween-claim", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: claimBody(preview),
  })).json();

  if (!previewMode) {
    // Check every rule first, so a claim the server would refuse never leaves a ticket behind.
    let verdict;
    try { verdict = await postClaim(true); } catch (err) { verdict = { ok: false, error: err.message }; }
    if (!verdict.ok) { setStatus(`${verdict.error || "The claim could not be checked."} Nothing was claimed.`, "error"); return; }
    if (Number(verdict.amount) !== Number(input.amount)) {
      setStatus(`This claim is now RM${verdict.amount}, not RM${input.amount} (the player's tier or the day changed). Look up the player again. Nothing was claimed.`, "error");
      return;
    }
    if (!(await raiseClaimTicket(chatId, "halloween", input.amount))) return;
  }
  card = chatListEl.querySelector(`.chat-card[data-chat-id="${chatId}"]`) || card;
  btn = card.querySelector(".hw-claim") || btn;

  btn.disabled = true;
  btn.textContent = "…";
  claimWriteInFlight.add(chatId);
  let data;
  try {
    data = await postClaim(previewMode);
    if (!data.ok) throw new Error(data.error || "Claim failed");
  } catch (err) {
    setStatus(`Halloween claim failed: ${err.message}. If a ticket was already raised for it, check that ticket before claiming again.`, "error");
    btn.disabled = false;
    btn.textContent = `Claim Day ${h.day}`;
    return;
  } finally {
    claimWriteInFlight.delete(chatId);
  }

  const amount = String(data.amount);
  s.claimedPrograms.halloween = true;
  s.halloweenClaim = { day: h.day, amount: data.amount };
  logCaseOrigin(chatId, `halloween day ${h.day} claimed`);
  s.releasedBonusAmount = amount;
  s.releasedAmountRaw = amount;
  if (!s.claimSecretManual) s.claimSecret = true;
  if (!s.escalation.amount) s.escalation.amount = amount;
  s.inquiry = [inquiry];
  s.status = "Given";
  reportClaim(chatId, { program: "halloween", label: `Halloween Day ${h.day}`, source: s.halloweenChoice || "", inquiry, amount });

  card.querySelector(".ticket-slot").innerHTML = renderTickets(chatId);
  card.querySelector(".auto-fields-slot").innerHTML = renderAutoFields(chatId);
  refreshInquiryChips(card, chatId);
  card.querySelector(".inquiry-dropdown").innerHTML = renderInquiryDropdown(chatId, "");
  refreshStatusChip(card, chatId);
  card.querySelector(".status-dropdown").innerHTML = renderStatusDropdown(chatId);

  if (!previewMode) {
    await submitRecord(chatId, { auto: true, reason: `${inquiry} claimed` });
    if (h.day === 1) await addHalloweenActionNote(chatId, data);
  } else {
    setStatus("Preview claim checked against Lark. Nothing was saved.", "success");
  }
}

// After a real Day 1 claim: write an Action log note saying whether the player can claim Day 2 and Day 3.
// The claim is already saved, so a failed note only shows a warning and never undoes anything.
async function addHalloweenActionNote(chatId, claim) {
  const s = state[chatId];
  if (!s || consoleNoteBlocker(s)) return;
  const eligible = claim.track === "RM300+";
  const deposit = claim.deposit ?? s.halloweenDeposit;
  const note = eligible
    ? `Halloween Day 1: deposited RM${deposit} (RM300 or more), eligible for Day 2 and Day 3.`
    : `Halloween Day 1: deposited RM${deposit} (below RM300), not eligible for Day 2 and Day 3.`;
  const answer = await postConsoleNote(s, { note, type: "action" });
  if (answer && answer.ok && answer.saved) {
    noteUi(chatId).notes = null;
    paintNoteSection(chatId);
    setStatus("Halloween Day 1 claimed. Action log note added.", "success");
  } else {
    setStatus(`Halloween Day 1 is claimed, but the Action log note was not saved: ${(answer && answer.error) || "unknown problem"} Add it by hand.`, "error");
  }
}

// Undo the Halloween table side of a claim. Throws if the server refuses, so the unclaim stops.
async function undoHalloween(chatId) {
  const s = state[chatId];
  const day = halloweenDayClaimed(s);
  if (!day) return;
  const res = await fetch("/halloween-claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "unclaim", preview: previewMode, day, username: s.username, brand: s.brand }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "The Halloween row could not be reverted");
  s.halloweenClaim = null;
  s.halloweenChoice = "";
  s.halloweenDeposit = "";
  s.halloweenShared = false;
  s.halloweenMethod = "";
  s.halloweenPostLink = "";
}

function renderTickets(chatId) {

  const s = state[chatId];
  if (s.matchedRow === undefined) {
    return `<div class="ticket empty">Enter a username and press Look up to check bonuses</div>`;
  }
  if (s.matchedRow === null) {
    const hint = s.otherBrandMatches && s.otherBrandMatches.length
      ? ` (found under ${s.otherBrandMatches.join(", ")} instead — wrong chat/brand?)`
      : "";
    return `<div class="ticket empty">No record found for this username under this brand${hint}</div>`;
  }
  const r = s.matchedRow;

  const defs = [];
  const usedElsewhere = usedProgramsInOtherCases(s);

  allBonusPrograms().forEach((p) => {
    if (usedElsewhere.has(p.key)) return;
    if (!isClaimableValue(r[p.key])) return;
    const def = { key: p.key, kind: "regular", label: p.label, display: r[p.key] };
    if (p.key === "vs96Feedback") def.requiresFeedback = true;
    if (p.key === "gracePeriod") {
      const isPass = /^\s*pass\b/i.test(r.gracePeriod);
      def.claimLabel = isPass ? "Activate" : "Claim";
      def.doneLabel = isPass ? "✓ Activated" : "✓ Claimed";
      def.done = isPass ? !!s.gracePeriodActivated : !!s.claimedPrograms.gracePeriod;
      def.excludeFromLock = isPass;
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      def.reactivatable = typeof r.graceExpiryMs === "number" && r.graceExpiryMs >= startOfToday.getTime();
    }
    if (p.key === "riskPlayer" && typeof r.riskExpiryMs === "number") {
      def.expiryMs = r.riskExpiryMs;
    }
    defs.push(def);
  });

  if (r.telegram28 && !usedElsewhere.has("telegram28") && !isHiddenStatus(r.telegram28.status)) {
    defs.push({ key: "telegram28", kind: "special", label: "Telegram RM28", display: r.telegram28.status });
  }

  if (r.redeemCode && !usedElsewhere.has("redeemCode") && !isHiddenStatus(r.redeemCode.status)) {
    defs.push({ key: "redeemCode", kind: "special", label: "Redeem Code", display: r.redeemCode.status, isCode: true });
  }

  if (r.specialReload && !usedElsewhere.has("specialReload")) {
    defs.push({ key: "specialReload", kind: "special", label: "Special Reload (Ang Pao)", display: r.specialReload.status });
  }

  if (!defs.length && !r.halloween) {
    return `<div class="ticket empty">No active bonuses for this player right now</div>`;
  }

  const alreadyClaimedOne = Object.values(s.claimedPrograms).some(Boolean);
  return `<div class="ticket-stack">` + renderHalloweenCard(chatId) + defs.map((d) => {
    const claimed = d.key === "gracePeriod" ? !!d.done : !!s.claimedPrograms[d.key];
    const locked = d.excludeFromLock ? false : (alreadyClaimedOne && !claimed);
    const feedbackComplete = !d.requiresFeedback || !!(
      String(s.vs96FeedbackQuery1 || "").trim() && String(s.vs96FeedbackQuery2 || "").trim()
    );
    const riskCalculation = d.key === "riskPlayer" ? riskPlayerCalculation(d.display, s.riskReloadAmount) : null;
    const riskComplete = !riskCalculation || riskCalculation.valid;
    const claimDisabled = !claimed && (locked || !feedbackComplete || !riskComplete);
    const claimLabel = d.claimLabel || "Claim";
    const doneLabel = d.doneLabel || "✓ Claimed";
    const cardMark = BONUS_CARD_MARKS[d.key] || escapeHtml(String(d.label || "•").trim().slice(0, 1).toUpperCase());
    return `
    <div class="ticket bonus-tone-${bonusCardTone(d.key)} ${d.kind === "special" ? "ticket-special" : ""} ${locked ? "locked" : ""} ${d.reactivatable ? "ticket-has-reactivate" : ""} ${d.requiresFeedback ? "ticket-vs96" : ""} ${d.key === "riskPlayer" ? "ticket-risk-player" : ""} ${feedbackComplete ? "feedback-complete" : ""}">
      <div class="ticket-main">
        <div class="ticket-icon" aria-hidden="true">${cardMark}</div>
        <div class="ticket-body">
          <div class="ticket-name">${d.label}</div>
          <div class="ticket-meta ${d.isCode ? "mono code" : ""}">${d.isCode ? escapeHtml(d.display) : formatTicketMeta(d.display)}</div>
          ${renderExpiryLine(d.expiryMs)}
        </div>
      </div>
      <div class="ticket-btns">
        <button class="claim-btn ${d.kind === "special" ? "special" : ""} ${claimed ? "claimed" : ""}" data-action="${claimed ? "unclaim" : "claim"}" data-program="${d.key}" data-chat="${chatId}" ${claimed ? 'title="Click again to unclaim"' : (!feedbackComplete ? 'title="Fill in both player feedback answers first"' : (!riskComplete ? 'title="Enter the customer reload amount first"' : ""))} ${claimDisabled ? "disabled" : ""}>
          ${claimed ? doneLabel : claimLabel}
        </button>
        ${
          d.reactivatable
            ? `<button class="claim-btn reactivate-btn" data-action="reactivateGracePeriod" data-chat="${chatId}" ${locked ? "disabled" : ""} title="Customer didn't complete the challenge — give them another attempt today">Reactivate</button>`
            : ""
        }
      </div>
      ${riskCalculation ? `
        <div class="risk-amount-fields">
          <label>
            <span>Customer reload (RM)</span>
            <input type="text" inputmode="decimal" class="risk-reload-input" data-chat="${chatId}" placeholder="Enter reload amount" value="${escapeHtml(s.riskReloadAmount || "")}" ${claimed ? "disabled" : ""} />
          </label>
          <div class="risk-claim-preview ${riskCalculation.valid ? "ready" : ""}">
            <span>Claim amount</span>
            <strong class="risk-claim-value">${riskCalculation.valid ? `RM${riskCalculation.formattedClaim}` : "—"}</strong>
            <small>${riskCalculation.percentage ? `${riskCalculation.percentage}% · Max RM${riskCalculation.cap}` : "Percentage unavailable"}</small>
          </div>
        </div>` : ""}
      ${d.requiresFeedback ? `
        <div class="vs96-feedback-fields">
          <label><span>Q1</span><textarea class="vs96-feedback-input" data-feedback="query1" data-chat="${chatId}" placeholder="Enter the player's first feedback…" ${claimed ? "disabled" : ""}>${escapeHtml(s.vs96FeedbackQuery1 || "")}</textarea></label>
          <label><span>Q2</span><textarea class="vs96-feedback-input" data-feedback="query2" data-chat="${chatId}" placeholder="Enter the player's second feedback…" ${claimed ? "disabled" : ""}>${escapeHtml(s.vs96FeedbackQuery2 || "")}</textarea></label>
          <div class="vs96-feedback-note">${feedbackComplete ? "✓ Both feedback answers collected" : "Fill in both feedback answers before claiming."}</div>
        </div>` : ""}
    </div>`;
  }).join("") + `</div>` + (alreadyClaimedOne ? `<div class="ticket-note">Only 1 bonus can be claimed per case</div>` : "")
    + Object.entries(s.claimTickets || {}).map(([key, ref]) => `<div class="ticket-note">Ticket ${escapeHtml(ref)} raised for ${escapeHtml(AUTO_TICKET_PROGRAMS[key]?.label || key)}</div>`).join("");
}

const DATE_PATTERN = new RegExp([
  String.raw`\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b`,
  String.raw`\b\d{1,2}[-/.]\d{1,2}(?:[-/.]\d{2,4})?\b`,
  String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?(?:,?\s+\d{2,4})?\b`,
  String.raw`\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{2,4})?\b`,
].join("|"), "gi");

const AMOUNT_PATTERN = /\bRM\s?-?\d+(?:\.\d+)?\b|\bBonus\s+-?\d+(?:\.\d+)?\b/gi;
const PASS_VALUE_PATTERN = /\bPass\b(?:\s+\d+(?:\.\d+)?)?/gi;
const ELIGIBLE_PATTERN = /\bEligible\b/gi;

function highlightDates(text) {
  return escapeHtml(text).replace(DATE_PATTERN, (m) => `<span class="ticket-date">${m}</span>`);
}

function formatTicketMeta(text) {
  let html = escapeHtml(text);
  html = html.replace(ELIGIBLE_PATTERN, (m) => `<span class="eligible-value">${m}</span>`);
  html = html.replace(PASS_VALUE_PATTERN, (m) => `<span class="pass-value">${m}</span>`);
  html = html.replace(DATE_PATTERN, (m) => `📅 <span class="ticket-date">${m}</span>`);
  html = html.replace(AMOUNT_PATTERN, (m) => `🎁 <span class="amount">${m}</span>`);
  return html;
}

function renderExpiryLine(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const diff = ms - Date.now();
  const expired = diff <= 0;
  const soon = !expired && diff <= 24 * 60 * 60 * 1000;
  const cls = expired ? "ticket-expiry-expired" : soon ? "ticket-expiry-soon" : "ticket-expiry-ok";
  const d = new Date(ms);
  const dateStr = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const timeStr = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const label = expired ? "Expired" : "Expires";
  return `<div class="ticket-expiry ${cls}">📅 ${label}: ${escapeHtml(dateStr)} (${escapeHtml(timeStr)})</div>`;
}

function renderInquiryChips(chatId) {
  const s = state[chatId];
  if (!s.inquiry.length) return "";
  return s.inquiry.map((v) => `
    <span class="inquiry-chip">${v}<button type="button" class="inquiry-chip-remove" data-action="removeInquiry" data-chat="${chatId}" data-value="${v}" aria-label="Remove ${v}">✕</button></span>
  `).join("");
}

function refreshInquiryChips(card, chatId) {
  card.querySelector(".inquiry-chips").innerHTML = renderInquiryChips(chatId);
  const searchInput = card.querySelector(".inquiry-search");
  if (searchInput) searchInput.placeholder = state[chatId].inquiry.length ? "" : "Search inquiry…";
}

function renderInquiryDropdown(chatId, query) {
  const s = state[chatId];
  const maxed = s.inquiry.length >= 2;
  const q = (query || "").trim().toLowerCase();
  const filtered = inquiryOptions.filter((opt) => !q || opt.toLowerCase().includes(q));
  if (!filtered.length) return `<div class="inquiry-option-empty">No matching inquiry</div>`;
  return filtered.map((opt) => {
    const active = s.inquiry.includes(opt);
    const disabled = maxed && !active;
    return `
    <button type="button" class="inquiry-option ${active ? "active" : ""} ${disabled ? "disabled" : ""}"
      data-action="toggleInquiry" data-chat="${chatId}" data-value="${opt}" ${disabled ? "disabled" : ""}>
      <span class="inquiry-option-check">${active ? "✓" : ""}</span>${opt}
    </button>`;
  }).join("");
}

function renderAutoFields(chatId) {
  const s = state[chatId];
  return `
    <div class="auto-grid">
      <div class="auto-field">
        <span class="field-label" style="margin:0">Brand <span class="auto-tag">auto</span></span>
        <div class="brand-picker">
          <button type="button" class="input status-display brand-display" data-action="toggleBrandDropdown" data-chat="${chatId}">
            ${renderBrandDisplay(chatId)}
          </button>
          <div class="brand-dropdown ${s.brandDropdownOpen ? "" : "hidden"}">${renderBrandDropdown(chatId)}</div>
        </div>
      </div>
      <div class="auto-field">
        <span class="field-label" style="margin:0">D.O.B</span>
        <div class="dob-picker">
          <button type="button" class="input status-display dob-display" data-action="toggleDobCalendar" data-chat="${chatId}">
            ${renderDobDisplay(chatId)}
          </button>
          <div class="dob-calendar ${s.dobCalendarOpen ? "" : "hidden"}">${s.dobCalendarOpen ? renderDobCalendar(chatId) : ""}</div>
        </div>
      </div>
      <div class="auto-field">
        <span class="field-label" style="margin:0">Amount <span class="auto-tag">auto</span></span>
        <!-- Always editable, not just when Risk Player is the claimed bonus
             (the only program with no claimable amount to read off any Lark
             field at all -- CS works that one out manually). Auto-derived
             programs pre-fill this the same as before; CS can still correct
             it if the derived value's ever wrong. releasedBonusAmount/
             releasedAmountRaw double as the typed value directly -- same
             fields lark-record.js already reads at submit time (its own
             extractAmount() pulls the number back out regardless of
             whatever label text still surrounds it), no separate state
             needed. -->
        <input type="text" inputmode="decimal" class="input mono amount-input" data-chat="${chatId}" placeholder="Type amount" value="${s.releasedBonusAmount || ""}" />
      </div>
      <div class="auto-field">
        <span class="field-label" style="margin:0">Claim Secret <span class="auto-tag">auto</span></span>
        <!-- Auto-ticked when a bonus is claimed, but CS can flip it by hand.
             claimSecretManual stops later auto-updates from overriding that. -->
        <div class="auto-value" style="display:flex;align-items:center;gap:10px">
          <label class="switch">
            <input type="checkbox" class="secret-check" data-chat="${chatId}" ${s.claimSecret ? "checked" : ""} />
            <span class="slider"></span>
          </label>
          <span class="secret-label">${s.claimSecret ? "✓ Ticked" : "— Not ticked"}</span>
        </div>
      </div>
    </div>`;
}

function renderCollapsedCard(chat) {
  const s = state[chat.chatId];
  const summary = getChatSummary(chat.chatId);
  return `
    <button type="button" class="chat-card-collapsed-row" data-action="toggleExpand" data-chat="${chat.chatId}">
      <span class="chat-name">${chat.customerName}</span>
      <span class="collapsed-summary summary-${summary.cls}">${summary.text}</span>
    </button>
    <div class="collapsed-actions">
      ${chat.link ? `<a class="chat-link" href="${chat.link}" target="_blank">Open ↗</a>` : ""}
      <button class="expand-btn" data-action="toggleExpand" data-chat="${chat.chatId}" title="Expand">▾</button>
    </div>
  `;
}

const CONSOLE_NOTE_MAX = 2000;
const noteUiByChat = new Map();
const CONSOLE_NOTE_TYPES = {
  relationship: { label: "Relationship note", where: "Relationship notes", hint: "The customer's personal info. It resurfaces every time anyone contacts them.", placeholder: "A personal fact about this customer (e.g. prefers Telegram, birthday in March)…", add: "Add note" },
  action: { label: "Action log", where: "Action log", hint: "The next action for this player.", placeholder: "What should happen next, or what was done (e.g. call back Friday about the VIP trip)…", add: "Add action" },
};
function noteUi(chatId) {
  if (!noteUiByChat.has(chatId)) noteUiByChat.set(chatId, { type: "relationship", draft: "", busy: false, msg: "", kind: "", notes: null, notesBusy: false });
  return noteUiByChat.get(chatId);
}

function consoleNoteBlocker(s) {
  if (s.isUnknown) return "Unknown player: notes need a real player in the console.";
  if (!String(s.username || "").trim() || !String(s.brand || "").trim()) return "Notes need the player's username and brand. Look the player up first.";
  return "";
}

function renderNoteSection(chatId) {
  const s = state[chatId];
  if (!s || !s.matchedRow) return "";
  const ui = noteUi(chatId);
  const blocker = consoleNoteBlocker(s);
  const off = !!blocker || ui.busy;
  const typeDef = CONSOLE_NOTE_TYPES[ui.type] || CONSOLE_NOTE_TYPES.relationship;
  const notes = Array.isArray(ui.notes)
    ? (ui.notes.length
      ? `<ul class="note-list">${ui.notes.map((n) => `<li><div class="note-text">${escapeHtml(n.note)}</div><div class="note-meta">${escapeHtml(n.by)}${n.at ? ` · ${escapeHtml(n.at)}` : ""}</div></li>`).join("")}</ul>`
      : `<div class="note-empty">Nothing in the console's ${escapeHtml(typeDef.where)} for this player yet.</div>`)
    : "";
  return `
    <section class="ca-note-section">
      <div class="note-types" role="group" aria-label="Where the note goes">${Object.entries(CONSOLE_NOTE_TYPES).map(([key, def]) => `<button type="button" class="note-type-btn ${ui.type === key ? "active" : ""}" data-action="noteType" data-type="${key}" data-chat="${escapeHtml(chatId)}" ${ui.busy ? "disabled" : ""}>${escapeHtml(def.label)}</button>`).join("")}</div>
      <div class="note-hint">${escapeHtml(typeDef.hint)} Goes to the console's ${escapeHtml(typeDef.where)}.</div>
      <textarea class="input note-input" data-chat="${escapeHtml(chatId)}" rows="3" maxlength="${CONSOLE_NOTE_MAX}" placeholder="${escapeHtml(typeDef.placeholder)}" ${off ? "disabled" : ""}>${escapeHtml(ui.draft)}</textarea>
      <div class="note-row">
        <span class="note-count">${ui.draft.length} / ${CONSOLE_NOTE_MAX}</span>
        <button type="button" class="note-secondary-btn" data-action="loadNotes" data-chat="${escapeHtml(chatId)}" ${blocker || ui.notesBusy ? "disabled" : ""}>${ui.notesBusy ? "Loading…" : ui.notes ? "Refresh" : `Show ${escapeHtml(typeDef.where.toLowerCase())}`}</button>
        <button type="button" class="note-save-btn" data-action="saveNote" data-chat="${escapeHtml(chatId)}" ${off ? "disabled" : ""}>${ui.busy ? "Saving…" : escapeHtml(typeDef.add)}</button>
      </div>
      ${blocker ? `<div class="note-msg note-error">${escapeHtml(blocker)}</div>` : ui.msg ? `<div class="note-msg ${ui.kind === "ok" ? "note-ok" : ui.kind === "error" ? "note-error" : ""}">${escapeHtml(ui.msg)}</div>` : ""}
      ${previewMode ? `<div class="note-msg">Test mode: a note added here really is saved to the console.</div>` : ""}
      ${notes}
    </section>`;
}

function paintNoteSection(chatId) {
  const slot = chatListEl.querySelector(`.chat-card[data-chat-id="${chatId}"] .note-slot`);
  if (slot) slot.innerHTML = renderNoteSection(chatId);
}

async function postConsoleNote(s, extra) {
  const accountKey = currentLiveChatAccount;
  const agentToken = liveChatAgentTokens()[accountKey];
  if (!accountKey || !agentToken) return { ok: false, error: "Connect LiveChat first: a note has to say which agent wrote it." };
  try {
    const response = await fetch("/console-note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountKey, agentToken, username: String(s.username).trim(), brand: String(s.brand).trim(), ...extra }),
      ...(typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(20_000) } : {}),
    });
    return await response.json();
  } catch (_) {
    return { ok: false, unsure: true, error: "The widget server did not answer. If you were adding a note, it may or may not have been saved: check the player's console notes before sending it again." };
  }
}

async function saveConsoleNote(chatId) {
  const s = state[chatId];
  const ui = noteUi(chatId);
  if (!s || ui.busy || consoleNoteBlocker(s)) return;
  const note = ui.draft.trim();
  if (!note) { ui.msg = "Write the note first."; ui.kind = "error"; paintNoteSection(chatId); return; }
  if (note.length > CONSOLE_NOTE_MAX) { ui.msg = `The note is too long (${note.length} of ${CONSOLE_NOTE_MAX} characters).`; ui.kind = "error"; paintNoteSection(chatId); return; }
  ui.busy = true; ui.msg = ""; ui.kind = "";
  paintNoteSection(chatId);
  const type = ui.type;
  const answer = await postConsoleNote(s, { note, type });
  ui.busy = false;
  if (answer && answer.ok && answer.saved) {
    ui.draft = ""; ui.msg = `Saved to the ${(CONSOLE_NOTE_TYPES[type] || CONSOLE_NOTE_TYPES.relationship).where}`; ui.kind = "ok";
    ui.notes = null;
  } else {
    ui.msg = (answer && answer.error) || "The note could not be saved."; ui.kind = "error";
  }
  paintNoteSection(chatId);
}

async function loadConsoleNotes(chatId) {
  const s = state[chatId];
  const ui = noteUi(chatId);
  if (!s || ui.notesBusy || consoleNoteBlocker(s)) return;
  ui.notesBusy = true; ui.msg = ""; ui.kind = "";
  paintNoteSection(chatId);
  const answer = await postConsoleNote(s, { list: true, type: ui.type });
  ui.notesBusy = false;
  if (answer && answer.ok && Array.isArray(answer.notes)) ui.notes = answer.notes;
  else { ui.msg = (answer && answer.error) || "The notes could not be loaded."; ui.kind = "error"; }
  paintNoteSection(chatId);
}

function renderExpandedCard(chat) {
  const s = state[chat.chatId];
  return `
    ${previewMode ? `<div class="chat-card-head">
      <span class="chat-name">${chat.customerName}</span>
      <div class="chat-card-head-actions">
        ${previewMode ? `<span class="preview-mode-badge">TEST MODE · READ ONLY</span><button type="button" class="preview-reset-btn" data-action="resetPreview" data-chat="${chat.chatId}">Reset test</button>` : ""}
        ${chat.link ? `<a class="chat-link" href="${chat.link}" target="_blank">Open ↗</a>` : ""}
        <button class="expand-btn expanded" data-action="toggleExpand" data-chat="${chat.chatId}" title="Collapse">▴</button>
      </div>
    </div>` : ""}

    ${previewMode ? `<div class="preview-example-control"><button type="button" class="preview-reset-btn" data-action="toggleAttentionPreview" data-chat="${chat.chatId}">${showPreviewClosedChat ? "Hide closed-chat example" : "Preview closed, unrecorded chat"}</button></div>` : ""}

    <section class="ca-section ca-customer-section">
      <div class="ca-section-head"><div><strong>Customer</strong></div></div>
      <label class="field-label">Username or user ID</label>
      <div class="username-row">
        <input type="text" class="input mono username-input" placeholder="${s.lastUsernameLoading ? "Checking for a previous record…" : "Player username / UID"}" value="${s.usernameDraft || s.username}" ${s.isUnknown && !s.notVipResult ? "disabled" : ""} />
        ${s.lookupInFlight
          ? `<button class="lookup-btn lookup-cancel-btn" data-action="cancelLookup" data-chat="${chat.chatId}" title="Cancel this lookup">Cancel</button>`
          : `<button class="lookup-btn ${s.notVipResult ? "force" : ""}" data-action="lookup" data-chat="${chat.chatId}" ${(s.isUnknown && !s.notVipResult) ? "disabled" : ""} ${s.notVipResult ? 'title="Not on the VIP list — look up again anyway and keep them as a VIP"' : ""}>${s.notVipResult ? "Force lookup" : "Look up"}</button>`}
      </div>
      <label class="unknown-toggle"><input type="checkbox" class="unknown-check" data-chat="${chat.chatId}" ${s.isUnknown ? "checked" : ""} /><span>Unknown player</span></label>
      <div class="player-info-slot">${renderPlayerInfo(chat.chatId)}</div>
      <div class="note-slot">${renderNoteSection(chat.chatId)}</div>
    </section>

    <section class="ca-section ca-bonus-section">
      <div class="ca-section-head"><div><strong>Available bonuses</strong></div></div>
      <div class="ticket-slot">${renderTickets(chat.chatId)}</div>
    </section>

    <section class="ca-section ca-case-section">
      <div class="ca-section-head"><div><strong>Case details</strong></div></div>
      <div class="auto-fields-slot">${renderAutoFields(chat.chatId)}</div>
      <label class="field-label">Inquiry</label>
      <div class="inquiry-select">
        <div class="inquiry-box"><div class="inquiry-chips">${renderInquiryChips(chat.chatId)}</div><input type="text" class="inquiry-search" placeholder="${s.inquiry.length ? "" : "Search inquiry…"}" autocomplete="off" /><span class="inquiry-caret">▾</span></div>
        <div class="inquiry-dropdown ${s.inquiryDropdownOpen ? "" : "hidden"}">${renderInquiryDropdown(chat.chatId, "")}</div>
      </div>
      <label class="field-label">Status</label>
      <div class="status-picker">
        <div class="status-box"><div class="status-chip-slot">${renderStatusChip(chat.chatId)}</div><input type="text" class="status-search" placeholder="${s.status ? "" : "Select status…"}" autocomplete="off" /><span class="inquiry-caret">▾</span></div>
        <div class="status-dropdown ${s.statusDropdownOpen ? "" : "hidden"}">${renderStatusDropdown(chat.chatId, "")}</div>
      </div>
      <div class="toggle-row"><label class="field-label">Telegram chat <span class="auto-tag">auto</span></label><label class="switch"><input type="checkbox" class="tg-check" data-chat="${chat.chatId}" ${s.telegram ? "checked" : ""} /><span class="slider"></span></label></div>
    </section>

    ${s.autoRecordError && !previewMode ? `<div class="record-error-banner">⚠︎ ${s.autoRecordError}</div>` : ""}

    ${
      previewMode
        ? `<div class="preview-readonly-note">${showPreviewClosedChat ? "Closed-chat example: the chat ended without Inquiry or Status, so it was not recorded." : BONUS_SHOWCASE_PREVIEW ? "Bonus showcase uses sample eligibility and amounts." : "Test mode reads live bonus data."} Claims and form changes stay on this preview card and never create or update a Lark record.</div>`
        : isLoggingPaused() && !s.logged
        ? `<div class="logged-badge unknown">Logging paused — not recorded</div>`
        : s.isUnknown
          ? `<div class="logged-badge unknown">Unknown player — won't be recorded</div>`
          : s.logged
            ? `<div class="logged-badge">✓ Logged to Lark Base</div>`
            : s.chatOpen
              ? `<div class="record-pending-hint">Recording happens automatically once this chat closes</div>`
              : `<button class="submit-btn" data-action="submit" data-chat="${chat.chatId}">Record to Lark Base</button>`
    }

    <div class="cases-slot">${renderCasesBar(chat.chatId)}</div>

    ${previewMode ? `
      <details class="bonus-admin-embed">
        <summary>⚙ Bonus Setup Admin</summary>
        <iframe data-src="/bonus-admin.html?embedded=1" loading="lazy" title="Bonus Setup Admin"></iframe>
      </details>` : ""}

  `;
}

function renderAdminTicketWorkspace(chat) {
  return `<div class="escalation-slot ticket-inbox-workspace">${renderEscalationSection(chat.chatId)}</div>`;
}

const TICKET_FIELD_SPECS = [
  { stateKey: "memberUserId", keys: ["member_id"], labels: ["Member / User ID", "Member ID"], required: true },
  { stateKey: "brand", keys: ["member_platform", "brand"], labels: ["Brand"], required: true },
  { stateKey: "queries", keys: ["query_type"], labels: ["Query type", "Queries"], required: true },
  { stateKey: "status", keys: ["status"], labels: ["Status"] },
  { stateKey: "transactionId", keys: ["transaction_id"], labels: ["Transaction ID"] },
  { stateKey: "paymentGateway", keys: ["payment_gateway"], labels: ["Payment Gateway"] },
  { stateKey: "amount", keys: ["amount"], labels: ["Amount"] },
  { stateKey: "remarks", keys: ["remarks"], labels: ["Remarks", "Remarks (CS - PYM)"] },
  { stateKey: "vipLevel", keys: ["member_level", "level", "vip_level"], labels: ["Level", "VIP Level"] },
];

const TICKET_FALLBACK_OPTIONS = {
  status: [
    ["OPEN", "Open"], ["IN_PROGRESS", "PYM PROCESSING"], ["COMP_PROCESSING", "COMP PROCESSING"],
    ["CS_TO_FOLLOW_UP", "CS TO FOLLOW UP"], ["PYM_TO_FOLLOW_UP", "PYM TO FOLLOW UP"],
    ["SOLVED", "CS TEAM SOLVED"], ["X_VOID_TICKET", "X. VOID TICKET"],
    ["ONSITE_TEAM_DONE", "QA TEAM DONE"], ["UNSOLVED_TICKET", "UNSOLVED TICKET"],
    ["PYM_SOLVED", "PYM TEAM SOLVED"], ["COMP_TEAM_SOLVED", "COMP TEAM SOLVED"], ["Closed", "Closed"],
  ],
  query_type: [
    ["dp_not_credited", "DP NOT CREDITED"], ["wd_delay", "WD DELAY"], ["missing_wd", "MISSING WD"],
    ["kyc_chg_acc_name", "KYC CHG ACC/NAME"], ["REFUND", "REFUND"], ["pg_wrong_approve", "PG WRONG APPROVE"],
    ["pym_wd_pending_to_nar", "PYM - WD PENDING (TO/NAR)"],
    ["pym_wd_pending_invalid_acc", "PYM - WD PENDING (INVALID ACC)"], ["OTHERS", "OTHERS"],
    ["cancel_deposit", "Cancel Deposit"], ["birthday_bonus", "Birthday Bonus"], ["credit_adjustment", "Credit Adjustment"],
    "VVIP WOW Manual Rebate", "(VIP-Slot) OFF (50% VIP Bonus, min dep 100, max Bonus 500, x2TO)",
    "(VIP-Sports) OFF (20% VIP Bonus, min dep 30, max Bonus 300, x5TO)",
    "(VIP-Live) OFF (20% VIP Bonus, min dep 30, max Bonus 300, x5TO)",
    "RA RT Claim Petroleum Receipt Campaign", "Offline Promo Adjustment", "DP SLIP VERIFICATION",
    "DUPLICATED ACCOUNT", "OTHERS (FOR PYM)", "OTHERS (FOR CS/CBD)", "Adjustment Purpose (Compliance)",
    "VVIP TOP P&L BONUS", "VVIP LTV 70 BONUS", "VVIP Grace Period BONUS", "VVIP Risk Player BONUS", "VVIP Complain Players",
  ],
  payment_gateway: [
    "KAAZPAY", "PAYMIER", "GOPAY", "SPEEDPAY", "DGPAY", "METAPAY", "PAYESSENCE", "TRUEPAY", "FPAY", "WINPAY", "ONEPAY", "RAPIDPAY",
    "SUPERPAY", "GLOBEPAY", "GMPAY", "EPICPAY", "NOVAPAY", "XXXPAY", "VDPAY", "SEAPAY", "KIRAPAY", "PAYEX", "THE7PAY", "KOIPAY",
    "AKAIPAY", "NOT BELONG TO ANY PG'S", "CANCEL WITHDRAWAL", "DirectPay", "CANCEL DEPOSIT", "JAYAPAY", "APOLLO PAY", "SG PAY",
    "DUMPLING PAY (DPP)", "RM PAY", "GCASH PAY", "MM PAY", "GXP PAY", "XPAY", "ALL2PAY", "SODA PAY", "U2C PAY", "TARSPAY",
  ],
  member_level: [
    ["0_3", "0-3"], ["4_8", "4-8"], ["9_and_above", "9 and above"], ["VVIP", "VVIP"],
    ["classic_idr", "Classic"], ["silver_idr", "Silver"], ["gold_idr", "Gold"], ["platinum_idr", "Platinum"],
    ["emerald_idr", "Emerald"], ["sapphire_idr", "Sapphire"], ["ruby_idr", "Ruby"], ["diamond_idr", "Diamond"],
  ],
  member_platform: ["tcbo", "CS96", "SPIN321", "PP96", "MY36", "ACE33", "OMG67", "EZ96", "BM69", "AS126", "HOT321", "RM68", "VS96"],
};

const ticketAttachmentsByChat = new Map();
const ticketCreateInFlight = new Set();
const ticketDetailInFlight = new Set();
const claimWriteInFlight = new Set();
const ticketSearchResultsByChat = new Map();
const watchedTicketSnapshots = new Map();
const TICKET_ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);
const TICKET_ATTACHMENT_MAX_BYTES = 1024 * 1024;
const PICTURE_FIT_BYTES = 1_000_000;
const PICTURE_STEPS = [[1, 0.92], [1, 0.85], [1, 0.78], [0.85, 0.85], [0.85, 0.78], [0.7, 0.8], [0.55, 0.8], [0.4, 0.8]];
async function compressPicture(file) {
  if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 30 * 1024 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const encode = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    let canvas = null;
    let drawnAt = 0;
    for (const [scale, quality] of PICTURE_STEPS) {
      if (scale !== drawnAt) {
        canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        drawnAt = scale;
      }
      for (const type of ["image/webp", "image/jpeg"]) {
        const blob = await encode(canvas, type, quality);
        if (!blob || blob.type !== type) continue;
        if (blob.size < PICTURE_FIT_BYTES && blob.size < file.size) return new File([blob], `${String(file.name || "picture").replace(/\.\w+$/, "")}.${type === "image/webp" ? "webp" : "jpg"}`, { type });
        break;
      }
    }
  } catch (_) { }
  return file;
}
const ticketMaxBytes = () => TICKET_ATTACHMENT_MAX_BYTES;

function ticketAttachmentField() {
  return ticketFields.find((field) => field.type === "ATTACHMENT") || null;
}

function renderTicketAttachments(chatId) {
  const field = ticketAttachmentField();
  if (!field) return "";
  const s = state[chatId];
  const files = ticketAttachmentsByChat.get(chatId) || [];
  const rows = files.map((file, index) => `
    <div class="ticket-attachment-item">
      <span title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      <small>${Math.max(1, Math.ceil(file.size / 1024))}KB</small>
      <button type="button" data-action="removeTicketAttachment" data-chat="${escapeHtml(chatId)}" data-index="${index}" aria-label="Remove ${escapeHtml(file.name)}">×</button>
    </div>`).join("");
  return `
    <div class="ticket-attachment-picker" data-chat="${escapeHtml(chatId)}" tabindex="0" aria-label="Ticket attachments. Choose files or paste from the clipboard.">
      <label class="field-label">${escapeHtml(field.label || "Attachment")}</label>
      <label class="ticket-file-button">
        <input type="file" class="ticket-attachment-input" data-chat="${escapeHtml(chatId)}" accept="image/png,image/jpeg,image/webp,application/pdf" multiple />
        <span>${files.length ? "+ Add more files" : "Choose files"}</span>
      </label>
      <div class="ticket-attachment-help">Pictures are shrunk to fit · PDF under 1MB · up to 6 files · click here and press Ctrl+V to paste</div>
      ${rows ? `<div class="ticket-attachment-list">${rows}</div>` : ""}
      ${s?.ticketAttachmentError ? `<div class="ticket-attachment-error">${escapeHtml(s.ticketAttachmentError)}</div>` : ""}
    </div>`;
}

function addTicketAttachments(chatId, addedFiles) {
  const s = state[chatId];
  if (!s) return false;
  const existing = ticketAttachmentsByChat.get(chatId) || [];
  const added = Array.from(addedFiles || []).filter(Boolean);
  const combined = [...existing, ...added];
  let error = "";
  if (!added.length) error = "The clipboard did not contain an image, PDF, or file.";
  else if (combined.length > 6) error = "You can attach up to 6 files.";
  else {
    const invalid = added.find((file) => !file.size || file.size >= ticketMaxBytes(file) || !TICKET_ATTACHMENT_TYPES.has(file.type));
    if (invalid) {
      error = !invalid.size
        ? `${invalid.name || "Attachment"} is empty.`
        : invalid.size >= ticketMaxBytes(invalid)
          ? `${invalid.name || "Attachment"} must be under ${ticketMaxBytes(invalid) / (1024 * 1024)}MB.`
          : `${invalid.name || "Attachment"} must be PNG, JPG, WEBP, or PDF.`;
    }
  }
  if (!error) ticketAttachmentsByChat.set(chatId, combined);
  s.ticketAttachmentError = error;
  return !error;
}

const AUTO_TICKET_DEPARTMENT = "PYM_MYR";
const AUTO_TICKET_LEVEL = "VVIP";
const AUTO_TICKET_PROGRAMS = {
  topPnl: { label: "Top P&L", keyword: "TOP P&L" },
  ltvTest: { label: "LTV", keyword: "LTV" },
  gracePeriod: { label: "Grace Period", keyword: "Grace Period" },
  riskPlayer: { label: "Risk Player", keyword: "Risk Player" },
  halloween: { label: "Halloween", keyword: "Complain Players" },
};
const DEFAULT_MARKET_LOCAL_KEY = "rc-default-market";
let agentDefaultMarket = { account: "", code: "" };
const claimTicketBusy = new Set();

function autoTicketEnabled() {
  return ESCALATION_TICKET_ENABLED && (previewMode || AUTO_TICKET_LIVE);
}

function randomTransactionId(length = 32) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const limit = 256 - (256 % alphabet.length);
  let id = "";
  while (id.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && id.length < length) id += alphabet[byte % alphabet.length];
    }
  }
  return id;
}

function autoTicketQueryOption(options, keyword) {
  const wanted = ticketChoiceSlug(keyword);
  if (!wanted) return null;
  const rank = (option) => {
    const slug = ticketChoiceSlug(option.label || option.value);
    return (slug.startsWith("vvip") ? 0 : 2) + (slug.includes("bonus") ? 0 : 1);
  };
  const hits = (options || []).filter((option) => [option.label, option.value].some((text) => ticketChoiceSlug(text).includes(wanted)));
  return hits.sort((a, b) => rank(a) - rank(b))[0] || null;
}

function buildClaimTicketFields(s, programKey, amount, market) {
  const program = AUTO_TICKET_PROGRAMS[programKey];
  const need = (stateKey) => ticketFieldFor(TICKET_FIELD_SPECS.find((spec) => spec.stateKey === stateKey));
  const memberField = need("memberUserId");
  const brandField = need("brand");
  const queryField = need("queries");
  if (!memberField || !brandField || !queryField) return { error: "The ticket form is missing a field this ticket needs (Member ID, Brand or Query type)." };
  const username = String(s.username || "").trim();
  if (!username) return { error: "Look up the player's username first." };
  const brand = String(s.escalation?.brand || "").trim();
  if (!brand) return { error: "The brand of this chat is not known yet, so the ticket cannot be raised." };
  const number = Number(String(amount ?? "").replace(/,/g, ""));
  if (!Number.isFinite(number) || number <= 0) return { error: `The ${program.label} amount could not be read, so the ticket cannot be raised.` };
  const query = autoTicketQueryOption(ticketFieldOptions(queryField), program.keyword);
  if (!query) return { error: `No ticket query type contains "${program.keyword}", so no ticket can be raised. Ask your admin.` };
  const marketCode = String(market || "").trim();
  if (!marketCode) return { error: "Choose your market first." };
  const fields = { [memberField.key]: username, [brandField.key]: brand, [queryField.key]: query.value };
  const amountField = need("amount");
  if (amountField) fields[amountField.key] = number;
  const transactionField = need("transactionId");
  if (transactionField) fields[transactionField.key] = randomTransactionId();
  const statusField = need("status");
  if (statusField) {
    const open = ticketFieldOptions(statusField).find((option) => [option.value, option.label].some((text) => String(text).trim().toLowerCase() === "open"));
    fields[statusField.key] = statusField.defaultValue || (open ? open.value : "OPEN");
  }
  const levelField = need("vipLevel");
  if (levelField) {
    const level = ticketFieldOptions(levelField).find((option) => [option.value, option.label].some((text) => String(text).toLowerCase() === AUTO_TICKET_LEVEL.toLowerCase()));
    fields[levelField.key] = level ? level.value : AUTO_TICKET_LEVEL;
  }
  const department = ticketDepartments.find((item) => String(item.code || "").toUpperCase() === AUTO_TICKET_DEPARTMENT);
  fields.toDepartment = department?.code || AUTO_TICKET_DEPARTMENT;
  fields.market = marketCode;
  return { fields, query, departmentName: department?.name || AUTO_TICKET_DEPARTMENT };
}

async function loadDefaultMarket(s) {
  const author = ticketAuthor(s);
  if (!author) {
    let code = "";
    try { code = localStorage.getItem(DEFAULT_MARKET_LOCAL_KEY) || ""; } catch (_) { }
    return { code, locked: false };
  }
  if (agentDefaultMarket.account === author.accountKey && agentDefaultMarket.code) return { code: agentDefaultMarket.code, locked: true };
  const res = await fetch("/agent-market", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ author }) });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Your default market could not be read.");
  if (data.market) agentDefaultMarket = { account: author.accountKey, code: data.market };
  let remembered = "";
  if (!data.market) { try { remembered = localStorage.getItem(DEFAULT_MARKET_LOCAL_KEY) || ""; } catch (_) { } }
  return { code: data.market || remembered, locked: !!data.market };
}

async function saveDefaultMarket(s, code) {
  const author = ticketAuthor(s);
  if (!author) {
    try { localStorage.setItem(DEFAULT_MARKET_LOCAL_KEY, code); } catch (_) { }
    return code;
  }
  const res = await fetch("/agent-market", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ author, market: code }) });
  const data = await res.json();
  if (!data.ok && data.loginExpired) throw new Error(data.error || "Your LiveChat login expired. Connect LiveChat again.");
  if (!data.ok || !data.market) {
    try { localStorage.setItem(DEFAULT_MARKET_LOCAL_KEY, code); } catch (_) { }
    return code;
  }
  agentDefaultMarket = { account: author.accountKey, code: data.market };
  return data.market;
}

function openClaimTicketModal({ title, intro, rows, markets, market, marketLocked, previewNote, onSubmit }) {
  return new Promise((resolve) => {
    document.getElementById("claimTicketOverlay")?.remove();
    const files = [];
    let busy = false;
    const marketLabel = (code) => (markets.find((item) => item.value === code) || {}).label || code;
    const overlay = document.createElement("div");
    overlay.id = "claimTicketOverlay";
    overlay.className = "claim-ticket-backdrop";
    overlay.innerHTML = `<div class="claim-ticket-card" role="dialog" aria-modal="true" aria-labelledby="claimTicketTitle">
      <div class="claim-ticket-head"><span class="claim-ticket-mark" aria-hidden="true">🎫</span><div><h3 id="claimTicketTitle">${escapeHtml(title)}</h3><p class="claim-ticket-intro">${intro}</p></div></div>
      ${previewNote ? `<div class="claim-ticket-preview">${escapeHtml(previewNote)}</div>` : ""}
      <dl class="claim-ticket-summary">${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}
        <dt>Market</dt><dd>${marketLocked
          ? `${escapeHtml(marketLabel(market))} <span class="claim-ticket-note">(your default market; an admin changes it)</span>`
          : `<select class="input claim-ticket-market" aria-label="Your market"><option value="">Choose your market…</option>${markets.map((item) => `<option value="${escapeHtml(item.value)}" ${item.value === market ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select><span class="claim-ticket-note">You choose this once. Only an admin can change it afterwards.</span>`}</dd></dl>
      <div class="claim-ticket-label">Proof <span>required</span></div>
      <div class="claim-ticket-drop" tabindex="0" aria-label="Proof. Choose files, drop them here or press Ctrl+V to paste.">
        <span class="claim-ticket-drop-icon" aria-hidden="true">⬆</span>
        <strong>Paste or drag a picture here</strong>
        <label class="ticket-file-button"><input type="file" class="claim-ticket-input" accept="image/png,image/jpeg,image/webp,application/pdf" multiple /><span>or choose files</span></label>
        <small>Pictures are shrunk to fit · PDF under 1MB · up to 6 files</small>
      </div>
      <div class="ticket-attachment-list claim-ticket-files"></div>
      <div class="claim-ticket-email" hidden><input type="text" inputmode="email" autocomplete="email" class="input mono" placeholder="Your ticket account email: name@company.com" aria-label="Your ticket account email" /></div>
      <div class="claim-ticket-status" role="alert"></div>
      <div class="claim-ticket-actions"><button type="button" class="secondary-btn" data-claim-ticket="cancel">Cancel</button><button type="button" class="submit-btn" data-claim-ticket="go" disabled>Raise ticket and claim</button></div>
    </div>`;
    document.body.appendChild(overlay);
    const goButton = overlay.querySelector('[data-claim-ticket="go"]');
    const cancelButton = overlay.querySelector('[data-claim-ticket="cancel"]');
    const select = overlay.querySelector(".claim-ticket-market");
    const list = overlay.querySelector(".claim-ticket-files");
    const statusLine = overlay.querySelector(".claim-ticket-status");
    const emailRow = overlay.querySelector(".claim-ticket-email");
    const emailInput = emailRow.querySelector("input");
    const drop = overlay.querySelector(".claim-ticket-drop");
    const chosenMarket = () => (select ? select.value : market);
    const sync = () => { goButton.disabled = busy || !files.length || !chosenMarket(); cancelButton.disabled = busy; };
    const show = (text) => { statusLine.textContent = text; };
    const draw = () => {
      list.innerHTML = files.map((file, index) => `<div class="ticket-attachment-item"><span title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span><small>${Math.max(1, Math.ceil(file.size / 1024))}KB</small><button type="button" data-remove="${index}" aria-label="Remove ${escapeHtml(file.name)}">×</button></div>`).join("");
      sync();
    };
    const problemWith = (file) => !file.size ? `${file.name || "Attachment"} is empty.`
      : file.size >= ticketMaxBytes(file) ? `${file.name || "Attachment"} must be under ${ticketMaxBytes(file) / (1024 * 1024)}MB.`
        : !TICKET_ATTACHMENT_TYPES.has(file.type) ? `${file.name || "Attachment"} must be PNG, JPG, WEBP, or PDF.` : "";
    const add = async (incoming) => {
      const picked = Array.from(incoming || []).filter(Boolean);
      if (!picked.length || busy) return;
      const prepared = await Promise.all(picked.map(compressPicture));
      const bad = prepared.map(problemWith).find(Boolean);
      if (bad) { show(bad); return; }
      if (files.length + prepared.length > 6) { show("You can attach up to 6 files."); return; }
      files.push(...prepared);
      show("");
      draw();
    };
    const onPaste = (event) => {
      const pasted = Array.from(event.clipboardData?.items || []).filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
      if (!pasted.length) return;
      event.preventDefault();
      void add(pasted);
    };
    const onKey = (event) => { if (event.key === "Escape" && !busy) close(false); };
    const close = (result) => {
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    };
    const submit = async () => {
      if (busy || goButton.disabled) return;
      if (!emailRow.hidden && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailInput.value.trim())) { show("Enter your ticket account email, like name@company.com."); return; }
      busy = true;
      goButton.textContent = "Creating the ticket…";
      show("");
      sync();
      let result;
      try { result = await onSubmit({ files: [...files], market: chosenMarket(), ticketEmail: emailRow.hidden ? "" : emailInput.value.trim() }); }
      catch (err) { result = { ok: false, error: err.message }; }
      busy = false;
      goButton.textContent = "Raise ticket and claim";
      if (result.ok) { close(true); return; }
      show(result.error || "The ticket could not be created.");
      if (result.needTicketEmail) { emailRow.hidden = false; emailInput.focus(); }
      sync();
    };
    document.addEventListener("paste", onPaste);
    document.addEventListener("keydown", onKey);
    overlay.querySelector(".claim-ticket-input").addEventListener("change", (event) => { void add(event.target.files); event.target.value = ""; });
    drop.addEventListener("dragover", (event) => { event.preventDefault(); drop.classList.add("dragging"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
    drop.addEventListener("drop", (event) => { event.preventDefault(); drop.classList.remove("dragging"); void add(event.dataTransfer?.files); });
    list.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove]");
      if (!remove || busy) return;
      files.splice(Number(remove.dataset.remove), 1);
      draw();
    });
    if (select) select.addEventListener("change", sync);
    goButton.addEventListener("click", submit);
    cancelButton.addEventListener("click", () => close(false));
    draw();
    (select && !select.value ? select : drop).focus();
  });
}

const CLAIM_TICKET_USABLE_ACCOUNT = ["found", "off", "unknown"];
async function ticketAccountForClaim(chatId) {
  const problem = !CLAIM_TICKET_USABLE_ACCOUNT.includes(ticketAccount.status);
  if (ticketAccount.status === "unknown" && !ticketAccount.checking) await checkTicketAccount(chatId, { quiet: true });
  else if (problem && !ticketAccount.checking && Date.now() - ticketAccount.at > 60_000) await checkTicketAccount(chatId, { force: true, quiet: true });
  for (let waited = 0; ticketAccount.checking && waited < 4000; waited += 200) await new Promise((resolve) => setTimeout(resolve, 200));
  return ticketAccount.status;
}

async function applyDefaultMarketToNewTicket(chatId) {
  const s = state[chatId];
  if (!s?.escalation || s.escalation.marketTouched) return;
  let stored;
  try { stored = await loadDefaultMarket(s); } catch (_) { return; }
  if (!stored?.code) return;
  const item = ticketMarkets.find((market) => String(market.code || "").toUpperCase() === String(stored.code).toUpperCase());
  if (!item || s.escalation.marketTouched) return;
  s.escalation.marketId = String(item.id);
  renderTicketSlot(chatId);
}

async function raiseClaimTicket(chatId, programKey, amount) {
  const s = state[chatId];
  const program = AUTO_TICKET_PROGRAMS[programKey];
  if (!s || !program || !autoTicketEnabled()) return true;
  s.claimTickets = s.claimTickets || {};
  if (s.claimTickets[programKey]) { setStatus(`Ticket ${s.claimTickets[programKey]} was already raised for this ${program.label} claim.`, "success"); return true; }
  if (claimTicketBusy.has(chatId) || ticketCreateInFlight.has(chatId)) return false;
  claimTicketBusy.add(chatId);
  try {
    const account = await ticketAccountForClaim(chatId);
    if (!CLAIM_TICKET_USABLE_ACCOUNT.includes(account)) {
      setStatus(`No ticket was raised for this ${program.label} claim (ticket account: ${account}); the claim went ahead as normal.`, "info");
      claimTicketBusy.delete(chatId);
      return true;
    }
  } catch (_) { }
  try {
    if (!ticketFields.length) await fetchTicketConfig({ fresh: true });
    if (!ticketFields.length) { setStatus(`The ticket form could not be loaded (${ticketConfigError || "no fields"}). Nothing was claimed.`, "error"); return false; }
    let stored;
    try { stored = await loadDefaultMarket(s); }
    catch (err) { setStatus(`${err.message} Nothing was claimed.`, "error"); return false; }
    const check = buildClaimTicketFields(s, programKey, amount, stored.code || "-");
    if (check.error) { setStatus(`${check.error} Nothing was claimed.`, "error"); return false; }
    const markets = ticketMarkets.map((item) => ({ value: String(item.code || item.id), label: item.label || item.code || String(item.id) }));
    return await openClaimTicketModal({
      title: `Raise a ticket to claim ${program.label}`,
      intro: `Claiming ${escapeHtml(program.label)} raises a ticket for <strong>${escapeHtml(check.departmentName)}</strong> first. Add the proof below.`,
      rows: [["Player", s.username], ["Query type", check.query.label || check.query.value], ["Amount", String(amount)], ["Level", AUTO_TICKET_LEVEL]],
      markets,
      market: stored.code,
      marketLocked: stored.locked,
      previewNote: previewMode ? "Admin preview: this creates a real ticket." : "",
      onSubmit: async ({ files, market, ticketEmail }) => {
        try {
          if (ticketEmail) s.escalation.ticketEmail = ticketEmail;
          const marketCode = stored.locked ? stored.code : await saveDefaultMarket(s, market);
          stored.code = marketCode;
          stored.locked = true;
          const built = buildClaimTicketFields(s, programKey, amount, marketCode);
          if (built.error) return { ok: false, error: built.error };
          const form = new FormData();
          form.append("ticket", JSON.stringify({ fields: built.fields, author: ticketAuthor(s) }));
          const attachmentField = ticketAttachmentField();
          const partName = attachmentField?.key || attachmentField?.label || "Attachment";
          for (const file of files) form.append(partName, file, file.name);
          ticketCreateInFlight.add(chatId);
          let data;
          try {
            const res = await fetch("/ticket-create", { method: "POST", body: form });
            data = await res.json();
          } finally {
            ticketCreateInFlight.delete(chatId);
          }
          if (!data.ok) return { ok: false, error: data.error || "The ticket could not be created.", needTicketEmail: !!data.needTicketEmail };
          s.claimTickets[programKey] = data.ref;
          s.ticketNotice = data.warning || "";
          noteTicketAccountUsed(data);
          if (s.escalation.ticketEmail) storeTicketEmail(currentLiveChatAccount, s.escalation.ticketEmail);
          ticketSearchResultsByChat.delete(chatId);
          saveState();
          setStatus(`Ticket ${data.ref} raised for ${program.label}.`, "success");
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    });
  } finally {
    claimTicketBusy.delete(chatId);
  }
}

function ticketStatusValue(ticket) {
  return String(ticket?.fields?.status || "");
}

function rememberTicketSnapshot(ticket) {
  if (!ticket?.ref) return;
  watchedTicketSnapshots.set(ticket.ref, {
    updatedAt: ticket.updatedAt || "",
    status: ticketStatusValue(ticket),
    commentCount: Number(ticket.commentCount || 0),
    attachmentCount: Number(ticket.attachmentCount || 0),
  });
}

const TICKET_NOTE_MAX = 60;
const TICKET_NOTE_KEEP_SEEN = 300;
const TICKET_NOTE_READS_PER_POLL = 3;
const TICKET_NOTE_POLL_MS = 15_000;
const TICKET_OPEN_POLL_MS = 8000;
let ticketPollPausedUntil = 0;
function ticketPollBackoff(problem) {
  const text = String(problem?.message ?? problem ?? "");
  if (!/busy|request limit/i.test(text)) return;
  const seconds = Number((/Try again in (\d+) s/.exec(text) || [])[1]) || 30;
  ticketPollPausedUntil = Date.now() + seconds * 1000 + 2000;
}
let ticketNoteStore = null;
let ticketNoteStoreKey = "";
let ticketNoteTab = "all";
let ticketBellOpen = false;
let ticketNotePolling = false;
let ticketNoteAudio = null;

function ticketNoteLoad() {
  const key = `rc-ticket-notes:${currentLiveChatAccount || ""}`;
  if (ticketNoteStore && ticketNoteStoreKey === key) return ticketNoteStore;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(key) || "null"); } catch (_) { saved = null; }
  ticketNoteStore = { me: { email: "", id: null }, seen: {}, mine: [], items: [], sound: true, startedAt: 0, ...(saved && typeof saved === "object" ? saved : {}) };
  ticketNoteStoreKey = key;
  return ticketNoteStore;
}

function ticketNoteSave() {
  if (!ticketNoteStore) return;
  try { localStorage.setItem(ticketNoteStoreKey, JSON.stringify(ticketNoteStore)); } catch (_) { }
}

function ticketNotePeople(ticket) {
  return [ticket?.raisedBy, ...(Array.isArray(ticket?.assignees) ? ticket.assignees : [])].filter(Boolean);
}

function ticketNoteIsMine(store, ticket) {
  const email = store.me.email;
  return ticketNoteMineRefs.has(ticket.ref) || store.mine.includes(ticket.ref) || (Boolean(email) && ticketNotePeople(ticket).some((person) => String(person.email || "").toLowerCase() === email));
}

function ticketNoteLearnMe(store, tickets) {
  if (store.me.id != null || !store.me.email) return;
  for (const ticket of tickets) {
    const me = ticketNotePeople(ticket).find((person) => person.id != null && String(person.email || "").toLowerCase() === store.me.email);
    if (me) { store.me.id = me.id; return; }
  }
}

function ticketNoteRemember(ref, authorId) {
  const store = ticketNoteLoad();
  if (ref && !store.mine.includes(ref)) store.mine = [ref, ...store.mine].slice(0, TICKET_NOTE_KEEP_SEEN);
  if (authorId != null && store.me.id == null) store.me.id = authorId;
  ticketNoteSave();
}

function ticketNoteSnapshot(ticket, at) {
  return { updatedAt: ticket.updatedAt || "", commentCount: Number(ticket.commentCount || 0), status: String(ticket.fields?.status || ""), at };
}

function ticketNoteAdd(store, item) {
  if (store.items.some((existing) => existing.id === item.id)) return 0;
  store.items = [{ ...item, read: false }, ...store.items].slice(0, TICKET_NOTE_MAX);
  return 1;
}

function ticketNoteSnippet(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > 90 ? `${clean.slice(0, 89)}…` : clean;
}

function ticketNoteFlatten(comments) {
  return (Array.isArray(comments) ? comments : []).flatMap((comment) => [comment, ...ticketNoteFlatten(comment.replies)]);
}

function ticketNoteStatusItem(ticket, status, now) {
  return { id: `${ticket.ref}:s${ticket.updatedAt || now}`, ref: ticket.ref, title: ticketTitle(ticket), kind: "status", by: "", text: `Status changed to ${status ? ticketChoiceDisplayLabel("status", status) : "blank"}`, at: now };
}

function ticketNoteDue(store, tickets, now) {
  ticketNoteLearnMe(store, tickets);
  if (!store.startedAt) {
    store.startedAt = tickets.reduce((newest, ticket) => Math.max(newest, Date.parse(ticket.updatedAt) || 0), 0) || now;
    for (const ticket of tickets) store.seen[ticket.ref] = ticketNoteSnapshot(ticket, Date.parse(ticket.updatedAt) || store.startedAt);
    return { due: [], added: 0 };
  }
  const mineDue = [];
  const otherDue = [];
  let added = 0;
  for (const ticket of tickets) {
    const prev = store.seen[ticket.ref];
    const next = ticketNoteSnapshot(ticket, prev ? prev.at : store.startedAt);
    const changed = prev ? (prev.updatedAt !== next.updatedAt || prev.commentCount !== next.commentCount) : Date.parse(next.updatedAt) > store.startedAt;
    if (!changed) { if (!prev) store.seen[ticket.ref] = next; continue; }
    const moreComments = next.commentCount > (prev ? prev.commentCount : 0);
    if (ticketNoteIsMine(store, ticket)) {
      if (moreComments) { mineDue.push(ticket.ref); continue; }
      if (prev && prev.status !== next.status) added += ticketNoteAdd(store, ticketNoteStatusItem(ticket, next.status, now));
    } else if (moreComments && store.me.id != null) {
      otherDue.push(ticket.ref);
      continue;
    }
    store.seen[ticket.ref] = next;
  }
  const keep = Object.keys(store.seen);
  if (keep.length > TICKET_NOTE_KEEP_SEEN) {
    const listed = new Set(tickets.map((ticket) => ticket.ref));
    for (const ref of keep) if (!listed.has(ref)) delete store.seen[ref];
  }
  return { due: [...mineDue, ...otherDue], added };
}

function ticketNoteApplyThread(store, ticket, now) {
  const prev = store.seen[ticket.ref];
  const cutoff = prev ? prev.at : store.startedAt;
  const mine = ticketNoteIsMine(store, ticket);
  const title = ticketTitle(ticket);
  let added = 0;
  let latest = cutoff;
  for (const comment of ticketNoteFlatten(ticket.comments)) {
    const when = Date.parse(comment.createdAt) || 0;
    latest = Math.max(latest, when);
    if (comment.deleted || when <= cutoff) continue;
    if (store.me.id != null && String(comment.author?.id) === String(store.me.id)) continue;
    const mentioned = store.me.id != null && (comment.mentions || []).some((mention) => String(mention.userId) === String(store.me.id));
    if (!mentioned && !mine) continue;
    added += ticketNoteAdd(store, {
      id: `${ticket.ref}:c${comment.id}`, ref: ticket.ref, title, kind: mentioned ? "mention" : "comment",
      by: comment.author?.name || "Someone", text: ticketNoteSnippet(comment.body) || (comment.attachments?.length ? "Sent a file" : "Comment added"), at: when || now,
    });
  }
  const next = ticketNoteSnapshot(ticket, latest);
  if (mine && prev && prev.status !== next.status) added += ticketNoteAdd(store, ticketNoteStatusItem(ticket, next.status, now));
  store.seen[ticket.ref] = next;
  return added;
}

function ticketNoteMarkRead(ref) {
  const store = ticketNoteLoad();
  let changed = false;
  for (const item of store.items) {
    if (!item.read && (!ref || item.ref === ref)) { item.read = true; changed = true; }
  }
  if (changed) ticketNoteSave();
  return changed;
}

function ticketNoteUnread(store) {
  return store.items.filter((item) => !item.read).length;
}

function ticketNoteVisible(store, tab) {
  return store.items.filter((item) => tab === "mentions" ? item.kind === "mention" : tab === "comments" ? item.kind === "comment" || item.kind === "mention" : true);
}

function ticketNoteAudioReady() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ticketNoteAudio = ticketNoteAudio || new Ctx();
    if (ticketNoteAudio.state === "suspended") ticketNoteAudio.resume();
    return ticketNoteAudio;
  } catch (_) { return null; }
}

function ticketNoteChime() {
  const ctx = ticketNoteAudioReady();
  if (!ctx) return;
  try {
    for (const [frequency, delay] of [[880, 0], [1318.5, 0.16]]) {
      const start = ctx.currentTime + delay;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.55);
    }
  } catch (_) { }
}
document.addEventListener("pointerdown", () => { ticketNoteAudioReady(); }, { once: true });

function renderTicketBell(chatId) {
  const store = ticketNoteLoad();
  const unread = ticketNoteUnread(store);
  const count = unread > 99 ? "99+" : String(unread);
  const button = `<button type="button" class="ticket-inbox-notifications" data-action="toggleTicketBell" data-chat="${escapeHtml(chatId)}" aria-label="Ticket notifications, ${unread} unread" aria-expanded="${ticketBellOpen}">${ticketUiIcon("bell")}${unread ? `<span class="ticket-bell-count">${count}</span>` : ""}</button>`;
  if (!ticketBellOpen) return button;
  const items = ticketNoteVisible(store, ticketNoteTab);
  const tabs = [["all", "All"], ["mentions", "@ Mentions"], ["comments", "Comments"]];
  const row = (item) => `<button type="button" class="ticket-bell-row ${item.read ? "" : "unread"}" data-action="openTicketResult" data-chat="${escapeHtml(chatId)}" data-ref="${escapeHtml(item.ref)}">
      <span class="ticket-bell-top"><span class="ticket-inbox-ref">${escapeHtml(item.ref)}</span><small>${escapeHtml(ticketUpdatedLabel({ updatedAt: new Date(item.at).toISOString() }))}</small></span>
      <strong>${escapeHtml(item.title)}</strong>
      <span class="ticket-bell-text">${item.by ? `${escapeHtml(item.by)}: ` : ""}${item.kind === "mention" ? "mentioned you · " : ""}${escapeHtml(item.text)}</span>
    </button>`;
  return `${button}<div class="ticket-bell-panel" role="dialog" aria-label="Ticket notifications">
    <div class="ticket-bell-tabs">${tabs.map(([value, label]) => `<button type="button" class="ticket-inbox-filter ${ticketNoteTab === value ? "selected" : ""}" aria-pressed="${ticketNoteTab === value}" data-action="ticketNoteTab" data-chat="${escapeHtml(chatId)}" data-value="${value}">${label}</button>`).join("")}</div>
    <div class="ticket-bell-list">${items.length ? items.map(row).join("") : '<p class="ticket-inbox-empty">No notifications yet. You will see comments on your tickets and anywhere you are mentioned.</p>'}</div>
    <div class="ticket-bell-foot"><button type="button" class="ticket-inbox-text-button" data-action="ticketNoteReadAll" data-chat="${escapeHtml(chatId)}" ${unread ? "" : "disabled"}>Mark all read</button><button type="button" class="ticket-inbox-text-button" data-action="ticketNoteSound" data-chat="${escapeHtml(chatId)}" aria-pressed="${store.sound !== false}">Sound: ${store.sound !== false ? "on" : "off"}</button></div>
  </div>`;
}

function paintTicketsTabBadge() {
  const tab = document.getElementById("ticketsTab");
  if (!tab) return;
  const unread = ticketNoteUnread(ticketNoteLoad());
  let badge = tab.querySelector(".tab-badge");
  if (!unread) { badge?.remove(); return; }
  if (!badge) { badge = document.createElement("span"); badge.className = "tab-badge"; tab.appendChild(badge); }
  badge.textContent = unread > 99 ? "99+" : String(unread);
}

function repaintTicketBell() {
  document.querySelectorAll(".ticket-bell").forEach((element) => { element.innerHTML = renderTicketBell(element.dataset.chat); });
  paintTicketsTabBadge();
}

function ticketNoteAbsorb(ticket) {
  if (!ticket?.ref) return;
  const store = ticketNoteLoad();
  if (!store.startedAt) return;
  ticketNoteLearnMe(store, [ticket]);
  ticketNoteApplyThread(store, ticket, Date.now());
  ticketNoteMarkRead(ticket.ref);
  ticketNoteSave();
  repaintTicketBell();
}

let ticketNotePollInfo = { at: 0, watching: 0, error: "" };
let ticketNotePollRound = 0;
let ticketNoteMineRefs = new Set();
async function pollTicketNotifications() {
  if (document.hidden || ticketNotePolling || Date.now() < ticketPollPausedUntil || !(previewMode || DEPARTMENT_TABS_LIVE)) return;
  const author = ticketReadAuthor(null);
  if (!author) return;
  ticketNotePolling = true;
  try {
    if (ticketAccount.status === "unknown" && !ticketAccount.checking) {
      if (!Object.keys(state).length) ensureChatState(ticketsOnlyChat());
      const chatId = Object.keys(state)[0];
      if (chatId) await checkTicketAccount(chatId, { quiet: true });
    }
    if (ticketAccount.status !== "found" || !ticketAccount.email) { ticketNotePollInfo = { at: Date.now(), watching: 0, error: ticketAccount.status === "unknown" ? "The ticket account has not been checked yet." : "The ticket account is not available, so tickets cannot be watched." }; return; }
    const store = ticketNoteLoad();
    store.me.email = String(ticketAccount.email).trim().toLowerCase();
    const readList = async (extra) => (await fetch("/ticket-list", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: "", fresh: false, author, ...extra }) })).json();
    const everyone = ticketNotePollRound % 4 === 0;
    ticketNotePollRound += 1;
    const [mineList, allList] = await Promise.all([readList({ mine: true, size: 250, sort: "created" }), everyone ? readList({}) : null]);
    const failure = (!mineList.ok && mineList.error) || (allList && !allList.ok && allList.error) || "";
    if (!mineList.ok && !(allList && allList.ok)) { ticketPollBackoff(failure); ticketNotePollInfo = { at: Date.now(), watching: 0, error: failure || "The ticket list could not be read." }; return; }
    if (mineList.ok) ticketNoteMineRefs = new Set((mineList.tickets || []).map((ticket) => ticket.ref));
    const byRef = new Map();
    for (const ticket of [...(allList?.ok ? allList.tickets || [] : []), ...(mineList.ok ? mineList.tickets || [] : [])]) if (!byRef.has(ticket.ref)) byRef.set(ticket.ref, ticket);
    const tickets = [...byRef.values()];
    ticketNotePollInfo = { at: Date.now(), watching: tickets.length, error: failure ? `Part of the list could not be read: ${failure}` : "" };
    const { due, added: fromList } = ticketNoteDue(store, tickets, Date.now());
    let added = fromList;
    for (const ref of due.slice(0, TICKET_NOTE_READS_PER_POLL)) {
      const thread = await (await fetch("/ticket-status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref, fresh: false, author }) })).json();
      if (thread.ok) added += ticketNoteApplyThread(store, thread.ticket, Date.now());
    }
    ticketNoteSave();
    repaintTicketBell();
    if (added) {
      const newest = store.items[0];
      showChatToast(`${added > 1 ? `${added} new ticket notifications · ` : ""}${newest.ref} · ${newest.by ? `${newest.by}: ` : ""}${newest.kind === "mention" ? "mentioned you · " : ""}${newest.text}`, "info");
      if (store.sound !== false) ticketNoteChime();
    }
  } catch (err) { ticketPollBackoff(err); ticketNotePollInfo = { at: Date.now(), watching: 0, error: err.message || "The poll failed." }; }
  finally { ticketNotePolling = false; }
}
setInterval(pollTicketNotifications, TICKET_NOTE_POLL_MS);
setTimeout(() => void pollTicketNotifications(), 8000);
for (const type of ["pointerdown", "keydown"]) document.addEventListener(type, () => { ticketNoteAudioReady(); }, { once: true, passive: true });
document.addEventListener("visibilitychange", () => { if (!document.hidden) void pollTicketNotifications(); });
document.addEventListener("click", (event) => {
  if (!ticketBellOpen || event.composedPath().some((element) => element.classList?.contains("ticket-bell"))) return;
  ticketBellOpen = false;
  repaintTicketBell();
});

function ticketFieldFor(spec) {
  return ticketFields.find((field) => spec.keys.includes(field.key))
    || ticketFields.find((field) => spec.labels.some((label) => label.toLowerCase() === String(field.label).toLowerCase()));
}

function claimedProgramsFromSavedCase(row) {
  const claimed = {};
  const inquiries = row.inquiry || [];
  if (!row.claimSecret && String(row.status || "").trim().toLowerCase() !== "given") return claimed;
  for (const [key, inquiry] of Object.entries(BONUS_INQUIRY_MAP)) {
    if (inquiries.includes(inquiry)) claimed[key] = true;
  }
  for (const config of configuredBonusPrograms) {
    if (inquiries.includes(config.inquiry)) claimed[config.key] = true;
  }
  if (inquiries.some((inquiry) => String(inquiry).startsWith(HALLOWEEN_INQUIRY_PREFIX))) claimed.halloween = true;
  return claimed;
}

function ticketChoiceSlug(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function ticketChoiceDisplayLabel(fieldKey, rawValue, rawLabel = rawValue) {
  const liveOption = (ticketFields.find((field) => field.key === fieldKey)?.options || []).find((option) => String(option.value) === String(rawValue));
  if (liveOption?.label && String(liveOption.label) !== String(liveOption.value)) return String(liveOption.label);
  const fallback = TICKET_FALLBACK_OPTIONS[fieldKey] || [];
  const candidates = [rawValue, rawLabel].map(ticketChoiceSlug);
  const compactCandidates = candidates.map((value) => value.replaceAll("_", ""));
  for (const option of fallback) {
    const value = Array.isArray(option) ? option[0] : option;
    const label = Array.isArray(option) ? option[1] : option;
    const aliases = [ticketChoiceSlug(value), ticketChoiceSlug(label)];
    if (aliases.some((alias) => candidates.includes(alias) || compactCandidates.includes(alias.replaceAll("_", "")))) return String(label);
  }
  const raw = String(rawLabel || rawValue || "").trim();
  if (!raw.includes("_") && !/^[a-z]+\d+$/i.test(raw)) return raw;
  if (/^[a-z]+\d+$/i.test(raw)) return raw.toUpperCase();
  return raw.split("_").filter(Boolean).map((word) => word.toUpperCase()).join(" ");
}

function ticketFieldOptions(field) {
  const liveOptions = field?.options || [];
  const fallbackKey = ({ brand: "member_platform", level: "member_level", vip_level: "member_level" })[field?.key] || field?.key;
  const fallback = TICKET_FALLBACK_OPTIONS[fallbackKey] || [];
  const seen = new Set();
  return [...liveOptions, ...fallback]
    .filter((option) => option?.isActive !== false)
    .map((option) => {
      if (typeof option === "string") return { value: option, label: option };
      if (Array.isArray(option)) return { value: option[0], label: option[1] || option[0] };
      const value = option.value;
      return { value, label: ticketChoiceDisplayLabel(fallbackKey, value, option.label || value) };
    })
    .filter((option) => option.value !== undefined && option.value !== null)
    .filter((option) => {
      const key = String(option.label || option.value).trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function renderTicketChoice(chatId, stateKey, value, options, { placeholder = "Please select", allowEmpty = true } = {}) {
  const normalized = options.map((option) => typeof option === "string"
    ? { value: option, label: option }
    : { value: String(option.value ?? ""), label: String(option.label ?? option.value ?? "") });
  let selected = normalized.find((option) => option.value === String(value)
    || option.label.toLowerCase() === String(value).toLowerCase());
  if (value && !selected) {
    normalized.unshift({ value: String(value), label: String(value) });
    selected = normalized[0];
  }
  const selectedValue = selected?.value;
  return `<div class="ticket-choice" data-ticket-choice="${escapeHtml(stateKey)}">
    <button type="button" id="ticket-field-${escapeHtml(chatId)}-${escapeHtml(stateKey)}" class="input ticket-choice-trigger" data-action="toggleTicketChoice" data-chat="${escapeHtml(chatId)}" aria-haspopup="listbox" aria-expanded="false">
      <span class="${selected ? "" : "ticket-choice-placeholder"}">${escapeHtml(selected?.label || placeholder)}</span>
      <span class="ticket-choice-chevron">⌄</span>
    </button>
    <div class="ticket-choice-menu hidden" role="listbox">
      <div class="ticket-choice-search-wrap"><input type="search" class="input ticket-choice-search" placeholder="Search options…" autocomplete="off" /></div>
      <div class="ticket-choice-options">
        ${allowEmpty ? `<button type="button" class="ticket-choice-option ${!value ? "selected" : ""}" data-action="selectTicketChoice" data-chat="${escapeHtml(chatId)}" data-field="${escapeHtml(stateKey)}" data-value="" data-search="${escapeHtml(placeholder.toLowerCase())}">${escapeHtml(placeholder)}</button>` : ""}
        ${normalized.map((option) => `<button type="button" class="ticket-choice-option ${String(option.value) === String(selectedValue) ? "selected" : ""}" data-action="selectTicketChoice" data-chat="${escapeHtml(chatId)}" data-field="${escapeHtml(stateKey)}" data-value="${escapeHtml(option.value)}" data-search="${escapeHtml(option.label.toLowerCase())}">${escapeHtml(option.label)}${String(option.value) === String(selectedValue) ? "<span>✓</span>" : ""}</button>`).join("")}
      </div>
      <div class="ticket-choice-empty hidden">No matching option</div>
    </div>
  </div>`;
}

function renderTicketInput(chatId, spec) {
  const field = ticketFieldFor(spec);
  if (!field || field.type === "ATTACHMENT") return "";
  const s = state[chatId];
  const value = s.escalation[spec.stateKey] ?? "";
  const required = spec.required || field.required || field.isRequired;
  const label = `${escapeHtml(field.label)}${required ? " *" : ""}`;
  const controlId = `ticket-field-${escapeHtml(chatId)}-${escapeHtml(spec.stateKey)}`;
  const options = ticketFieldOptions(field);
  let control;

  if (options.length) {
    control = renderTicketChoice(chatId, spec.stateKey, value, options, {
      placeholder: required && !field.defaultValue ? "Please select" : "Use ticket default",
      allowEmpty: !required || Boolean(field.defaultValue),
    });
  } else if (field.type === "LONGTEXT" || spec.stateKey === "remarks") {
    control = `<textarea id="${controlId}" class="input esc-input" data-chat="${escapeHtml(chatId)}" data-field="${spec.stateKey}" placeholder="Type here" rows="2">${escapeHtml(value)}</textarea>`;
  } else {
    const numeric = field.type === "NUMBER" || field.type === "CURRENCY";
    control = `<input id="${controlId}" type="text"${numeric ? ' inputmode="decimal" data-ticket-numeric="true"' : ""} class="input mono esc-input" data-chat="${escapeHtml(chatId)}" data-field="${spec.stateKey}" value="${escapeHtml(value)}" placeholder="Type here" />`;
  }

  return `<div class="escalation-field ${spec.stateKey === "remarks" ? "escalation-field-wide" : ""}">
    <label class="field-label" for="${controlId}">${label}</label>${control}
  </div>`;
}

function ticketFieldLabel(key) {
  return ticketFields.find((field) => field.key === key)?.label || key.replaceAll("_", " ");
}

function ticketFieldDisplay(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === "object" ? item?.name || item?.label || "Attached file" : item).join(", ");
  }
  if (typeof value === "object") return value.name || value.label || value.code || "—";
  return String(value);
}

function ticketValueDisplay(key, value) {
  const choiceKey = ({ brand: "member_platform", level: "member_level", vip_level: "member_level" })[key] || key;
  const field = ticketFields.find((item) => item.key === key);
  const isChoice = Boolean(TICKET_FALLBACK_OPTIONS[choiceKey]) || field?.type === "SELECT" || field?.type === "MULTISELECT";
  if (!isChoice) return ticketFieldDisplay(value);
  const label = (item) => (typeof item === "string" && item.trim() ? ticketChoiceDisplayLabel(choiceKey, item) : ticketFieldDisplay(item));
  return Array.isArray(value) ? (value.length ? value.map(label).join(", ") : "—") : label(value);
}

function renderTicketSearchResults(chatId) {
  return renderTicketExplorer(chatId);
}

function ticketPeople(ticket) {
  return [ticket.raisedBy, ...(Array.isArray(ticket.assignees) ? ticket.assignees : [])]
    .map((person) => person?.name || person?.email).filter(Boolean);
}

function ticketWorkspaceView(s) {
  return ["list", "detail", "create"].includes(s.ticketView) ? s.ticketView : "list";
}

function ticketStatusTone(ticket) {
  const status = ticketStatusValue(ticket).trim().toUpperCase().replace(/[ _-]+/g, "_");
  if (status.includes("UNSOLVED")) return "active";
  if (/SOLVED|CLOSED|DONE|VOID/.test(status)) return "solved";
  if (/PROGRESS|PROCESSING/.test(status)) return "progress";
  return "active";
}

function ticketStatusLabel(ticket) {
  const value = ticketStatusValue(ticket);
  if (!value) return "No status";
  return ticketChoiceDisplayLabel("status", value);
}

function ticketTitle(ticket) {
  return ticket.fields?.query_type ? ticketValueDisplay("query_type", ticket.fields.query_type) : ticketFieldDisplay(ticket.fields?.title || "Ticket");
}

function ticketRaisedByLabel(ticket) {
  return ticket?.raisedBy?.name || ticket?.raisedBy?.email || "";
}

function ticketRaisedDateLabel(ticket) {
  const date = new Date(ticket?.createdAt);
  if (!ticket?.createdAt || !Number.isFinite(date.getTime())) return "";
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function ticketUpdatedLabel(ticket) {
  const date = new Date(ticket.updatedAt || ticket.createdAt);
  if (!Number.isFinite(date.getTime())) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return minutes + " min ago";
  if (minutes < 1440) return Math.floor(minutes / 60) + "h ago";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function ticketUiIcon(name) {
  const paths = {
    search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 4 4"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    back: '<path d="m7 3-5 5 5 5M2 8h12"/>',
    refresh: '<path d="M13 5A6 6 0 1 0 13 11M13 1v4H9"/>',
    bell: '<path d="M3 11h10l-1.5-2V6A3.5 3.5 0 0 0 4.5 6v3L3 11ZM6 13h4"/>',
    filter: '<path d="M2 4h12M4 8h8M6 12h4"/>',
  };
  return `<svg class="ticket-ui-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ""}</svg>`;
}

function renderTicketSlot(chatId) {
  const slot = chatListEl.querySelector(`.chat-card[data-chat-id="${chatId}"] .escalation-slot`);
  if (!slot) return;
  const focus = captureFocus();
  slot.innerHTML = renderEscalationSection(chatId);
  restoreFocus(focus);
}

async function refreshTicketInbox(chatId, query = "", mode = "all", { fresh = true } = {}) {
  if (ticketSearchResultsByChat.get(chatId)?.loading) return;
  const pending = searchTickets(chatId, query, mode, { fresh });
  renderTicketSlot(chatId);
  try {
    await pending;
  } catch (error) {
    ticketSearchResultsByChat.set(chatId, { loading: false, tickets: [], error: error.message, mode });
  }
  renderTicketSlot(chatId);
  if (ticketListStale(chatId)) {
    const loaded = ticketSearchResultsByChat.get(chatId);
    await refreshTicketInbox(chatId, loaded.query || "", loaded.mode || "all", { fresh: false });
  }
}

const TICKET_BULK_MAX = 60;
const ticketBulkByChat = new Map();
function ticketBulkFor(chatId) {
  if (!ticketBulkByChat.has(chatId)) ticketBulkByChat.set(chatId, { selected: [], status: "", running: false, progress: "", summary: "", visibleRefs: [] });
  return ticketBulkByChat.get(chatId);
}
function ticketBulkStatusOptions() {
  const field = ticketFieldFor(TICKET_FIELD_SPECS.find((spec) => spec.stateKey === "status"));
  return field ? ticketFieldOptions(field) : [];
}
function ticketBulkToggle(chatId, ref, on) {
  const bulk = ticketBulkFor(chatId);
  const without = bulk.selected.filter((item) => item !== ref);
  bulk.selected = on ? [...without, ref].slice(0, TICKET_BULK_MAX) : without;
  if (on && !bulk.selected.includes(ref)) bulk.summary = `At most ${TICKET_BULK_MAX} tickets can be changed at a time.`;
  else bulk.summary = "";
}
function ticketBulkSelectAll(chatId) {
  const bulk = ticketBulkFor(chatId);
  const shown = bulk.visibleRefs.slice(0, TICKET_BULK_MAX);
  const all = shown.length > 0 && shown.every((ref) => bulk.selected.includes(ref));
  bulk.selected = all ? [] : shown;
  bulk.summary = !all && bulk.visibleRefs.length > TICKET_BULK_MAX ? `The first ${TICKET_BULK_MAX} of ${bulk.visibleRefs.length} tickets were ticked (the most that can be changed at a time).` : "";
}
function ticketNoteSeen(ticket) {
  const store = ticketNoteLoad();
  if (!store.startedAt || !ticket?.ref) return;
  const prev = store.seen[ticket.ref];
  store.seen[ticket.ref] = ticketNoteSnapshot(ticket, prev ? prev.at : store.startedAt);
  ticketNoteSave();
}
async function applyBulkStatus(chatId) {
  const s = state[chatId];
  const bulk = ticketBulkFor(chatId);
  const result = ticketActiveList(chatId);
  if (!s || !result?.tickets || bulk.running || !bulk.status) return;
  const targets = bulk.selected.map((ref) => result.tickets.find((ticket) => ticket.ref === ref)).filter(Boolean);
  if (!targets.length) return;
  const label = ticketChoiceDisplayLabel("status", bulk.status);
  bulk.running = true;
  bulk.summary = "";
  const changed = [];
  const already = [];
  const failed = [];
  let stoppedBecause = "";
  try {
    for (const [index, ticket] of targets.entries()) {
      const current = ticket.fields?.status;
      if (String(current ?? "") === bulk.status) { already.push(ticket.ref); continue; }
      bulk.progress = `Updating ${index + 1} of ${targets.length}…`;
      renderTicketSlot(chatId);
      let res;
      let data;
      try {
        res = await fetch("/ticket-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: ticket.ref, fields: { status: bulk.status }, expect: { status: current === undefined ? null : current }, author: ticketAuthor(s) }) });
        data = await res.json();
      } catch (err) {
        failed.push({ ref: ticket.ref, reason: err.message });
        stoppedBecause = "The ticket system could not be reached.";
        break;
      }
      if (!data.ok) {
        failed.push({ ref: ticket.ref, reason: data.code === "precondition_failed" ? "someone changed it first" : (data.error || "refused") });
        if (res.status === 429 || res.status === 401 || data.needTicketEmail || ["key_access", "key_standing", "forbidden", "field_forbidden", "validation_failed", "invalid_body"].includes(data.code)) { stoppedBecause = data.error || "The ticket system refused the change."; break; }
        continue;
      }
      noteTicketAccountUsed(data);
      changed.push(ticket.ref);
      const whole = ticketSearchResultsByChat.get(chatId);
      const entry = data.visible && data.ticket ? (({ comments: _thread, ...rest }) => rest)(data.ticket) : null;
      for (const list of [whole?.tickets, whole?.mine?.tickets].filter(Array.isArray)) {
        const at = list.findIndex((item) => item.ref === ticket.ref);
        if (at < 0) continue;
        if (entry) list[at] = entry; else list.splice(at, 1);
      }
      if (entry) ticketNoteSeen(entry);
    }
  } finally {
    bulk.running = false;
    bulk.progress = "";
    bulk.selected = bulk.selected.filter((ref) => !changed.includes(ref) && !already.includes(ref));
    bulk.summary = [
      changed.length ? `Set ${changed.length} ticket${changed.length === 1 ? "" : "s"} to ${label}.` : "No ticket was changed.",
      already.length ? `${already.length} already had it.` : "",
      failed.length ? `${failed.length} not changed: ${failed.slice(0, 3).map((item) => `${item.ref} (${item.reason})`).join("; ")}${failed.length > 3 ? "…" : ""}.` : "",
      stoppedBecause ? `Stopped: ${stoppedBecause}` : "",
    ].filter(Boolean).join(" ");
    renderTicketSlot(chatId);
  }
}

const TICKET_FILTER_ME = "@me";
function ticketMatchesAgent(ticket, agent) {
  if (!agent || agent === "all") return true;
  if (agent === TICKET_FILTER_ME) return ticketIsMine(ticket);
  if (/^#\d+$/.test(agent)) return [ticket.raisedBy, ...(Array.isArray(ticket.assignees) ? ticket.assignees : [])].some((person) => person && String(person.id) === agent.slice(1));
  return ticketPeople(ticket).includes(agent);
}

let ticketAgentRoster = { agents: [], at: 0, loading: false, error: "" };
const TICKET_ROSTER_MAX_AGE_MS = 10 * 60_000;
async function loadTicketAgentRoster(chatId) {
  if (ticketAgentRoster.loading || (ticketAgentRoster.at && Date.now() - ticketAgentRoster.at < TICKET_ROSTER_MAX_AGE_MS)) return;
  ticketAgentRoster = { ...ticketAgentRoster, loading: true, error: "" };
  renderTicketSlot(chatId);
  try {
    const author = ticketReadAuthor(state[chatId]);
    const res = author
      ? await fetch("/ticket-agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ author }) })
      : await fetch("/ticket-agents");
    const data = await res.json();
    if (!data.ok) throw ticketReadFailure(chatId, data, "The agent list could not be loaded");
    ticketAgentRoster = { agents: Array.isArray(data.agents) ? data.agents : [], at: Date.now(), loading: false, error: "" };
  } catch (err) {
    ticketAgentRoster = { ...ticketAgentRoster, loading: false, error: err.message };
  }
  renderTicketSlot(chatId);
}

function ticketIsMine(ticket) {
  const store = ticketNoteLoad();
  const email = String(ticketAccount.email || store.me.email || "").trim().toLowerCase();
  return store.mine.includes(ticket.ref) || (Boolean(email) && ticketNotePeople(ticket).some((person) => String(person.email || "").toLowerCase() === email));
}

function renderTicketBulkBar(chatId, filtered) {
  const bulk = ticketBulkFor(chatId);
  bulk.visibleRefs = filtered.map((ticket) => ticket.ref);
  const shown = new Set(bulk.visibleRefs);
  bulk.selected = bulk.selected.filter((ref) => shown.has(ref));
  if (!filtered.length) return "";
  const picked = bulk.selected.length;
  const all = bulk.visibleRefs.slice(0, TICKET_BULK_MAX).every((ref) => bulk.selected.includes(ref));
  const options = ticketBulkStatusOptions();
  const chat = escapeHtml(chatId);
  return `<div class="ticket-bulk-bar">
    <button type="button" class="ticket-inbox-text-button" data-action="bulkSelectAll" data-chat="${chat}" ${bulk.running ? "disabled" : ""}>${all && picked ? "Clear selection" : "Select all"}</button>
    ${picked ? `<span class="ticket-bulk-count">${picked} selected</span>
    <div class="ticket-bulk-status">${renderTicketChoice(chatId, "bulk:status", bulk.status, options, { placeholder: "Set status to…", allowEmpty: true })}</div>
    <button type="button" class="submit-btn ticket-bulk-apply" data-action="bulkApplyStatus" data-chat="${chat}" ${bulk.running || !bulk.status ? "disabled" : ""}>${bulk.running ? escapeHtml(bulk.progress || "Updating…") : `Update ${picked}`}</button>` : ""}
    ${bulk.summary && !bulk.running ? `<div class="ticket-bulk-summary" role="status">${escapeHtml(bulk.summary)}</div>` : ""}
  </div>`;
}

function renderTicketExplorer(chatId) {
  const s = state[chatId];
  const result = ticketSearchResultsByChat.get(chatId);
  const list = ticketActiveList(chatId);
  const tickets = list?.tickets || [];
  const serverMine = Boolean(ticketScopedWho(s.ticketExplorerAgent) && result?.mine && result.mineFor === s.ticketExplorerAgent);
  const unique = values => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const rosterNames = new Map(ticketAgentRoster.agents.map(person => [`#${person.id}`, person.name]));
  const agents = rosterNames.size ? [...rosterNames.keys()].sort((a, b) => rosterNames.get(a).localeCompare(rosterNames.get(b))) : unique((result?.tickets || []).flatMap(ticketPeople));
  const agentLabel = value => rosterNames.get(value) || value;
  const statuses = unique([...ticketBulkStatusOptions().map(option => String(option.value)), ...tickets.map(ticketStatusValue)])
    .sort((a, b) => ticketChoiceDisplayLabel("status", a).localeCompare(ticketChoiceDisplayLabel("status", b)));
  const departments = unique([...ticketDepartments.map(item => item.name || item.code), ...tickets.map(ticket => ticket.currentDepartment?.name || ticket.currentDepartment?.code)]);
  const markets = unique([...ticketMarkets.map(item => item.label || item.code), ...tickets.map(ticket => ticket.market?.label || ticket.market?.code)]);
  const effective = (key, values) => (!s[key] || s[key] === "all" || values.includes(s[key]) ? (s[key] || "all") : "all");
  const statusFilter = effective("ticketExplorerStatus", statuses);
  const departmentFilter = effective("ticketExplorerDepartment", departments);
  const marketFilter = effective("ticketExplorerMarket", markets);
  const matches = (value, filter) => !filter || filter === "all" || String(value || "") === filter;
  const group = s.ticketInboxFilter || "all";
  const filtered = tickets.filter(ticket =>
    (group === "all" || (group === "solved" ? ticketStatusTone(ticket) === "solved" : ticketStatusTone(ticket) !== "solved"))
    && (serverMine || ticketMatchesAgent(ticket, s.ticketExplorerAgent))
    && matches(ticketStatusValue(ticket), statusFilter)
    && matches(ticket.currentDepartment?.name || ticket.currentDepartment?.code, departmentFilter)
    && matches(ticket.market?.label || ticket.market?.code, marketFilter));
  const filterChoice = (filterKey, allLabel, values, label = value => value, lead = []) => renderTicketChoice(chatId, `filter:${filterKey}`, ({ ticketExplorerStatus: statusFilter, ticketExplorerDepartment: departmentFilter, ticketExplorerMarket: marketFilter })[filterKey] || s[filterKey] || "all",
    [{ value: "all", label: allLabel }, ...lead, ...values.map(value => ({ value, label: label(value) }))], { allowEmpty: false });
  const activeFilters = [s.ticketExplorerAgent, statusFilter, departmentFilter, marketFilter].filter(value => value && value !== "all").length;
  const counts = { all: tickets.length, active: tickets.filter(ticket => ticketStatusTone(ticket) !== "solved").length, solved: tickets.filter(ticket => ticketStatusTone(ticket) === "solved").length };
  return `<section class="ticket-inbox-list">
    <div class="ticket-inbox-filters" aria-label="Ticket filters">${[["all", "All"], ["active", "Active"], ["solved", "Solved"]].map(([value, label]) => `<button type="button" class="ticket-inbox-filter ${group === value ? "selected" : ""}" aria-pressed="${group === value}" data-action="filterTicketInbox" data-chat="${escapeHtml(chatId)}" data-value="${value}">${label}<span>${counts[value]}</span></button>`).join("")}
      <button type="button" class="ticket-inbox-filter-toggle" data-action="toggleTicketFilters" data-chat="${escapeHtml(chatId)}" aria-label="More ticket filters" aria-expanded="${Boolean(s.ticketFiltersOpen)}">${ticketUiIcon("filter")}${activeFilters ? `<span>${activeFilters}</span>` : ""}</button>
    </div>
    ${s.ticketFiltersOpen ? `<div class="ticket-explorer-filters">
      <div class="ticket-explorer-field"><span>Agent</span>${filterChoice("ticketExplorerAgent", "All agents", agents, agentLabel, [{ value: TICKET_FILTER_ME, label: "Me" }])}${ticketAgentRoster.loading ? '<span class="ticket-explorer-note">Loading all agents…</span>' : ""}</div>
      <div class="ticket-explorer-field"><span>Status</span>${filterChoice("ticketExplorerStatus", "All statuses", statuses, value => ticketChoiceDisplayLabel("status", value))}</div>
      <div class="ticket-explorer-field"><span>Department</span>${filterChoice("ticketExplorerDepartment", "All departments", departments)}</div>
      <div class="ticket-explorer-field"><span>Market</span>${filterChoice("ticketExplorerMarket", "All markets", markets)}</div>
      <button type="button" class="ticket-inbox-text-button" data-action="clearTicketFilters" data-chat="${escapeHtml(chatId)}">Clear filters</button>
    </div>` : ""}
    ${!result || result.loading ? '<div class="ticket-inbox-empty" role="status">Loading tickets…</div>' : result.error ? `<div class="record-error-banner">${escapeHtml(result.error)}</div><button type="button" class="secondary-btn" data-action="searchTickets" data-chat="${escapeHtml(chatId)}">Try again</button>` : `
    <div class="ticket-inbox-caption"><span>${filtered.length} ticket${filtered.length === 1 ? "" : "s"}</span><span>Latest update</span></div>
    ${renderTicketBulkBar(chatId, filtered)}
    <div class="ticket-inbox-rows">${filtered.length ? filtered.map(ticket => `<div class="ticket-inbox-row-wrap"><label class="ticket-bulk-check" title="Tick to change several tickets at once"><input type="checkbox" class="ticket-bulk-tick" data-chat="${escapeHtml(chatId)}" data-ref="${escapeHtml(ticket.ref)}" ${ticketBulkFor(chatId).selected.includes(ticket.ref) ? "checked" : ""} ${ticketBulkFor(chatId).running ? "disabled" : ""} aria-label="Select ${escapeHtml(ticket.ref)}" /></label><button type="button" class="ticket-inbox-row" data-action="openTicketResult" data-chat="${escapeHtml(chatId)}" data-ref="${escapeHtml(ticket.ref)}">
      <span class="ticket-inbox-row-top"><span class="ticket-inbox-ref">${escapeHtml(ticket.ref)}</span><span class="ticket-inbox-status ${ticketStatusTone(ticket)}">${escapeHtml(ticketStatusLabel(ticket))}</span></span>
      <strong class="ticket-inbox-row-title">${escapeHtml(ticketTitle(ticket))}</strong>
      <span class="ticket-inbox-row-meta"><span>${escapeHtml(ticket.fields?.member_id || "No player ID")}${ticket.fields?.member_platform || ticket.fields?.brand ? ` · ${escapeHtml(ticketValueDisplay("member_platform", ticket.fields.member_platform || ticket.fields.brand))}` : ""}</span><span>${escapeHtml(ticket.currentDepartment?.name || ticket.currentDepartment?.code || "Unassigned")}</span></span>
      <span class="ticket-inbox-row-meta ticket-inbox-row-raised"><span>${ticketRaisedByLabel(ticket) ? `Raised by ${escapeHtml(ticketRaisedByLabel(ticket))}` : "Raiser unknown"}</span><span>${escapeHtml(ticketRaisedDateLabel(ticket))}</span></span>
      <span class="ticket-inbox-row-bottom"><span>${Number(ticket.commentCount || 0)} comment${Number(ticket.commentCount || 0) === 1 ? "" : "s"}</span><span>${escapeHtml(ticketUpdatedLabel(ticket))}</span></span>
    </button></div>`).join("") : '<div class="ticket-inbox-empty">No tickets match. Try another search or clear the filters.</div>'}</div>
    ${Number(list?.total) > tickets.length ? `<div class="ticket-inbox-limit"><p>Loaded ${tickets.length} of ${Number(list.total)} tickets. ${list.loadingAll ? "Loading the rest…" : "Search to narrow the results, or load them all."}</p>${list.loadingAll ? "" : `<button type="button" class="secondary-btn ticket-load-all" data-action="loadAllTickets" data-chat="${escapeHtml(chatId)}">Load all ${Math.min(Number(list.total), TICKET_PAGE_SIZE * TICKET_LOAD_ALL_MAX_PAGES)} tickets</button>`}${list.loadAllNote ? `<p class="ticket-inbox-limit-error">${escapeHtml(list.loadAllNote)}</p>` : ""}</div>` : ""}`}
  </section>`;
}

const ticketEditByChat = new Map();
const ticketSaveChains = new Map();

function ticketEditFor(chatId, ticket) {
  let edit = ticketEditByChat.get(chatId);
  if (!edit || edit.ref !== ticket.ref) {
    edit = { ref: ticket.ref, typing: {}, saving: 0, error: "", notice: "" };
    ticketEditByChat.set(chatId, edit);
  }
  return edit;
}

function ticketEditableSpecs() {
  return TICKET_FIELD_SPECS.map((spec) => ({ spec, field: ticketFieldFor(spec) })).filter(({ field }) => field && field.type !== "ATTACHMENT");
}

function ticketFieldText(ticket, field) {
  const value = ticket.fields?.[field.key];
  return value === undefined || value === null ? "" : String(value).trim();
}

function buildTicketChange(ticket, change) {
  if (change.type === "field") {
    const spec = TICKET_FIELD_SPECS.find((item) => item.stateKey === change.stateKey);
    const field = spec && ticketFieldFor(spec);
    if (!field || field.type === "ATTACHMENT") return { error: "That field is not on the ticket form." };
    const before = ticket.fields?.[field.key];
    const after = String(change.value ?? "").trim();
    if (after === ticketFieldText(ticket, field)) return { unchanged: true };
    const numeric = field.type === "NUMBER" || field.type === "CURRENCY";
    if (numeric && after !== "" && !Number.isFinite(Number(after))) return { error: `${field.label} must be a number.` };
    return { payload: { fields: { [field.key]: after === "" ? null : numeric ? Number(after) : after }, expect: { [field.key]: before === undefined ? null : before } } };
  }
  if (change.type === "department") {
    const current = ticket.currentDepartment?.code || "";
    if (!change.value || change.value === current) return { unchanged: true };
    return { payload: { toDepartment: change.value, expect: { Department: current } } };
  }
  if (change.type === "market") {
    const current = ticket.market?.code || "";
    const next = change.value || "";
    if (next === current) return { unchanged: true };
    return { payload: { market: next || null, expect: { Market: current || null } } };
  }
  if (change.type === "assigneeAdd") {
    const add = String(change.value || "").split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
    return add.length ? { payload: { assignees: { add, remove: [] } } } : { unchanged: true };
  }
  if (change.type === "assigneeRemove") {
    const id = Number(change.value);
    if (!Number.isInteger(id) || !(ticket.assignees || []).some((person) => Number(person.id) === id)) return { unchanged: true };
    return { payload: { assignees: { add: [], remove: [id] } } };
  }
  return { error: "Unknown change." };
}

function describeTicketChanges(changed) {
  if (!Array.isArray(changed) || !changed.length) return "Nothing needed to change: the ticket already had this value.";
  return changed.map((item) => {
    if (Array.isArray(item.added) || Array.isArray(item.removed)) {
      const names = (list) => (list || []).map((person) => person.name).join(", ");
      return `${item.label || "Assignee"}: ${[item.added?.length ? `+ ${names(item.added)}` : "", item.removed?.length ? `− ${names(item.removed)}` : ""].filter(Boolean).join(" ")}`;
    }
    return `${item.label || item.key}: ${item.fromText || "—"} → ${item.toText || "—"}`;
  }).join(" · ");
}

function ticketChangeFor(name, value) {
  if (name === "departmentCode") return { type: "department", value };
  if (name === "marketCode") return { type: "market", value };
  if (name === "addPeople") return { type: "assigneeAdd", value };
  return { type: "field", stateKey: name, value };
}

function ticketLiveTyping(chatId, name, value) {
  const ticket = state[chatId]?.ticketRecord;
  if (ticket) ticketEditFor(chatId, ticket).typing[name] = value;
}

function ticketForgetTyping(edit, change) {
  delete edit.typing[change.type === "field" ? change.stateKey : change.type === "department" ? "departmentCode" : change.type === "market" ? "marketCode" : change.type === "assigneeAdd" ? "addPeople" : ""];
}

function commitTicketChange(chatId, change) {
  const next = (ticketSaveChains.get(chatId) || Promise.resolve()).then(() => saveTicketChange(chatId, change));
  ticketSaveChains.set(chatId, next);
  return next;
}

async function saveTicketChange(chatId, change) {
  const s = state[chatId];
  const ticket = s?.ticketRecord;
  if (!ticket) return;
  const edit = ticketEditFor(chatId, ticket);
  const built = buildTicketChange(ticket, change);
  if (built.unchanged || built.error) {
    ticketForgetTyping(edit, change);
    if (built.error) edit.error = built.error;
    renderTicketSlot(chatId);
    return;
  }
  edit.saving += 1;
  edit.error = "";
  renderTicketSlot(chatId);
  try {
    const res = await fetch("/ticket-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: ticket.ref, ...built.payload, author: ticketAuthor(s) }) });
    const data = await res.json();
    ticketForgetTyping(edit, change);
    if (!data.ok) {
      if (data.needTicketEmail) {
        s.ticketEmailNeeded = true;
        showTicketProblem(chatId, data, () => void commitTicketChange(chatId, change));
      } else if (data.code === "precondition_failed") {
        const now = (data.mismatched || []).map((item) => `${item.name} is now ${item.actual === null || item.actual === undefined || item.actual === "" ? "empty" : item.actual}`).join(", ");
        edit.notice = "";
        edit.error = `Someone changed this ticket since you opened it${now ? ` (${now})` : ""}. It was reloaded and your edit was not saved: make it again.`;
        try { await loadTicketStatus(chatId, ticket.ref); } catch (_) { }
      } else {
        edit.error = data.error || "The ticket could not be changed.";
      }
      return;
    }
    noteTicketAccountUsed(data);
    if (s.escalation.ticketEmail) storeTicketEmail(currentLiveChatAccount, s.escalation.ticketEmail);
    ticketSearchResultsByChat.delete(chatId);
    if (data.visible && data.ticket) {
      const merged = { ...data.ticket, comments: s.ticketRecord?.comments || ticket.comments || [] };
      s.ticketRecord = merged;
      rememberTicketSnapshot(merged);
      ticketNoteAbsorb(merged);
      edit.notice = describeTicketChanges(data.changed);
    } else {
      s.ticketRecord = null;
      s.ticketView = "list";
      setStatus(`Saved. ${describeTicketChanges(data.changed)} You can no longer see ${ticket.ref}.`, "success");
    }
    saveState();
  } catch (err) {
    ticketForgetTyping(edit, change);
    edit.error = "The ticket could not be changed: " + err.message;
  } finally {
    edit.saving -= 1;
    renderTicketSlot(chatId);
  }
}

function renderTicketEditInput(chatId, spec, field, edit, ticket) {
  const stateKey = `edit:${spec.stateKey}`;
  const value = edit.typing[spec.stateKey] ?? ticketFieldText(ticket, field);
  const options = ticketFieldOptions(field);
  const controlId = `ticket-field-${escapeHtml(chatId)}-${escapeHtml(stateKey)}`;
  let control;
  if (options.length) {
    control = renderTicketChoice(chatId, stateKey, value, options, { placeholder: "Not set", allowEmpty: !(spec.required || field.required || field.isRequired) });
  } else if (field.type === "LONGTEXT" || spec.stateKey === "remarks") {
    control = `<textarea id="${controlId}" class="input esc-input ticket-live-input" data-chat="${escapeHtml(chatId)}" data-field="${stateKey}" rows="3">${escapeHtml(value)}</textarea>`;
  } else {
    const numeric = field.type === "NUMBER" || field.type === "CURRENCY";
    control = `<input id="${controlId}" type="text"${numeric ? ' inputmode="decimal" data-ticket-numeric="true"' : ""} class="input mono esc-input ticket-live-input" data-chat="${escapeHtml(chatId)}" data-field="${stateKey}" value="${escapeHtml(value)}" />`;
  }
  return `<div class="escalation-field ${spec.stateKey === "remarks" ? "escalation-field-wide" : ""}"><label class="field-label" for="${controlId}">${escapeHtml(field.label)}</label>${control}</div>`;
}

function renderTicketEditForm(chatId, ticket) {
  const edit = ticketEditFor(chatId, ticket);
  const departments = ticketDepartments.map((item) => ({ value: String(item.code || item.id), label: item.name || item.code || String(item.id) }));
  const markets = ticketMarkets.map((item) => ({ value: String(item.code || item.id), label: item.label || item.code || String(item.id) }));
  const department = edit.typing.departmentCode ?? (ticket.currentDepartment?.code || "");
  const market = edit.typing.marketCode ?? (ticket.market?.code || "");
  const people = (ticket.assignees || []).map((person) => `<div class="ticket-edit-person"><span>${escapeHtml(person.name || person.email || "Someone")}</span><button type="button" class="ticket-inbox-text-button" data-action="removeTicketAssignee" data-chat="${escapeHtml(chatId)}" data-id="${escapeHtml(person.id)}" aria-label="Take ${escapeHtml(person.name || "this person")} off the ticket">Remove</button></div>`).join("");
  const stateHtml = edit.saving ? '<span class="ticket-edit-saving" role="status">Saving…</span>' : edit.notice ? `<span class="ticket-edit-saved" role="status">✓ ${escapeHtml(edit.notice)}</span>` : '<span class="ticket-edit-hint">Changes save as you make them.</span>';
  return `<div class="ticket-edit-form">
    <div class="ticket-edit-state">${stateHtml}</div>
    ${edit.error ? `<div class="record-error-banner" role="alert">${escapeHtml(edit.error)}</div>` : ""}
    <div class="escalation-grid ticket-inbox-form">
      <div class="escalation-field"><label class="field-label">Department</label>${renderTicketChoice(chatId, "edit:departmentCode", department, departments, { placeholder: "Please select", allowEmpty: false })}</div>
      <div class="escalation-field"><label class="field-label">Market</label>${renderTicketChoice(chatId, "edit:marketCode", market, markets, { placeholder: "No market", allowEmpty: true })}</div>
      ${ticketEditableSpecs().map(({ spec, field }) => renderTicketEditInput(chatId, spec, field, edit, ticket)).join("")}
      <div class="escalation-field escalation-field-wide"><label class="field-label">Assigned to</label>${people || '<span class="ticket-inbox-note">Unassigned</span>'}
        <input type="text" class="input esc-input ticket-live-input" data-chat="${escapeHtml(chatId)}" data-field="edit:addPeople" value="${escapeHtml(edit.typing.addPeople ?? "")}" placeholder="Add people: email or name, press Enter" aria-label="Add people" />
        <span class="ticket-inbox-note">After a department change, take the old department's people off before adding new ones.</span></div>
    </div>
  </div>`;
}

function renderTicketStatus(chatId) {
  const s = state[chatId];
  const ticket = s.ticketRecord;
  if (ticketDetailInFlight.has(chatId)) return '<div class="ticket-inbox-empty" role="status">Loading ticket…</div>';
  if (!ticket) return `<div class="ticket-inbox-empty">${s.ticketRef ? `Ticket ${escapeHtml(s.ticketRef)} created. Open it below to view its details.` : "Choose a ticket to view its details."}</div>${s.ticketRef ? `<button type="button" class="secondary-btn" data-action="openTicketResult" data-chat="${escapeHtml(chatId)}" data-ref="${escapeHtml(s.ticketRef)}">Open ticket</button>` : ""}`;
  const department = ticket.currentDepartment?.name || ticket.currentDepartment?.code || "—";
  const created = ticket.createdAt ? new Date(ticket.createdAt).toLocaleString() : "—";
  const updated = ticket.updatedAt ? new Date(ticket.updatedAt).toLocaleString() : "—";
  const raisedBy = ticket.raisedBy?.name || ticket.raisedBy?.email || "—";
  const market = ticket.market?.label || ticket.market?.code || "—";
  const assignees = (ticket.assignees || []).map(person => person?.name || person?.email).filter(Boolean).join(", ") || "Unassigned";
  const attachments = Array.isArray(ticket.fields?.attachment) ? ticket.fields.attachment : [];
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  const editableKeys = new Set(ticketEditableSpecs().map(({ field }) => field.key));
  const remarkPictures = splitImageLinks(typeof ticket.fields?.remarks === "string" ? ticket.fields.remarks : "").links;
  const rows = Object.entries(ticket.fields || {}).filter(([key]) => key !== "attachment" && !editableKeys.has(key))
    .map(([key, value]) => `<div><span>${escapeHtml(ticketFieldLabel(key))}</span><strong>${escapeHtml(key === "remarks" && typeof value === "string" ? (splitImageLinks(value).text || "—") : ticketValueDisplay(key, value))}</strong></div>`).join("");
  return `<article class="ticket-inbox-detail">
    <div class="ticket-inbox-row-top"><span class="ticket-inbox-ref">${escapeHtml(ticket.ref)}</span><span class="ticket-inbox-status ${ticketStatusTone(ticket)}">${escapeHtml(ticketStatusLabel(ticket))}</span></div>
    <h3>${escapeHtml(ticketTitle(ticket))}</h3>
    ${s.ticketNotice && ticket.ref === s.ticketRef ? `<p class="ticket-inbox-note ticket-inbox-notice">${escapeHtml(s.ticketNotice)}</p>` : ""}
    <p class="ticket-inbox-player">${escapeHtml(ticket.fields?.member_id || "No player ID")} · ${escapeHtml(ticketValueDisplay("member_platform", ticket.fields?.member_platform || ticket.fields?.brand || ""))} · ${escapeHtml(market)}</p>
    ${renderTicketEditForm(chatId, ticket)}
    <details class="ticket-inbox-disclosure" data-ticket-disclosure="ticketDetailsOpen" data-chat="${escapeHtml(chatId)}" ${s.ticketDetailsOpen ? "open" : ""}><summary>Ticket details</summary><div class="ticket-inbox-data">
      <div><span>Created</span><strong>${escapeHtml(created)}</strong></div><div><span>Updated</span><strong>${escapeHtml(updated)}</strong></div><div><span>Raised by</span><strong>${escapeHtml(raisedBy)}</strong></div>${rows}
    </div></details>
    ${attachments.length || remarkPictures.length ? `<details class="ticket-inbox-disclosure" data-ticket-disclosure="ticketFilesOpen" data-chat="${escapeHtml(chatId)}" ${s.ticketFilesOpen ? "open" : ""}><summary>Attachments <span>${attachments.length + remarkPictures.length}</span></summary><div class="ticket-attachment-summary"><div class="ticket-thumbs">${[...attachments.filter(isTicketImage).map(item => renderTicketThumb({ path: item.path, name: item.name || "Picture", chatId })), ...remarkPictures.map(link => renderTicketThumb({ src: link, chatId }))].join("")}</div>${attachments.filter(item => !isTicketImage(item)).map(item => escapeHtml(item?.name || "Attached file")).join("<br>")}</div></details>` : ""}
    <div class="ticket-inbox-conversation"><div class="ticket-inbox-caption"><strong>Conversation</strong><span>${Number(ticket.commentCount || 0)} comments</span></div>
    ${renderTicketConversation(chatId, s, comments)}
    </div>
    <a class="ticket-open-link" href="https://tickets.96ghq.com/tickets?q=${encodeURIComponent(ticket.ref)}" target="_blank" rel="noopener">Open in ticket system ↗</a>
  </article>`;
}

const ticketCommentInFlight = new Set();

function ticketAuthor(s) {
  const agentToken = liveChatAgentTokens()[currentLiveChatAccount];
  return agentToken && currentLiveChatAccount ? { accountKey: currentLiveChatAccount, agentToken, ticketEmail: s.escalation.ticketEmail || storedTicketEmail(currentLiveChatAccount) } : undefined;
}

function showTicketProblem(chatId, failure, retry) {
  document.getElementById("ticketProblemOverlay")?.remove();
  const askEmail = Boolean(failure.needTicketEmail);
  const overlay = document.createElement("div");
  overlay.id = "ticketProblemOverlay";
  overlay.className = "claim-ticket-backdrop";
  overlay.innerHTML = `<div class="claim-ticket-card ticket-problem" role="alertdialog" aria-modal="true" aria-labelledby="ticketProblemTitle">
    <div class="claim-ticket-head"><span class="claim-ticket-mark ${askEmail ? "" : "warn"}" aria-hidden="true">${askEmail ? "✉" : "⚠"}</span><div><h3 id="ticketProblemTitle">${askEmail ? "Ticket account not found" : "This can't be done in the ticket system"}</h3>
      <p class="claim-ticket-intro">${askEmail
        ? (failure.triedEmail ? `We couldn't find a ticket-system account for <strong>${escapeHtml(failure.triedEmail)}</strong>. Enter the email you use in the ticket system.` : "Enter the email you use in the ticket system.")
        : `${escapeHtml(failure.error || "The ticket system refused this.")}${failure.detail ? ` The ticket system said: "${escapeHtml(failure.detail)}"` : ""}`}</p></div></div>
    ${failure.duplicateOf ? `<div class="claim-ticket-summary ticket-problem-duplicate"><span>This is the ticket that already has the same details:</span><strong>${escapeHtml(failure.duplicateOf)}</strong></div>` : ""}
    ${askEmail ? `<div class="claim-ticket-label">Your ticket account email</div><input type="text" inputmode="email" autocomplete="email" class="input mono ticket-problem-email" placeholder="name@company.com" aria-label="Your ticket account email" /><div class="claim-ticket-status ticket-problem-status" role="alert"></div>` : ""}
    <div class="claim-ticket-actions">${askEmail ? `<button type="button" class="secondary-btn" data-problem="cancel">Cancel</button>` : ""}${failure.duplicateOf ? `<button type="button" class="secondary-btn" data-problem="open">Open ${escapeHtml(failure.duplicateOf)}</button>` : ""}<button type="button" class="submit-btn" data-problem="ok">${askEmail ? "Save and try again" : "OK"}</button></div>
  </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector(".ticket-problem-email");
  const status = overlay.querySelector(".ticket-problem-status");
  if (input) input.focus();
  const accept = () => {
    if (!askEmail) { overlay.remove(); return; }
    const value = input.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) { status.textContent = "Enter your ticket account email, like name@company.com."; return; }
    if (state[chatId]) state[chatId].escalation.ticketEmail = value;
    overlay.remove();
    retry();
  };
  overlay.querySelector('[data-problem="ok"]').addEventListener("click", accept);
  overlay.querySelector('[data-problem="open"]')?.addEventListener("click", async () => {
    overlay.remove();
    const s = state[chatId];
    if (!s) return;
    s.ticketView = "detail";
    s.ticketRecord = null;
    ticketDetailInFlight.add(chatId);
    renderTicketSlot(chatId);
    try { await loadTicketStatus(chatId, failure.duplicateOf, { silent: true }); s.escalationError = ""; }
    catch (err) { s.escalationError = "Ticket lookup failed: " + err.message; }
    finally { ticketDetailInFlight.delete(chatId); }
    renderTicketSlot(chatId);
  });
  const cancel = overlay.querySelector('[data-problem="cancel"]');
  if (cancel) cancel.addEventListener("click", () => overlay.remove());
  if (input) input.addEventListener("keydown", (event) => { if (event.key === "Enter") accept(); });
}
let ticketAccount = { status: "unknown", email: "", source: "", message: "", detail: "", checking: false, at: 0, shownUntil: 0 };
const TICKET_ACCOUNT_RECHECK_MS = 5 * 60_000;
const TICKET_ACCOUNT_FOUND_SHOWN_MS = 6000;
function hideTicketAccountLineLater() {
  setTimeout(() => { for (const id of Object.keys(state)) renderTicketSlot(id); }, TICKET_ACCOUNT_FOUND_SHOWN_MS + 100);
}
async function checkTicketAccount(chatId, { force = false, quiet = false } = {}) {
  const s = state[chatId];
  if (!s || ticketAccount.checking) return;
  if (!quiet && !force && (ticketAccount.status === "notFound" || ticketAccount.status === "noEmail") && !ticketAccount.asked) {
    ticketAccount.asked = true;
    queueMicrotask(() => showTicketProblem(chatId, { needTicketEmail: true, triedEmail: ticketAccount.email, error: "Ticket account not found. Please enter your ticket account email." }, () => checkTicketAccount(chatId, { force: true })));
  }
  if (!force && ticketAccount.status !== "unknown" && Date.now() - ticketAccount.at < TICKET_ACCOUNT_RECHECK_MS) return;
  const author = ticketAuthor(s);
  if (!author) return;
  ticketAccount = { ...ticketAccount, checking: true };
  renderTicketSlot(chatId);
  try {
    const res = await fetch("/ticket-account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ author }) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "The ticket account could not be checked");
    const wasFound = ticketAccount.status === "found";
    ticketAccount = data.enabled === false
      ? { status: "off", email: "", source: "", message: "", checking: false, at: Date.now(), shownUntil: 0 }
      : { status: data.status, email: data.email || "", source: data.source || "", message: "", detail: data.detail || "", checking: false, at: Date.now(), shownUntil: data.status === "found" && (!wasFound || force) ? Date.now() + TICKET_ACCOUNT_FOUND_SHOWN_MS : (data.status === "found" ? ticketAccount.shownUntil : 0) };
    if (ticketAccount.status === "found" && ticketAccount.shownUntil > Date.now()) hideTicketAccountLineLater();
    if (data.status === "found" && s.escalation.ticketEmail) storeTicketEmail(currentLiveChatAccount, s.escalation.ticketEmail);
    if (data.status === "found" && (ticketConfigError || !ticketFields.length)) await fetchTicketConfig({ fresh: true });
    if (quiet && ticketAccount.status === "found") ticketAccount.shownUntil = 0;
    if (!quiet && (ticketAccount.status === "notFound" || ticketAccount.status === "noEmail")) {
      queueMicrotask(() => showTicketProblem(chatId, { needTicketEmail: true, triedEmail: ticketAccount.email, error: "Ticket account not found. Please enter your ticket account email." }, () => checkTicketAccount(chatId, { force: true })));
    }
    if (ticketAccount.status === "found") void pollTicketNotifications();
    if (!quiet && ticketAccount.status === "found" && ticketWorkspaceView(s) === "list" && !ticketSearchResultsByChat.has(chatId)) void refreshTicketInbox(chatId, "", "all", { fresh: false });
  } catch (err) {
    ticketAccount = { status: "error", email: "", source: "", message: err.message, checking: false, at: Date.now(), shownUntil: 0 };
  }
  renderTicketSlot(chatId);
}
function installTicketDemo() {
  const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const person = (id, name) => ({ id, name, email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@demo.test` });
  const dept = (code, name) => ({ code, name });
  const market = (code, label) => ({ code, label });
  const ticket = (ref, fields, extra) => ({ ref, fields, raisedBy: person(1, "Demo Agent"), assignees: [], attachmentCount: 0, ...extra });
  const tickets = [
    ticket("TK2610160001", { member_id: "demo-player-1", member_platform: "SPIN321", query_type: "wd_delay", status: "IN_PROGRESS", attachment: [{ name: "receipt.png", mime: "image/png", path: "2026-10/16/demo-receipt.png", size: 1200 }] }, { currentDepartment: dept("PYM", "Payment"), market: market("MYR", "Malaysia"), assignees: [person(2, "Demo Payment")], createdAt: ago(300), updatedAt: ago(12), commentCount: 2 }),
    ticket("TK2610160002", { member_id: "demo-player-2", member_platform: "PP96", query_type: "dp_not_credited", status: "Open" }, { currentDepartment: dept("CS", "Customer Service"), market: market("IDR", "Indonesia"), createdAt: ago(200), updatedAt: ago(95), commentCount: 0 }),
    ticket("TK2610160003", { member_id: "demo-player-3", member_platform: "MY36", query_type: "refund", status: "SOLVED" }, { currentDepartment: dept("PYM", "Payment"), market: market("THB", "Thailand"), assignees: [person(2, "Demo Payment")], createdAt: ago(1500), updatedAt: ago(700), commentCount: 1 }),
    ticket("TK2610160004", { member_id: "demo-player-4", member_platform: "ACE33", query_type: "missing_wd", status: "CS_TO_FOLLOW_UP" }, { currentDepartment: dept("CS", "Customer Service"), market: market("PHP", "Philippines"), createdAt: ago(2600), updatedAt: ago(1300), commentCount: 0 }),
  ];
  const comments = {
    TK2610160001: [
      { id: 1, author: { id: 2, name: "Demo Payment" }, body: "We have asked the gateway to release this. Will update shortly.", createdAt: ago(60), attachments: [{ name: "gateway-slip.png", mime: "image/png", path: "2026-10/17/demo-slip.png" }], replies: [{ id: 2, author: { id: 1, name: "Demo Agent" }, body: "Thanks, the player is waiting in chat.", createdAt: ago(12) }] },
    ],
    TK2610160003: [{ id: 3, author: { id: 2, name: "Demo Payment" }, body: "Refunded to the original account.", createdAt: ago(700) }],
  };
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.origin);
    if (url.pathname === "/ticket-account") return Promise.resolve(reply({ ok: true, enabled: true, status: "found", email: "demo.agent@demo.test", source: "livechat" }));
    if (url.pathname === "/ticket-list") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const found = tickets.filter((item) => !q || JSON.stringify(item).toLowerCase().includes(q));
      return Promise.resolve(reply({ ok: true, total: found.length, tickets: found }));
    }
    if (url.pathname === "/ticket-status") {
      const found = tickets.find((item) => item.ref === url.searchParams.get("ref"));
      return Promise.resolve(found ? reply({ ok: true, ticket: { ...found, comments: comments[found.ref] || [] } }) : reply({ ok: false, error: "Demo ticket not found" }, 404));
    }
    if (url.pathname === "/ticket-attachment") {
      const canvas = document.createElement("canvas");
      canvas.width = 240; canvas.height = 160;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#3b4a7a"; ctx.fillRect(0, 0, 240, 160);
      ctx.fillStyle = "#fff"; ctx.font = "20px sans-serif"; ctx.fillText("Demo picture", 50, 85);
      return new Promise((resolve) => canvas.toBlob((blob) => resolve(new Response(blob, { headers: { "Content-Type": "image/png" } })), "image/png"));
    }
    if (url.pathname === "/ticket-comment" || url.pathname === "/ticket-create" || url.pathname === "/ticket-update") return Promise.resolve(reply({ ok: false, error: "Demo mode: nothing is sent to the ticket system." }, 400));
    return realFetch(input, init);
  };
}
const TICKET_DEMO = !IS_EMBEDDED_APP && new URLSearchParams(location.search).get("ticketDemo") === "1";
if (TICKET_DEMO) installTicketDemo();
function noteTicketAccountUsed(data) {
  if (data?.actedAs) ticketAccount = { status: "found", email: data.actedAs, source: ticketAccount.source, message: "", checking: false, at: Date.now(), shownUntil: ticketAccount.shownUntil };
}
const TICKET_ACCOUNT_BLOCKING = ["notFound", "noEmail", "adminEmailInvalid", "keyNeedsGrant", "outranks", "keyRejected"];
function ticketAccountBlocks() {
  return (ticketAccount.checking && ticketAccount.status !== "found") || TICKET_ACCOUNT_BLOCKING.includes(ticketAccount.status);
}
function renderTicketAccountGate(chatId) {
  if (!ticketAccountBlocks()) return "";
  const again = `<button type="button" class="secondary-btn" data-action="recheckTicketAccount" data-chat="${escapeHtml(chatId)}">Check again</button>`;
  return `<div class="ticket-inbox-header"><h2>Tickets</h2></div>
    <div class="ticket-account-gate">${renderTicketAccountLine(chatId)}
      <p class="ticket-inbox-note">Your ticket account has to be recognised before tickets can be used here, so every ticket and comment is yours.</p>
      ${ticketAccount.checking ? "" : again}
    </div>`;
}

function renderTicketNotesStatus() {
  const info = ticketNotePollInfo;
  if (!info.at) return "Notifications: waiting for the first check (every minute while this page is open and visible).";
  const when = new Date(info.at).toLocaleTimeString();
  return info.error
    ? `Notifications: not working. ${escapeHtml(info.error)} (tried ${escapeHtml(when)})`
    : `Notifications: watching ${info.watching} ticket${info.watching === 1 ? "" : "s"}, last checked ${escapeHtml(when)}. New comments, mentions and status changes on your tickets appear on the bell.`;
}

function ticketAccountSettingsVisible() {
  return ESCALATION_TICKET_ENABLED && (previewMode || DEPARTMENT_TABS_LIVE) && ticketAccount.status !== "off";
}
function ticketAccountSettingsChat() {
  if (!activeChats[0] && !Object.keys(state).length) ensureChatState(ticketsOnlyChat());
  return activeChats[0]?.chatId || Object.keys(state)[0] || "";
}
function renderTicketAccountSettings() {
  const chatId = ticketAccountSettingsChat();
  const line = renderTicketAccountLine(chatId, { always: true });
  return `<div class="settings-section-title"><span class="settings-section-icon">${SETTINGS_ICONS.ticket}</span><span>Ticket account</span></div>
    <p class="settings-hint">The ticket-system account your tickets, comments and edits are made as.</p>
    ${line || '<p class="settings-hint">Not checked yet.</p>'}
    <p class="settings-hint" id="settingsTicketNotes">${renderTicketNotesStatus()}</p>
    ${ticketAccount.checking ? "" : '<button type="button" class="secondary-btn" data-settings-ticket-recheck>Check again</button>'}`;
}

function renderTicketAccountLine(chatId, { always = false } = {}) {
  const a = ticketAccount;
  const line = (kind, html) => `<div class="ticket-account ticket-account-${kind}" role="status">${html}</div>`;
  const enter = `<button type="button" class="ticket-inbox-text-button" data-action="enterTicketEmail" data-chat="${escapeHtml(chatId)}">Enter your ticket email</button>`;
  const who = a.email ? `<strong>${escapeHtml(a.email)}</strong>` : "";
  const said = a.detail ? `<br><span>The ticket system said: "${escapeHtml(a.detail)}"</span>` : "";
  const origin = ({ livechat: "from your LiveChat email", "ticket-email": "your saved Ticket Email", "same-agent": "your saved Ticket Email", entered: "the email you entered" })[a.source];
  if (a.checking) return line("checking", "Checking your ticket account…");
  switch (a.status) {
    case "found": return always || a.shownUntil > Date.now() ? line("ok", `✓ Ticket account found: ${who}${origin ? ` <span>(${origin})</span>` : ""}`) : "";
    case "notFound": return line("bad", `✗ Ticket account not found${who ? ` for ${who}` : ""}. ${enter}`);
    case "noEmail": return line("bad", `✗ No ticket account email for you. ${enter}`);
    case "adminEmailInvalid": return line("bad", `✗ The Ticket Email saved for you (${who}) has no ticket account. Ask your admin to correct it.`);
    case "keyNeedsGrant": return line("warn", `⚠ The ticket system won't let its API key act for you, so tickets and comments are refused. Ask the ticket team to check the key: its role needs api-keys:act-on-behalf, and the key must be bound to that role.${said}`);
    case "outranks": return line("warn", `⚠ Your ticket account ${who} is senior to the integration key, so tickets and comments can't be made as you. Ask the ticket team.${said}`);
    case "keyRejected": return line("warn", `⚠ The ticket system does not accept the integration key (it was revoked, replaced or is wrong), so nothing can be checked or sent as you. This is not about your email. Ask the ticket team for the current key; your admin then updates it.${said}`);
    case "error": return line("warn", `⚠ Could not check your ticket account: ${escapeHtml(a.message || "")}`);
    default: return "";
  }
}

function resubmitTicket(chatId) {
  const button = chatListEl.querySelector(`.chat-card[data-chat-id="${chatId}"] [data-action="submitEscalation"]`);
  if (button) button.click();
}

const TICKET_IMAGE_LINK = /https?:\/\/[^\s<>"]+?(?:\/ticket-image\?k=[^\s<>"]+|\/tickets\/\d{8}\/[0-9a-f-]{36}\.(?:png|jpg|webp))/gi;
const ticketImageUrls = new Map();
const isTicketImage = (item) => (/^image\/(png|jpe?g|webp)$/i.test(String(item?.mime || item?.mimeType || "")) || /\.(png|jpe?g|webp)$/i.test(String(item?.name || item?.originalName || item?.path || ""))) && Boolean(item?.path);
function splitImageLinks(text) {
  const links = [];
  const cleaned = String(text || "").replace(TICKET_IMAGE_LINK, (link) => { links.push(link); return ""; })
    .replace(/^\s*Images:\s*$/gim, "").replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleaned, links };
}
function renderTicketThumb({ path = "", src = "", name = "Picture", chatId }) {
  const source = path ? `data-ticket-image="${escapeHtml(path)}" data-chat="${escapeHtml(chatId)}"` : `src="${escapeHtml(src)}"`;
  return `<button type="button" class="ticket-thumb" data-action="openTicketImage" title="${escapeHtml(name)}"><img ${source} alt="${escapeHtml(name)}" loading="lazy" /><span class="ticket-thumb-name">${escapeHtml(name)}</span></button>`;
}
function fetchTicketImageUrl(path, chatId) {
  if (!ticketImageUrls.has(path)) {
    ticketImageUrls.set(path, (async () => {
      const author = ticketReadAuthor(state[chatId]);
      const res = await fetch("/ticket-attachment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, author }) });
      if (!res.ok) {
        let reason = `the ticket system could not give it (${res.status})`;
        try { reason = (await res.json()).error || reason; } catch (_) { }
        throw new Error(reason);
      }
      return URL.createObjectURL(await res.blob());
    })().catch((err) => { ticketImageUrls.delete(path); throw err; }));
  }
  return ticketImageUrls.get(path);
}
function hydrateTicketImages() {
  document.querySelectorAll("img[data-ticket-image]:not([data-loading])").forEach((img) => {
    img.dataset.loading = "1";
    fetchTicketImageUrl(img.dataset.ticketImage, img.dataset.chat)
      .then((url) => { img.src = url; })
      .catch((err) => {
        const thumb = img.closest(".ticket-thumb");
        if (!thumb) return;
        thumb.classList.add("failed");
        thumb.title = `${img.alt}: ${err.message}`;
        const note = document.createElement("span");
        note.className = "ticket-thumb-error";
        note.textContent = `${err.message} Click to open it in the ticket system (you need to be signed in there).`;
        thumb.appendChild(note);
        thumb.dataset.fallbackUrl = `https://tickets.96ghq.com/api/attachments/${String(img.dataset.ticketImage).split("/").map(encodeURIComponent).join("/")}?access=1`;
        logDiagnostic(`Could not show the picture ${img.alt}: ${err.message}`, "warn");
      });
  });
}
function openTicketImageLightbox(src, name) {
  document.getElementById("ticketImageOverlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "ticketImageOverlay";
  overlay.className = "settings-overlay ticket-image-overlay";
  overlay.innerHTML = `<div class="ticket-image-view" role="dialog" aria-modal="true" aria-label="${escapeHtml(name)}"><img src="${escapeHtml(src)}" alt="${escapeHtml(name)}" /><button type="button" class="secondary-btn">Close</button></div>`;
  overlay.addEventListener("click", (event) => { if (event.target === overlay || event.target.closest("button")) overlay.remove(); });
  document.body.appendChild(overlay);
}

const ticketCommentFilesByChat = new Map();
const COMMENT_FILE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);
const COMMENT_MAX_FILES = 4;
const commentFileUrl = (file) => { if (!file._preview) file._preview = URL.createObjectURL(file); return file._preview; };
function addCommentFiles(chatId, added) {
  const s = state[chatId];
  if (!s) return;
  const existing = ticketCommentFilesByChat.get(chatId) || [];
  const incoming = Array.from(added || []).filter(Boolean);
  let error = "";
  if (existing.length + incoming.length > COMMENT_MAX_FILES) error = `A comment can carry up to ${COMMENT_MAX_FILES} files.`;
  else {
    const bad = incoming.find((file) => !file.size || file.size >= ticketMaxBytes(file) || !COMMENT_FILE_TYPES.has(file.type));
    if (bad) error = !bad.size ? `${bad.name || "File"} is empty.` : !COMMENT_FILE_TYPES.has(bad.type) ? `${bad.name || "File"} must be PNG, JPG, WEBP or PDF.` : `${bad.name || "File"} must be under ${ticketMaxBytes(bad) / (1024 * 1024)}MB.`;
  }
  if (!error && incoming.length) ticketCommentFilesByChat.set(chatId, [...existing, ...incoming]);
  s.commentFileError = error;
}
function renderCommentFiles(chatId) {
  const files = ticketCommentFilesByChat.get(chatId) || [];
  const error = state[chatId]?.commentFileError;
  return `${files.map((file, index) => `<span class="ticket-comment-file">${file.type === "application/pdf"
      ? `<span class="ticket-thumb-pdf">PDF</span>`
      : `<img src="${escapeHtml(commentFileUrl(file))}" alt="" />`}<span>${escapeHtml(file.name || "Picture")}</span><button type="button" data-action="removeCommentFile" data-chat="${escapeHtml(chatId)}" data-index="${index}" aria-label="Remove ${escapeHtml(file.name || "file")}">×</button></span>`).join("")}${error ? `<span class="ticket-attachment-error">${escapeHtml(error)}</span>` : ""}`;
}
function clearCommentFiles(chatId) {
  for (const file of ticketCommentFilesByChat.get(chatId) || []) { try { URL.revokeObjectURL(file._preview); } catch (_) { } }
  ticketCommentFilesByChat.delete(chatId);
}

function renderTicketComment(comment, chatId, isReply = false) {
  const name = typeof comment.author === "string" ? comment.author : comment.author?.name || "Unknown";
  const when = comment.time || (comment.createdAt ? new Date(comment.createdAt).toLocaleString() : "");
  const shown = comment.deleted ? { text: "", links: [] } : splitImageLinks(comment.body || "");
  const pictures = (comment.attachments || []).filter(isTicketImage);
  const files = (comment.attachments || []).filter((file) => !isTicketImage(file)).map((file) => escapeHtml(file?.name || "File"));
  const thumbs = [...pictures.map((file) => renderTicketThumb({ path: file.path, name: file.name || "Picture", chatId })), ...shown.links.map((link) => renderTicketThumb({ src: link, chatId }))].join("");
  const text = comment.deleted ? "<em>This comment was deleted.</em>" : escapeHtml(shown.text);
  const reply = !isReply && !comment.deleted && comment.id
    ? `<button type="button" class="ticket-inbox-text-button" data-action="replyTicketComment" data-chat="${escapeHtml(chatId)}" data-comment="${escapeHtml(comment.id)}">Reply</button>` : "";
  return `<article class="ticket-comment${isReply ? " ticket-comment-reply" : ""}"><span class="ticket-comment-avatar">${escapeHtml(String(name).charAt(0).toUpperCase() || "?")}</span><div><div class="ticket-comment-meta"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(comment.role || "")}</span><time>${escapeHtml(when)}</time>${reply}</div><p>${text}</p>${thumbs ? `<div class="ticket-thumbs">${thumbs}</div>` : ""}${files.length ? `<small class="ticket-comment-files">📎 ${files.join(", ")}</small>` : ""}${(comment.replies || []).map((item) => renderTicketComment(item, chatId, true)).join("")}</div></article>`;
}
function renderTicketConversation(chatId, s, comments) {
  const replyTo = s.commentReplyTo ? comments.find((comment) => String(comment.id) === String(s.commentReplyTo)) : null;
  const busy = ticketCommentInFlight.has(chatId);
  return `${comments.length ? `<div class="ticket-comments">${comments.map((comment) => renderTicketComment(comment, chatId)).join("")}</div>` : '<p class="ticket-inbox-note">No comments yet.</p>'}
    <div class="ticket-comment-composer">
      ${replyTo ? `<div class="ticket-comment-replying"><span>Replying to ${escapeHtml(typeof replyTo.author === "string" ? replyTo.author : replyTo.author?.name || "a comment")}</span><button type="button" class="ticket-inbox-text-button" data-action="cancelReplyTicketComment" data-chat="${escapeHtml(chatId)}">Cancel</button></div>` : ""}
      <textarea class="input esc-input ticket-comment-input" data-chat="${escapeHtml(chatId)}" data-field="commentDraft" rows="3" placeholder="Write a comment…" aria-label="Write a comment">${escapeHtml(s.escalation.commentDraft || "")}</textarea>
      <div class="ticket-comment-files-row" data-chat="${escapeHtml(chatId)}">${renderCommentFiles(chatId)}</div>
      <label class="ticket-file-button ticket-comment-attach"><input type="file" class="ticket-comment-file-input" data-chat="${escapeHtml(chatId)}" accept="image/png,image/jpeg,image/webp,application/pdf" multiple /><span>📎 Attach a picture or PDF</span></label>
      <small class="ticket-attachment-help">Enter sends · Shift+Enter for a new line · click in the box and press Ctrl+V to paste a picture.</small>
      <button type="button" class="submit-btn" data-action="sendTicketComment" data-chat="${escapeHtml(chatId)}" ${busy ? "disabled" : ""}>${busy ? "Sending…" : "Send comment"}</button>
    </div>`;
}
async function sendTicketComment(chatId) {
  const s = state[chatId];
  const ref = s?.ticketRecord?.ref;
  const text = String(s?.escalation?.commentDraft || "").trim();
  if (!ref || ticketCommentInFlight.has(chatId)) return;
  const files = ticketCommentFilesByChat.get(chatId) || [];
  if (!text && !files.length) { s.escalationError = "Write a comment first."; renderTicketSlot(chatId); return; }
  ticketCommentInFlight.add(chatId);
  renderTicketSlot(chatId);
  let failure = null;
  try {
    const payload = { ref, body: text, parentId: s.commentReplyTo || undefined, author: ticketAuthor(s) };
    let res;
    if (files.length) {
      const form = new FormData();
      form.append("comment", JSON.stringify(payload));
      for (const file of files) form.append("file", file, file.name);
      res = await fetch("/ticket-comment", { method: "POST", body: form });
    } else {
      res = await fetch("/ticket-comment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    }
    const data = await res.json();
    if (!data.ok) { failure = data; throw new Error(data.error || "Comment failed"); }
    noteTicketAccountUsed(data);
    ticketNoteRemember(ref, data.comment?.author?.id ?? null);
    s.escalation.commentDraft = "";
    s.commentFileError = "";
    clearCommentFiles(chatId);
    s.commentReplyTo = null;
    if (s.escalation.ticketEmail) storeTicketEmail(currentLiveChatAccount, s.escalation.ticketEmail);
    await loadTicketStatus(chatId, ref, { silent: true });
    s.escalationError = "";
  } catch (err) {
    s.escalationError = "Comment failed: " + err.message;
    if (failure) showTicketProblem(chatId, failure, () => sendTicketComment(chatId));
  } finally {
    ticketCommentInFlight.delete(chatId);
  }
  renderTicketSlot(chatId);
}

function ticketReadFailure(chatId, data, fallback) {
  if (data.needTicketEmail && state[chatId]) queueMicrotask(() => showTicketProblem(chatId, data, () => checkTicketAccount(chatId, { force: true })));
  return new Error(data.error || fallback);
}

async function loadTicketStatus(chatId, ref, { silent = false, fresh = true } = {}) {
  const s = state[chatId];
  const normalized = String(ref || "").trim().toUpperCase();
  if (!normalized) throw new Error("Enter a ticket reference");
  const author = ticketReadAuthor(s);
  const res = author
    ? await fetch("/ticket-status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: normalized, fresh, author }) })
    : await fetch(`/ticket-status?ref=${encodeURIComponent(normalized)}${fresh ? "&fresh=1" : ""}`);
  const data = await res.json();
  if (!data.ok) throw ticketReadFailure(chatId, data, "Ticket status lookup failed");
  s.ticketLookupRef = normalized;
  if (!fresh && s.ticketRecord?.ref === data.ticket.ref && Date.parse(data.ticket.updatedAt) < Date.parse(s.ticketRecord.updatedAt)) return s.ticketRecord;
  s.ticketRecord = data.ticket;
  rememberTicketSnapshot(data.ticket);
  ticketNoteAbsorb(data.ticket);
  s.escalationError = "";
  saveState();
  return data.ticket;
}

async function fetchTicketList(chatId, query, { fresh = true, who = "", page = 1 } = {}) {
  const author = ticketReadAuthor(state[chatId]);
  const q = String(query || "").trim();
  const scope = who === "me" ? { mine: true } : who ? { agent: who } : {};
  const narrowing = ticketServerFilters(chatId);
  const res = author
    ? await fetch("/ticket-list", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q, fresh, author, ...scope, ...narrowing, ...(page > 1 ? { page } : {}) }) })
    : await fetch(`/ticket-list?q=${encodeURIComponent(q)}${fresh ? "&fresh=1" : ""}${who === "me" ? "&mine=1" : who ? `&agent=${encodeURIComponent(who)}` : ""}${Object.entries(narrowing).map(([key, value]) => `&${key}=${encodeURIComponent(value)}`).join("")}${page > 1 ? `&page=${page}` : ""}`);
  const data = await res.json();
  if (!data.ok) throw ticketReadFailure(chatId, data, "Ticket search failed");
  return data;
}

const TICKET_PAGE_SIZE = 100;
const TICKET_LOAD_ALL_MAX_PAGES = 20;
const ticketLoadAllInFlight = new Set();
async function loadAllTickets(chatId) {
  const result = ticketSearchResultsByChat.get(chatId);
  if (!result || result.loading || ticketLoadAllInFlight.has(chatId)) return;
  const agent = state[chatId]?.ticketExplorerAgent;
  const who = ticketScopedWho(agent);
  const scoped = Boolean(who && result.mine && result.mineFor === agent);
  const target = scoped ? result.mine : result;
  ticketLoadAllInFlight.add(chatId);
  target.loadingAll = true;
  target.loadAllNote = "";
  renderTicketSlot(chatId);
  try {
    const pages = Math.min(Math.ceil(Number(target.total || 0) / TICKET_PAGE_SIZE), TICKET_LOAD_ALL_MAX_PAGES);
    for (let page = 2; page <= pages; page += 1) {
      const data = await fetchTicketList(chatId, result.query || "", { fresh: false, who: scoped ? who : "", page });
      if (ticketSearchResultsByChat.get(chatId) !== result) return;
      const known = new Set(target.tickets.map((ticket) => ticket.ref));
      const more = (data.tickets || []).filter((ticket) => !known.has(ticket.ref));
      target.tickets = [...target.tickets, ...more];
      target.total = Math.max(Number(data.total || 0), target.tickets.length);
      renderTicketSlot(chatId);
      if (!more.length) break;
    }
  } catch (err) {
    ticketPollBackoff(err);
    target.loadAllNote = `Could not load the rest: ${err.message}`;
  } finally {
    target.loadingAll = false;
    ticketLoadAllInFlight.delete(chatId);
    renderTicketSlot(chatId);
  }
}

function ticketServerFilters(chatId) {
  const s = state[chatId] || {};
  const out = {};
  const set = (value) => value && value !== "all";
  const statuses = ticketBulkStatusOptions().map((option) => String(option.value));
  if (set(s.ticketExplorerStatus) && statuses.includes(s.ticketExplorerStatus)) out.status = s.ticketExplorerStatus;
  const department = set(s.ticketExplorerDepartment) ? ticketDepartments.find((item) => (item.name || item.code) === s.ticketExplorerDepartment) : null;
  if (department && /^\d+$/.test(String(department.id))) out.department = String(department.id);
  const market = set(s.ticketExplorerMarket) ? ticketMarkets.find((item) => (item.label || item.code) === s.ticketExplorerMarket) : null;
  if (market && /^\d+$/.test(String(market.id))) out.market = String(market.id);
  return out;
}

function ticketListStale(chatId) {
  const loaded = ticketSearchResultsByChat.get(chatId);
  if (!loaded || loaded.loading || loaded.error) return false;
  const agent = state[chatId]?.ticketExplorerAgent;
  return loaded.filtersKey !== JSON.stringify(ticketServerFilters(chatId)) || (Boolean(ticketScopedWho(agent)) && loaded.mineFor !== agent);
}

function ticketScopedWho(value) {
  return value === TICKET_FILTER_ME ? "me" : /^#\d+$/.test(String(value)) ? String(value).slice(1) : "";
}

function ticketActiveList(chatId) {
  const result = ticketSearchResultsByChat.get(chatId);
  const agent = state[chatId]?.ticketExplorerAgent;
  return ticketScopedWho(agent) && result?.mine && result.mineFor === agent ? result.mine : result;
}

async function searchTickets(chatId, query, mode = "search", { fresh = true } = {}) {
  ticketSearchResultsByChat.set(chatId, { loading: true, tickets: [], mode, query: String(query || "") });
  const agent = state[chatId]?.ticketExplorerAgent;
  const who = ticketScopedWho(agent);
  const filtersKey = JSON.stringify(ticketServerFilters(chatId));
  const [data, personData] = await Promise.all([fetchTicketList(chatId, query, { fresh }), who ? fetchTicketList(chatId, query, { fresh, who }) : null]);
  ticketSearchResultsByChat.set(chatId, {
    loading: false, tickets: data.tickets || [], total: data.total || 0, mode, query: String(query || ""), filtersKey,
    ...(personData ? { mine: { tickets: personData.tickets || [], total: personData.total || 0 }, mineFor: agent } : {}),
  });
  return data;
}

function applyTicketFilter(chatId, key, value) {
  const s = state[chatId];
  if (!s || !["ticketExplorerAgent", "ticketExplorerStatus", "ticketExplorerDepartment", "ticketExplorerMarket"].includes(key)) return;
  s[key] = value;
  renderTicketSlot(chatId);
  saveState();
  if (ticketListStale(chatId)) {
    const loaded = ticketSearchResultsByChat.get(chatId);
    void refreshTicketInbox(chatId, loaded.query || "", loaded.mode || "all", { fresh: false });
  }
}

async function pollTicketUpdates() {
  if (activeMainTab !== "tickets" || !watchedTicketSnapshots.size || document.hidden || Date.now() < ticketPollPausedUntil) return;
  for (const ref of watchedTicketSnapshots.keys()) {
    const owner = Object.entries(state).find(([, value]) => value?.ticketRecord?.ref === ref);
    if (!owner) continue;
    const [chatId] = owner;
    if (ticketWorkspaceView(state[chatId]) !== "detail") continue;
    try {
      await loadTicketStatus(chatId, ref, { fresh: false });
      const slot = chatListEl.querySelector(`.chat-card[data-chat-id="${chatId}"] .escalation-slot`);
      if (slot && ticketWorkspaceView(state[chatId]) === "detail") renderTicketSlot(chatId);
    } catch (err) { ticketPollBackoff(err); }
  }
}
setInterval(pollTicketUpdates, TICKET_OPEN_POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void pollTicketUpdates(); });

function renderEscalationSection(chatId) {
  const s = state[chatId];
  const view = ticketWorkspaceView(s);
  const busy = ticketCreateInFlight.has(chatId);
  const gate = renderTicketAccountGate(chatId);
  if (gate) return gate;
  const primaryKeys = new Set(["memberUserId", "brand", "queries", "remarks"]);
  const primary = TICKET_FIELD_SPECS.filter(spec => primaryKeys.has(spec.stateKey));
  const extra = TICKET_FIELD_SPECS.filter(spec => !primaryKeys.has(spec.stateKey));
  const requiredExtra = extra.some(spec => ticketFieldFor(spec)?.required || ticketFieldFor(spec)?.isRequired);
  const departmentId = String(s.escalation.departmentId || "");
  const marketId = String(s.escalation.marketId || "");
  const action = (name, label, classes = "ticket-inbox-text-button", icon = "", attrs = "") => `<button type="button" class="${classes}" data-action="${name}" data-chat="${escapeHtml(chatId)}" ${attrs}>${icon ? ticketUiIcon(icon) : ""}${label}</button>`;
  return `<div class="ticket-inbox-header"><h2>Tickets</h2><div><span class="ticket-bell" data-chat="${escapeHtml(chatId)}">${renderTicketBell(chatId)}</span>${view === "list" ? action("newTicket", "New ticket", "ticket-inbox-primary", "plus") : ""}</div></div>
    ${renderTicketAccountLine(chatId)}
    ${view !== "list" ? `<div class="ticket-inbox-back">${action("ticketInbox", "All tickets", "ticket-inbox-text-button", "back")}${view === "detail" && s.ticketRecord ? action("openTicketResult", "Refresh", "ticket-inbox-text-button", "refresh", `data-ref="${escapeHtml(s.ticketRecord.ref)}"`) : ""}</div>` : ""}
    ${s.escalationError ? `<div class="record-error-banner" role="alert">${escapeHtml(s.escalationError)}</div>` : ""}
    ${view === "list" ? `<div class="ticket-search-row ticket-inbox-search">${ticketUiIcon("search")}<input type="search" class="input ticket-search-input" data-chat="${escapeHtml(chatId)}" value="${escapeHtml(s.ticketSearchQuery || "")}" placeholder="Ticket, player or agent…" aria-label="Search tickets" /><button type="button" class="secondary-btn" data-action="searchTickets" data-chat="${escapeHtml(chatId)}" ${ticketSearchResultsByChat.get(chatId)?.loading ? "disabled" : ""}>Search</button>${action("loadAllTickets", "", "ticket-inbox-refresh", "refresh", 'aria-label="Refresh ticket list"')} </div>${renderTicketExplorer(chatId)}` : view === "detail" ? renderTicketStatus(chatId) : `
    <h3 class="ticket-inbox-form-title">New ticket</h3>
    ${previewMode ? '<p class="ticket-inbox-preview-note">This preview creates real tickets.</p>' : ""}
    ${ticketConfigError ? `<div class="record-error-banner">${escapeHtml(ticketConfigError)}</div>` : ""}
    ${ticketFields.length ? `<div class="escalation-grid ticket-inbox-form">
      <div class="escalation-field"><label class="field-label">Department *</label>${renderTicketChoice(chatId, "departmentId", departmentId, ticketDepartments.map(item => ({ value: item.id, label: item.name || item.code || item.id })), { placeholder: "Please select", allowEmpty: false })}</div>
      <div class="escalation-field"><label class="field-label">Market</label>${renderTicketChoice(chatId, "marketId", marketId, ticketMarkets.map(item => ({ value: item.id, label: item.label || item.code || item.id })), { placeholder: "Use ticket default", allowEmpty: true })}</div>
      ${s.ticketEmailNeeded ? `<div class="escalation-field escalation-field-wide"><label class="field-label" for="ticket-email-${escapeHtml(chatId)}">Your ticket account email *</label><input id="ticket-email-${escapeHtml(chatId)}" type="text" inputmode="email" autocomplete="email" class="input mono esc-input" data-chat="${escapeHtml(chatId)}" data-field="ticketEmail" value="${escapeHtml(s.escalation.ticketEmail || "")}" placeholder="name@company.com" /></div>` : ""}
      ${primary.map(spec => renderTicketInput(chatId, spec)).join("")}
    </div><details class="ticket-inbox-disclosure" data-ticket-disclosure="ticketAdditionalOpen" data-chat="${escapeHtml(chatId)}" ${s.ticketAdditionalOpen || requiredExtra ? "open" : ""}><summary>Additional details</summary><div class="escalation-grid ticket-inbox-form">${extra.map(spec => renderTicketInput(chatId, spec)).join("")}</div></details>
    ${renderTicketAttachments(chatId)}
    <div class="ticket-inbox-form-footer">${action("ticketInbox", "Cancel")}<button type="button" class="submit-btn escalation-submit-btn ticket-inbox-primary" data-action="submitEscalation" data-chat="${escapeHtml(chatId)}" ${busy ? "disabled" : ""}>${busy ? "Creating…" : "Create ticket"}</button></div>` : !ticketConfigError ? '<p class="ticket-inbox-note">Loading ticket fields…</p>' : ""}`}
  `;
}

function applyPreviewSampleState(chat) {
  if (!previewMode || chat.chatId !== "preview-test") return;
  const sample = state[chat.chatId];
  if (!sample.username) sample.username = "860944";
  if (!sample.usernameDraft) sample.usernameDraft = sample.username;
  if (!sample.brand) sample.brand = "VS";
  if (!sample.matchedRow) {
    sample.matchedRow = {
      tier: "Tier 3",
      customerName: "Abang SofHin",
      riskPlayer: "Eligible · 30%",
      riskExpiryMs: Date.now() + (4 * 24 * 60 * 60 * 1000),
      vs96Feedback: "Eligible",
    };
  }
  if (BONUS_SHOWCASE_PREVIEW) {
    Object.assign(sample.matchedRow, {
      riskPlayer: "Eligible · 30%",
      riskExpiryMs: Date.now() + (4 * 24 * 60 * 60 * 1000),
      topPnl: "Batch 09-09-2026 Pass RM58",
      gracePeriod: "Pass 58",
      graceExpiryMs: Date.now() + (4 * 24 * 60 * 60 * 1000),
      ltvTest: "Pass RM18",
      vipBooster: "Eligible",
      mooncake: "Eligible · RM28",
      vs96Feedback: "Eligible",
      telegram28: { status: "Eligible · RM28" },
      redeemCode: { status: "SUNNY-88" },
      specialReload: { status: "Eligible Angpao" },
      halloween: {
        day: 2, state: "day2", brand: "EZ", fullBrand: "EZ96", tier: "Tier V", redPacket: 28, shareExtra: 28,
        choice: "TRICK", track: "RM300+", day1Deposit: 350, day1Bonus: 120,
      },
    });
    configuredBonusPrograms.forEach((program, index) => {
      if (sample.matchedRow[program.key] === undefined) {
        sample.matchedRow[program.key] = program.amountEligible ? `Eligible · RM${32 + index}` : "Eligible";
      }
    });
  }
  if (!sample.riskReloadAmount) sample.riskReloadAmount = "600";
  if (!sample.ticketRecord) {
    sample.ticketLookupRef = "TK2609290238";
    sample.ticketRef = "TK2609290238";
    sample.ticketRecord = {
      ref: "TK2609290238",
      status: "PYM_SOLVED",
      createdAt: "2026-09-29T12:29:19.000Z",
      updatedAt: "2026-09-29T13:03:24.000Z",
      raisedBy: { name: "Developer" },
      assignees: [{ name: "Derin" }],
      currentDepartment: { name: "PAYMENT MYR/PHP/PKR" },
      market: { label: "Malaysia" },
      commentCount: 3,
      attachmentCount: 1,
      fields: {
        status: "PYM_SOLVED",
        member_id: "64612",
        brand: "HOT321",
        query_type: "Withdrawal delay",
        amount: "220",
        transaction_id: "149251",
        payment_gateway: "SuperPay",
        remarks: "Customer confirmed the payment was received.",
        attachment: [{ name: "payment-receipt.png" }],
      },
      comments: [
        { author: "R. Maxine", role: "CS agent", time: "29 Sep · 8:31 PM", body: "Customer reported that withdrawal 149251 was still pending after the expected processing time." },
        { author: "Derin", role: "Payment team", time: "29 Sep · 8:47 PM", body: "Checked with the provider. The transaction was released and should appear in the customer account shortly." },
        { author: "R. Maxine", role: "CS agent", time: "29 Sep · 9:03 PM", body: "Customer confirmed receipt. Marking this case as solved." },
      ],
    };
  }
}

function ensureChatState(chat) {
  if (state[chat.chatId]) {
    applyPreviewSampleState(chat);
    return;
  }
  state[chat.chatId] = {
    username: "", matchedRow: undefined, otherBrandMatches: [], caRecordId: null, claimedPrograms: {},
    liveChatAccount: currentLiveChatAccount,
    vs96FeedbackQuery1: "", vs96FeedbackQuery2: "", riskReloadAmount: "",
    logs: [], caseNo: 1, loggedSnapshot: "",
    notVipResult: false, forcedVipFor: "",
    gracePeriodActivated: false,
    brand: deriveBrandFromGroup(chat.groupName),
    escalation: {
      memberUserId: "", brand: deriveFullBrandCode(chat.groupName), queries: "",
      status: "", transactionId: "", paymentGateway: "", remarks: "", vipLevel: "", amount: "",
      departmentId: "", marketId: "",
    },
    escalationSubmitted: false, escalationError: "", ticketAttachmentError: "",
    ticketRef: "", ticketLookupRef: "", ticketRecord: null, ticketSearchQuery: "",
    ticketView: "list", ticketInboxFilter: "all", ticketFiltersOpen: false, ticketAdditionalOpen: false,
    ticketExplorerAgent: "all", ticketExplorerStatus: "all", ticketExplorerDepartment: "all", ticketExplorerMarket: "all",
    lastUsernameStarted: false, lastUsernameLoading: false,
    lastUsernameChecked: false, lastUsernameFound: false, lastUsernameValue: "",
    inquiry: [], status: "", telegram: chat.isTelegram, telegramManual: false, logged: false, dob: "", dobView: null,
    releasedBonusAmount: "", releasedAmountRaw: "", claimSecret: false,
    usernameDraft: "",
    isUnknown: false,
    chatUrl: "",
    chatOpen: true, autoRecordError: "",
    lookupInFlight: false,
    expanded: false,
    dobCalendarOpen: false,
  };
  applyPreviewSampleState(chat);
}

function resetPreviewCard(chatId) {
  if (!previewMode) return;
  const chat = SAMPLE_CHATS.find((item) => item.chatId === chatId);
  if (!chat) return;
  showPreviewClosedChat = false;
  delete state[chatId];
  ticketAttachmentsByChat.delete(chatId);
  lastSyncedJson.delete(chatId);
  ensureChatState(chat);
  state[chatId].expanded = true;
  renderChats(activeChats);
  renderNeedsAttentionPanel();
  setStatus("Preview test reset. No Lark record was changed.", "success");
}

function focusableFieldSelector(el) {
  if (el.classList.contains("ticket-search-input")) return ".ticket-search-input";
  if (el.classList.contains("username-input")) return ".username-input";
  if (el.classList.contains("inquiry-search")) return ".inquiry-search";
  if (el.classList.contains("amount-input")) return ".amount-input";
  if (el.classList.contains("note-input")) return ".note-input";
  if (el.classList.contains("status-search")) return ".status-search";
  if (el.classList.contains("brand-search")) return ".brand-search";
  if (el.classList.contains("dob-cal-month-search")) return ".dob-cal-month-search";
  if (el.classList.contains("dob-cal-year-search")) return ".dob-cal-year-search";
  if (el.classList.contains("esc-input") && el.dataset.field) {
    return `.esc-input[data-field="${el.dataset.field}"]`;
  }
  return null;
}

const SEARCH_BOX_OPTIONS = {
  ".inquiry-search": [".inquiry-dropdown", renderInquiryDropdown],
  ".status-search": [".status-dropdown", renderStatusDropdown],
  ".brand-search": [".brand-options", renderBrandOptions],
  ".dob-cal-month-search": [".dob-cal-month-options", renderDobMonthOptions],
  ".dob-cal-year-search": [".dob-cal-year-options", renderDobYearOptions],
};

function captureFocus() {
  const el = document.activeElement;
  if (!el || !chatListEl.contains(el)) return null;
  const selector = focusableFieldSelector(el);
  if (!selector) return null;
  const chatId = el.closest(".chat-card")?.dataset.chatId;
  if (!chatId) return null;
  return { chatId, selector, value: el.value, selectionStart: el.selectionStart, selectionEnd: el.selectionEnd };
}

function restoreFocus(captured) {
  if (!captured) return;
  const card = chatListEl.querySelector(`.chat-card[data-chat-id="${captured.chatId}"]`);
  const el = card?.querySelector(captured.selector);
  if (!el) return;
  if (el.value !== captured.value) {
    el.value = captured.value;
    const optionsTarget = SEARCH_BOX_OPTIONS[captured.selector];
    if (optionsTarget) {
      const [optionsSelector, renderOptions] = optionsTarget;
      const optionsEl = card.querySelector(optionsSelector);
      if (optionsEl) optionsEl.innerHTML = renderOptions(captured.chatId, captured.value);
    }
  }
  el.focus();
  try { el.setSelectionRange(captured.selectionStart, captured.selectionEnd); } catch (_) { }
}

function renderChats(chats) {
  const focusCapture = captureFocus();
  renderChatsInner(chats);
  restoreFocus(focusCapture);
}

const TICKETS_ONLY_CHAT_ID = "tickets-only";
function ticketsOnlyChat() {
  return { chatId: TICKETS_ONLY_CHAT_ID, groupName: "", link: "", isTelegram: false };
}
function renderChatsInner(chats) {
  chatListEl.innerHTML = "";

  if (!chats.length) {
    if ((previewMode || DEPARTMENT_TABS_LIVE) && activeMainTab === "tickets") {
      chats = [ticketsOnlyChat()];
    } else {
      chatListEl.innerHTML = `<div class="empty-state">No chat currently open — select a conversation in LiveChat to see it here.</div>`;
      return;
    }
  }

  for (const chat of chats) {
    ensureChatState(chat);
  }
  if ((previewMode || DEPARTMENT_TABS_LIVE) && activeMainTab === "tickets") {
    const chat = chats[0];
    const card = document.createElement("div");
    card.className = "chat-card ticket-workspace-card";
    card.dataset.chatId = chat.chatId;
    void checkTicketAccount(chat.chatId);
    card.innerHTML = renderAdminTicketWorkspace(chat);
    chatListEl.appendChild(card);
    if (ticketWorkspaceView(state[chat.chatId]) === "list" && !ticketSearchResultsByChat.has(chat.chatId) && !ticketAccountBlocks()) void refreshTicketInbox(chat.chatId, "", "all", { fresh: false });
    return;
  }
  if (!hasAutoExpandedOnce && chats.length) {
    state[chats[0].chatId].expanded = true;
    hasAutoExpandedOnce = true;
  }

  for (const chat of chats) {
    const s = state[chat.chatId];
    const expanded = previewMode ? s.expanded : true;

    const card = document.createElement("div");
    card.className = "chat-card"
      + (s.autoRecordError ? " needs-attention" : "")
      + (expanded ? "" : " collapsed");
    card.dataset.chatId = chat.chatId;
    card.innerHTML = expanded ? renderExpandedCard(chat) : renderCollapsedCard(chat);

    chatListEl.appendChild(card);
  }
}

const DROPDOWN_STATE_KEY = {
  "inquiry-dropdown": "inquiryDropdownOpen",
  "status-dropdown": "statusDropdownOpen",
  "brand-dropdown": "brandDropdownOpen",
  "dob-calendar": "dobCalendarOpen",
};

function closeAllDropdowns() {
  document.querySelectorAll(".inquiry-dropdown, .status-dropdown, .brand-dropdown, .dob-calendar, .dob-cal-jump-dropdown").forEach((d) => {
    d.classList.add("hidden");
    const chatId = d.closest(".chat-card")?.dataset.chatId;
    const s = chatId && state[chatId];
    if (!s) return;
    for (const cls of d.classList) {
      const key = DROPDOWN_STATE_KEY[cls];
      if (key) s[key] = false;
    }
  });
}

function refreshCasesSlotLater(e) {
  const id = e.target.closest && e.target.closest(".chat-card")?.dataset.chatId;
  if (!id) return;
  setTimeout(() => {
    const card = chatListEl.querySelector(`.chat-card[data-chat-id="${id}"]`);
    const slot = card && card.querySelector(".cases-slot");
    if (slot && state[id]) slot.innerHTML = renderCasesBar(id);
  }, 0);
}
["click", "input", "change"].forEach((t) => chatListEl.addEventListener(t, refreshCasesSlotLater));
chatListEl.addEventListener("toggle", (event) => {
  const ticketDetails = event.target.closest?.("details[data-ticket-disclosure]");
  if (ticketDetails) {
    const s = state[ticketDetails.dataset.chat];
    const key = ticketDetails.dataset.ticketDisclosure;
    if (s && ["ticketDetailsOpen", "ticketFilesOpen", "ticketAdditionalOpen"].includes(key)) s[key] = ticketDetails.open;
    return;
  }
  const details = event.target.closest?.(".bonus-admin-embed");
  if (!details?.open) return;
  const frame = details.querySelector("iframe[data-src]");
  if (frame && !frame.src) frame.src = frame.dataset.src;
}, true);

chatListEl.addEventListener("input", (e) => {
  const noteBox = e.target.closest(".note-input");
  if (noteBox) {
    const id = noteBox.closest(".chat-card")?.dataset.chatId;
    if (id) {
      const ui = noteUi(id);
      ui.draft = noteBox.value;
      if (ui.kind === "ok") { ui.msg = ""; ui.kind = ""; }
      const counter = noteBox.closest(".ca-note-section")?.querySelector(".note-count");
      if (counter) counter.textContent = `${ui.draft.length} / ${CONSOLE_NOTE_MAX}`;
    }
    return;
  }
  const input = e.target.closest(".username-input");
  if (!input) return;
  const id = input.closest(".chat-card")?.dataset.chatId;
  if (id && state[id]) state[id].usernameDraft = input.value;
});

chatListEl.addEventListener("keydown", (event) => {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target;
  const card = target.closest?.(".chat-card");

  if (event.key === "Enter" && !event.shiftKey && target.matches?.(".ticket-comment-input")) {
    event.preventDefault();
    const button = card?.querySelector('button[data-action="sendTicketComment"]');
    if (button && !button.disabled) button.click();
    return;
  }

  if (event.key === "Enter" && target.matches?.(".username-input, .ticket-search-input")) {
    const action = target.matches(".username-input")
      ? "lookup"
      : "searchTickets";
    const button = card?.querySelector(`button[data-action="${action}"]`);
    if (button && !button.disabled) {
      event.preventDefault();
      button.click();
    }
    return;
  }

  const inputConfig = [
    [".inquiry-search", ".inquiry-dropdown", ".inquiry-option"],
    [".status-search", ".status-dropdown", ".inquiry-option"],
    [".brand-search", ".brand-dropdown", ".inquiry-option"],
    [".dob-cal-month-search", ".dob-cal-month-dropdown", ".dob-cal-jump-option"],
    [".dob-cal-year-search", ".dob-cal-year-dropdown", ".dob-cal-jump-option"],
    [".ticket-choice-search", ".ticket-choice-menu", ".ticket-choice-option"],
  ].find(([inputSelector]) => target.matches?.(inputSelector));

  if (inputConfig) {
    const [, containerSelector, optionSelector] = inputConfig;
    const container = target.closest(containerSelector) || card?.querySelector(containerSelector);
    const options = keyboardDropdownOptions(container, optionSelector);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusKeyboardOption(options, null, event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      options[0]?.click();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeKeyboardDropdown(target);
    }
    return;
  }

  const option = target.closest?.(".inquiry-option, .dob-cal-jump-option, .ticket-choice-option");
  if (option) {
    const container = option.closest(".inquiry-dropdown, .status-dropdown, .brand-dropdown, .dob-cal-jump-dropdown, .ticket-choice-menu");
    const optionSelector = option.classList.contains("dob-cal-jump-option")
      ? ".dob-cal-jump-option"
      : option.classList.contains("ticket-choice-option") ? ".ticket-choice-option" : ".inquiry-option";
    const options = keyboardDropdownOptions(container, optionSelector);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusKeyboardOption(options, option, event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? options[0] : options[options.length - 1];
      next?.focus();
      next?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeKeyboardDropdown(option);
    }
    return;
  }

  const dropdownTrigger = target.closest?.(
    ".brand-display, .ticket-choice-trigger, [data-action=\"toggleDobMonthDropdown\"], [data-action=\"toggleDobYearDropdown\"]"
  );
  if (dropdownTrigger && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    const wasOpen = dropdownTrigger.getAttribute("aria-expanded") === "true"
      || !dropdownTrigger.closest(".brand-picker, .dob-cal-jump-picker, .ticket-choice")
        ?.querySelector(".brand-dropdown, .dob-cal-jump-dropdown, .ticket-choice-menu")?.classList.contains("hidden");
    if (!wasOpen) dropdownTrigger.click();
    setTimeout(() => {
      const wrapper = dropdownTrigger.closest(".brand-picker, .dob-cal-jump-picker, .ticket-choice");
      const container = wrapper?.querySelector(".brand-dropdown, .dob-cal-jump-dropdown, .ticket-choice-menu");
      const selector = container?.classList.contains("brand-dropdown")
        ? ".inquiry-option"
        : container?.classList.contains("ticket-choice-menu") ? ".ticket-choice-option" : ".dob-cal-jump-option";
      const options = keyboardDropdownOptions(container, selector);
      focusKeyboardOption(options, null, event.key === "ArrowDown" ? 1 : -1);
    }, 0);
  }
});

chatListEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const chatId = btn.dataset.chat;
  let card = btn.closest(".chat-card");
  const s = state[chatId];

  try {

  if (btn.dataset.action === "openTicketImage") {
    const img = btn.querySelector("img");
    if (btn.dataset.fallbackUrl) window.open(btn.dataset.fallbackUrl, "_blank", "noopener");
    else if (img && img.src) openTicketImageLightbox(img.src, img.alt || "Picture");
    return;
  }

  if (btn.dataset.action === "removeCommentFile") {
    const row = btn.closest(".ticket-comment-files-row");
    const files = ticketCommentFilesByChat.get(chatId) || [];
    const [gone] = files.splice(Number(btn.dataset.index), 1);
    try { URL.revokeObjectURL(gone?._preview); } catch (_) { }
    if (files.length) ticketCommentFilesByChat.set(chatId, files); else ticketCommentFilesByChat.delete(chatId);
    if (s) s.commentFileError = "";
    if (row) row.innerHTML = renderCommentFiles(chatId);
    return;
  }

  if (btn.dataset.action === "resetPreview") {
    resetPreviewCard(chatId);
    return;
  }

  if (btn.dataset.action === "toggleAttentionPreview") {
    if (!previewMode) return;
    showPreviewClosedChat = !showPreviewClosedChat;
    s.previewClosedUnrecorded = showPreviewClosedChat;
    if (showPreviewClosedChat) {
      s.autoRecordError = "Chat ended without Inquiry or Status — not recorded";
      s.chatOpen = false;
      s.logged = false;
      s.inquiry = [];
      s.status = "";
    } else {
      delete s.autoRecordError;
      delete s.previewClosedUnrecorded;
      s.chatOpen = true;
    }
    renderChats(activeChats);
    renderNeedsAttentionPanel();
    if (showPreviewClosedChat) {
      document.getElementById("needsAttentionList")?.classList.remove("hidden");
      document.getElementById("needsAttentionToggle")?.classList.add("open");
    }
    return;
  }

  if (btn.dataset.action === "copyPlayerName") {
    const fullName = s.matchedRow?.customerName;
    await copyPlainText(fullName);
    btn.textContent = "✓";
    btn.classList.add("copied");
    btn.title = "Copied";
    setTimeout(() => {
      if (!btn.isConnected) return;
      btn.innerHTML = COPY_ICON_SVG;
      btn.classList.remove("copied");
      btn.title = "Copy full name";
    }, 1200);
    return;
  }

  if (btn.dataset.action === "removeTicketAttachment") {
    const files = [...(ticketAttachmentsByChat.get(chatId) || [])];
    files.splice(Number(btn.dataset.index), 1);
    if (files.length) ticketAttachmentsByChat.set(chatId, files);
    else ticketAttachmentsByChat.delete(chatId);
    s.ticketAttachmentError = "";
    card.querySelector(".escalation-slot").innerHTML = renderEscalationSection(chatId);
    return;
  }

  if (btn.dataset.action === "toggleTicketChoice") {
    const choice = btn.closest(".ticket-choice");
    const menu = choice?.querySelector(".ticket-choice-menu");
    if (!menu) return;
    const willOpen = menu.classList.contains("hidden");
    document.querySelectorAll(".ticket-choice-menu").forEach((item) => item.classList.add("hidden"));
    document.querySelectorAll(".ticket-choice-trigger").forEach((item) => item.setAttribute("aria-expanded", "false"));
    if (willOpen) {
      menu.classList.remove("hidden");
      btn.setAttribute("aria-expanded", "true");
      menu.querySelector(".ticket-choice-search")?.focus();
    }
    return;
  }

  if (btn.dataset.action === "selectTicketChoice") {
    if (btn.dataset.field.startsWith("filter:")) {
      applyTicketFilter(chatId, btn.dataset.field.slice(7), btn.dataset.value || "all");
      return;
    }
    if (btn.dataset.field === "bulk:status") {
      if (!ticketBulkFor(chatId).running) { ticketBulkFor(chatId).status = btn.dataset.value || ""; renderTicketSlot(chatId); }
      return;
    }
    if (btn.dataset.field.startsWith("edit:")) {
      const name = btn.dataset.field.slice(5);
      const value = btn.dataset.value || "";
      ticketLiveTyping(chatId, name, value);
      void commitTicketChange(chatId, ticketChangeFor(name, value));
      return;
    }
    s.escalation[btn.dataset.field] = btn.dataset.value || "";
    if (btn.dataset.field === "marketId") s.escalation.marketTouched = true;
    card.querySelector(".escalation-slot").innerHTML = renderEscalationSection(chatId);
    return;
  }

  if (btn.dataset.action === "bulkSelectAll") {
    ticketBulkSelectAll(chatId);
    renderTicketSlot(chatId);
    return;
  }
  if (btn.dataset.action === "bulkApplyStatus") {
    await applyBulkStatus(chatId);
    return;
  }

  if (btn.dataset.action === "removeTicketAssignee") {
    void commitTicketChange(chatId, { type: "assigneeRemove", value: btn.dataset.id });
    return;
  }

  if (btn.dataset.action === "toggleTicketBell") {
    ticketBellOpen = !ticketBellOpen;
    repaintTicketBell();
    return;
  }
  if (btn.dataset.action === "ticketNoteTab") {
    ticketNoteTab = ["mentions", "comments"].includes(btn.dataset.value) ? btn.dataset.value : "all";
    repaintTicketBell();
    return;
  }
  if (btn.dataset.action === "ticketNoteReadAll") {
    ticketNoteMarkRead("");
    repaintTicketBell();
    return;
  }
  if (btn.dataset.action === "ticketNoteSound") {
    const store = ticketNoteLoad();
    store.sound = store.sound === false;
    ticketNoteSave();
    if (store.sound) ticketNoteChime();
    repaintTicketBell();
    return;
  }

  if (["ticketInbox", "filterTicketInbox", "toggleTicketFilters", "clearTicketFilters"].includes(btn.dataset.action)) {
    if (btn.dataset.action === "ticketInbox") { s.ticketView = "list"; s.escalationError = ""; }
    if (btn.dataset.action === "filterTicketInbox") s.ticketInboxFilter = btn.dataset.value;
    if (btn.dataset.action === "toggleTicketFilters") {
      s.ticketFiltersOpen = !s.ticketFiltersOpen;
      if (s.ticketFiltersOpen && !ticketAccountBlocks()) void loadTicketAgentRoster(chatId);
    }
    if (btn.dataset.action === "clearTicketFilters") {
      s.ticketInboxFilter = "all";
      for (const key of ["ticketExplorerAgent", "ticketExplorerStatus", "ticketExplorerDepartment", "ticketExplorerMarket"]) s[key] = "all";
    }
    renderTicketSlot(chatId);
    if (!ticketSearchResultsByChat.has(chatId) && !ticketAccountBlocks()) void refreshTicketInbox(chatId, "", "all", { fresh: false });
    else if (btn.dataset.action === "clearTicketFilters" && ticketListStale(chatId)) void refreshTicketInbox(chatId, ticketSearchResultsByChat.get(chatId).query || "", ticketSearchResultsByChat.get(chatId).mode || "all", { fresh: false });
    saveState();
    return;
  }

  if (btn.dataset.action === "loadAllTickets") {
    void loadAllTickets(chatId);
    return;
  }

  if (btn.dataset.action === "searchTickets") {
    if (ticketSearchResultsByChat.get(chatId)?.loading || ticketDetailInFlight.has(chatId)) return;
    const query = String(s.ticketSearchQuery || "").trim();
    s.escalationError = "";
    if (/^TK[A-Z0-9]+$/i.test(query)) {
      s.ticketView = "detail";
      if (s.ticketRecord?.ref !== query.toUpperCase()) s.ticketRecord = null;
      ticketDetailInFlight.add(chatId);
      renderTicketSlot(chatId);
      try {
        await loadTicketStatus(chatId, query, { silent: true });
      } catch (err) {
        s.escalationError = "Ticket lookup failed: " + err.message;
      } finally {
        ticketDetailInFlight.delete(chatId);
      }
      renderTicketSlot(chatId);
    } else {
      s.ticketView = "list";
      await refreshTicketInbox(chatId, query, query ? "search" : "all");
    }
    return;
  }

  if (btn.dataset.action === "loadAllTickets") {
    await refreshTicketInbox(chatId, s.ticketSearchQuery || "", s.ticketSearchQuery ? "search" : "all");
    return;
  }

  if (btn.dataset.action === "openTicketResult") {
    if (ticketDetailInFlight.has(chatId)) return;
    ticketBellOpen = false;
    ticketNoteMarkRead(btn.dataset.ref);
    paintTicketsTabBadge();
    s.ticketView = "detail";
    if (s.ticketRecord?.ref !== btn.dataset.ref) s.ticketRecord = null;
    ticketDetailInFlight.add(chatId);
    renderTicketSlot(chatId);
    try {
      await loadTicketStatus(chatId, btn.dataset.ref, { silent: true });
      s.escalationError = "";
    } catch (err) {
      s.escalationError = "Ticket lookup failed: " + err.message;
    } finally {
      ticketDetailInFlight.delete(chatId);
    }
    card.querySelector(".escalation-slot").innerHTML = renderEscalationSection(chatId);
    return;
  }

  if (btn.dataset.action === "noteType") {
    const ui = noteUi(chatId);
    if (!ui.busy && CONSOLE_NOTE_TYPES[btn.dataset.type]) { ui.type = btn.dataset.type; ui.msg = ""; ui.kind = ""; ui.notes = null; paintNoteSection(chatId); }
    return;
  }
  if (btn.dataset.action === "saveNote" || btn.dataset.action === "loadNotes") {
    if (btn.dataset.action === "saveNote") await saveConsoleNote(chatId); else await loadConsoleNotes(chatId);
    return;
  }

  if (btn.dataset.action === "cancelLookup") {
    const controller = lookupControllers.get(chatId);
    if (s?.lookupInFlight && controller) {
      btn.disabled = true;
      btn.textContent = "Stopping…";
      controller.abort();
    } else {
      if (s) s.lookupInFlight = false;
      renderChats(activeChats);
    }
    return;
  }

  if (btn.dataset.action === "lookup") {
    if (!selectedAgent && !previewMode) { openSettingsPanel(); return; }
    if (s.lookupInFlight) return;
    const username = card.querySelector(".username-input").value.trim();
    if (!username) { setStatus("Enter a username before looking up.", "error"); return; }
    if (!s.brand && detectedBrandFor.has(chatId)) s.brand = detectedBrandFor.get(chatId);
    const brand = s.brand;
    if (!brand) {
      if (groupIdFor.has(chatId)) resolveBrandFromGroupId(chatId, groupIdFor.get(chatId));
      setStatus("Brand hasn't been auto-detected yet for this chat — pick it from the Brand box, or try again in a moment.", "error");
      return;
    }
    s.username = username;
    s.usernameDraft = "";
    if (!s.escalation.memberUserId) s.escalation.memberUserId = username;
    const chatDef = activeChats.find((c) => c.chatId === chatId);
    const telegramNow = card.querySelector(".tg-check").checked;
    const forcing = !!s.notVipResult;
    if (forcing) { s.isUnknown = false; reportUnknownTick(chatId, false, true); }
    const previousRecordId = (!s.logged && s.caRecordId && ownsCaseRecord(s)) ? s.caRecordId : null;
    await runLookup(chatId, { username, brand, telegramNow, link: s.chatUrl || chatDef?.link || "", previousRecordId, forcing, btn });
  }

  if (btn.dataset.action === "halloweenPick") {
    if (!s || s.claimedPrograms.halloween) return;
    const field = btn.dataset.field;
    const value = btn.dataset.value;
    if (field === "choice") s.halloweenChoice = value;
    if (field === "shared") {
      s.halloweenShared = value === "yes";
      if (!s.halloweenShared) { s.halloweenMethod = ""; s.halloweenPostLink = ""; }
    }
    if (field === "method") s.halloweenMethod = value;
    saveState();
    card.querySelector(".ticket-slot").innerHTML = renderTickets(chatId);
    return;
  }

  if (btn.dataset.action === "claim") {
    const programKey = btn.dataset.program;
    const r = s.matchedRow;

    if (programKey === "halloween") {
      await claimHalloween(chatId, btn, card);
      return;
    }

    if (programKey === "vs96Feedback" && (
      !String(s.vs96FeedbackQuery1 || "").trim()
      || !String(s.vs96FeedbackQuery2 || "").trim()
    )) {
      setStatus("Collect and fill in both VS96 feedback answers before claiming.", "error");
      return;
    }

    const riskClaim = programKey === "riskPlayer"
      ? riskPlayerCalculation(r?.riskPlayer, s.riskReloadAmount)
      : null;
    if (riskClaim && !riskClaim.valid) {
      setStatus("Enter the customer's reload amount before claiming Risk Player.", "error");
      return;
    }

    if (programKey === "gracePeriod") {
      const display = r.gracePeriod || "";
      if (/^\s*pass\b/i.test(display)) {
        s.gracePeriodActivated = true;
        s.inquiry = ["Grace Period"];
        s.status = "Activated";
      } else {
        const amount = graceClaimAmount(display);
        if (!(await raiseClaimTicket(chatId, "gracePeriod", amount))) return;
        card = chatListEl.querySelector(`.chat-card[data-chat-id="${chatId}"]`) || card;
        s.claimedPrograms.gracePeriod = true;
        logCaseOrigin(chatId, "gracePeriod claimed");
        s.inquiry = ["Grace Period"];
        s.status = "Given";
        if (!s.claimSecretManual) s.claimSecret = true;
        s.releasedBonusAmount = amount || display;
        s.releasedAmountRaw = amount || display;
        reportClaim(chatId, { program: "gracePeriod", label: "Grace Period", source: display, inquiry: "Grace Period", amount });
        if (!s.escalation.amount && amount) s.escalation.amount = amount;
      }
      card.querySelector(".ticket-slot").innerHTML = renderTickets(chatId);
      card.querySelector(".auto-fields-slot").innerHTML = renderAutoFields(chatId);
      refreshInquiryChips(card, chatId);
      card.querySelector(".inquiry-dropdown").innerHTML = renderInquiryDropdown(chatId, "");
      refreshStatusChip(card, chatId);
      card.querySelector(".status-dropdown").innerHTML = renderStatusDropdown(chatId);
      if (s.claimedPrograms.gracePeriod && !previewMode) {
        await submitRecord(chatId, { auto: true, reason: "Grace Period claimed" });
      }
      return;
    }

    if (programKey !== "gracePeriod" && AUTO_TICKET_PROGRAMS[programKey]) {
      const ticketAmount = riskClaim?.valid ? riskClaim.formattedClaim : programHasAmount(programKey) ? extractAmountNumber(r?.[programKey]) : "";
      if (!(await raiseClaimTicket(chatId, programKey, ticketAmount))) return;
      card = chatListEl.querySelector(`.chat-card[data-chat-id="${chatId}"]`) || card;
    }

    if (!previewMode && (programKey === "telegram28" || programKey === "redeemCode" || programKey === "specialReload")) {
      const source = r[programKey];
      const chatDef = activeChats.find((c) => c.chatId === chatId);
      btn.disabled = true;
      btn.textContent = "…";
      claimWriteInFlight.add(chatId);
      try {
        const res = await fetch("/lark-claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: programKey, recordId: source.recordId, chatLink: chatDef?.link || "" }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Claim failed");
      } catch (err) {
        setStatus("Claim failed: " + err.message, "error");
        btn.disabled = false;
        btn.textContent = "Claim";
        return;
      } finally {
        claimWriteInFlight.delete(chatId);
      }
    }

    s.claimedPrograms[programKey] = true;
    logCaseOrigin(chatId, `${programKey} claimed`);
    const allSources = [
      ...allBonusPrograms().map((p) => ({ key: p.key, label: p.label, display: r[p.key] })),
      { key: "telegram28", label: "Telegram RM28", display: r.telegram28?.status },
      { key: "redeemCode", label: "Redeem Code", display: r.redeemCode?.status },
      { key: "specialReload", label: "Special Reload (Ang Pao)", display: r.specialReload?.status },
    ];
    const claimedSources = allSources.filter((src) => s.claimedPrograms[src.key] && programHasAmount(src.key));
    const claimedAmount = riskClaim?.valid
      ? riskClaim.formattedClaim
      : claimedSources.map((src) => extractAmountNumber(src.display)).filter(Boolean).join(" | ");
    s.releasedBonusAmount = claimedAmount;
    s.releasedAmountRaw = claimedAmount;
    if (!s.claimSecretManual) s.claimSecret = true;
    if (!s.escalation.amount && claimedAmount) {
      s.escalation.amount = claimedAmount.split(" | ")[0];
    }

    const mappedInquiry = resolveInquiryForProgram(programKey, r[programKey]);
    if (mappedInquiry) {
      s.inquiry = [mappedInquiry];
    }

    s.status = "Given";
    const claimedSource = allSources.find((src) => src.key === programKey);
    reportClaim(chatId, {
      program: programKey, label: claimedSource?.label || programKey, source: String(claimedSource?.display ?? ""), inquiry: mappedInquiry || "",
      amount: riskClaim?.valid ? riskClaim.formattedClaim : programHasAmount(programKey) ? extractAmountNumber(claimedSource?.display) : "",
    });

    card.querySelector(".ticket-slot").innerHTML = renderTickets(chatId);
    card.querySelector(".auto-fields-slot").innerHTML = renderAutoFields(chatId);
    refreshInquiryChips(card, chatId);
    card.querySelector(".inquiry-dropdown").innerHTML = renderInquiryDropdown(chatId, "");
    refreshStatusChip(card, chatId);
    card.querySelector(".status-dropdown").innerHTML = renderStatusDropdown(chatId);

    if (!previewMode) {
      await submitRecord(chatId, { auto: true, reason: `${allSources.find((src) => src.key === programKey)?.label || "Bonus"} claimed` });
    } else {
      setStatus("Preview claim simulated. No Lark record was created or updated.", "success");
    }
  }

  if (btn.dataset.action === "unclaim") {
    if (s.unclaimInFlight) return;
    const programKey = btn.dataset.program;
    const wasGraceActivationOnly = programKey === "gracePeriod" && s.gracePeriodActivated && !s.claimedPrograms.gracePeriod;
    s.unclaimInFlight = true;
    btn.disabled = true;
    try {
      if (programKey === "halloween") await undoHalloween(chatId);
      if (!previewMode && s.logged && s.caRecordId && !s.isUnknown) {
        const res = await fetch("/lark-record", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recordId: s.caRecordId, unclaim: true, agentName: selectedAgent, username: s.username }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Unclaim failed");
      }
    } catch (err) {
      s.unclaimInFlight = false;
      btn.disabled = false;
      setStatus("Unclaim failed: " + err.message, "error");
      return;
    }
    s.unclaimInFlight = false;
    reportClaim(chatId, null);

    const prevFirstAmount = String(s.releasedBonusAmount || "").split(" | ")[0];
    if (wasGraceActivationOnly) s.gracePeriodActivated = false;
    s.claimedPrograms = {};
    s.inquiry = [];
    s.status = "";
    s.releasedBonusAmount = "";
    s.releasedAmountRaw = "";
    s.claimSecret = false;
    s.claimSecretManual = false;
    if (prevFirstAmount && s.escalation.amount === prevFirstAmount) s.escalation.amount = "";
    s.logged = false;
    s.loggedSnapshot = "";
    s.autoRecordError = "";
    if (s.chatOpen && activeChats[0]?.chatId === chatId) startChatStatusPolling(chatId);

    const special = programKey === "telegram28" || programKey === "redeemCode" || programKey === "specialReload";
    setStatus(special
      ? "Unclaimed — record cleared. The source table's Claimed status was left as is."
      : "Unclaimed — Inquiry, Status, Amount and Claim Secret cleared.", "success");
    card.querySelector(".ticket-slot").innerHTML = renderTickets(chatId);
    card.querySelector(".auto-fields-slot").innerHTML = renderAutoFields(chatId);
    refreshInquiryChips(card, chatId);
    card.querySelector(".inquiry-dropdown").innerHTML = renderInquiryDropdown(chatId, "");
    refreshStatusChip(card, chatId);
    card.querySelector(".status-dropdown").innerHTML = renderStatusDropdown(chatId);
    renderChats(activeChats);
  }

  if (btn.dataset.action === "reactivateGracePeriod") {
    const wasClaimed = !!s.claimedPrograms.gracePeriod;
    s.gracePeriodActivated = true;
    s.claimedPrograms.gracePeriod = false;
    s.inquiry = ["Grace Period"];
    s.status = "Activated";
    if (wasClaimed) {
      s.releasedBonusAmount = "";
      s.releasedAmountRaw = "";
      s.claimSecret = false;
      s.claimSecretManual = false;
    }
    logDiagnostic("Grace Period reactivated — customer can attempt the challenge again today.", "success");
    card.querySelector(".ticket-slot").innerHTML = renderTickets(chatId);
    card.querySelector(".auto-fields-slot").innerHTML = renderAutoFields(chatId);
    refreshInquiryChips(card, chatId);
    card.querySelector(".inquiry-dropdown").innerHTML = renderInquiryDropdown(chatId, "");
    refreshStatusChip(card, chatId);
    card.querySelector(".status-dropdown").innerHTML = renderStatusDropdown(chatId);
  }

  if (btn.dataset.action === "toggleInquiry" || btn.dataset.action === "removeInquiry") {
    const val = btn.dataset.value;
    if (s.inquiry.includes(val)) {
      s.inquiry = s.inquiry.filter((v) => v !== val);
    } else if (btn.dataset.action === "toggleInquiry") {
      if (s.inquiry.length >= 2) {
        setStatus("Only 2 inquiries can be selected per case.", "error");
      } else if (s.inquiry.length === 1 && s.inquiry[0] !== "Feedback" && val !== "Feedback") {
        setStatus('When picking 2 inquiries, one of them must be "Feedback".', "error");
      } else {
        s.inquiry.push(val);
        logCaseOrigin(chatId, "inquiry picked");
      }
    }
    const searchInput = card.querySelector(".inquiry-search");
    if (searchInput) { searchInput.value = ""; searchInput.blur(); }
    refreshInquiryChips(card, chatId);
    card.querySelector(".inquiry-dropdown").innerHTML = renderInquiryDropdown(chatId, "");
    card.querySelector(".inquiry-dropdown").classList.add("hidden");
    s.inquiryDropdownOpen = false;
  }

  if (btn.dataset.action === "addCase") {
    await addCaseFlow(chatId);
  }

  if (btn.dataset.action === "editCase") {
    await editCaseFlow(chatId, Number(btn.dataset.case));
  }

  if (btn.dataset.action === "saveCase") {
    if (addingCaseFor.has(chatId)) return;
    addingCaseFor.add(chatId);
    try { await resyncLoggedRecord(chatId); } finally { addingCaseFor.delete(chatId); }
    renderChats(activeChats);
  }

  if (btn.dataset.action === "submit") {
    await submitRecord(chatId, { auto: false });
  }

  if (btn.dataset.action === "submitEscalation") {
    if (ticketCreateInFlight.has(chatId)) return;
    const e = s.escalation;
    if (!e.departmentId || !e.memberUserId || !e.brand || !e.queries) {
      s.escalationError = "Destination Department, Member/User ID, Brand, and Query type are required.";
      card.querySelector(".escalation-slot").innerHTML = renderEscalationSection(chatId);
      return;
    }
    const fields = {};
    for (const spec of TICKET_FIELD_SPECS) {
      const field = ticketFieldFor(spec);
      const value = e[spec.stateKey];
      if (!field || value === "" || value === null || value === undefined) continue;
      if (field.type === "NUMBER" || field.type === "CURRENCY") {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) {
          s.escalationError = `${field.label} must be a number.`;
          card.querySelector(".escalation-slot").innerHTML = renderEscalationSection(chatId);
          return;
        }
        fields[field.key] = numericValue;
      } else {
        fields[field.key] = value;
      }
    }
    const selectedDepartment = ticketDepartments.find((item) => String(item.id) === String(e.departmentId));
    if (!selectedDepartment) {
      s.escalationError = "Choose a valid destination department.";
      card.querySelector(".escalation-slot").innerHTML = renderEscalationSection(chatId);
      return;
    }
    fields.toDepartment = selectedDepartment.code || selectedDepartment.name;
    if (e.marketId) {
      const selectedMarket = ticketMarkets.find((item) => String(item.id) === String(e.marketId));
      if (!selectedMarket) {
        s.escalationError = "Choose a valid market.";
        card.querySelector(".escalation-slot").innerHTML = renderEscalationSection(chatId);
        return;
      }
      fields.market = selectedMarket.code || selectedMarket.label;
    }
    btn.disabled = true;
    btn.textContent = "Creating…";
    let failure = null;
    ticketCreateInFlight.add(chatId);
    try {
      const files = ticketAttachmentsByChat.get(chatId) || [];
      const agentToken = liveChatAgentTokens()[currentLiveChatAccount];
      const author = agentToken && currentLiveChatAccount ? { accountKey: currentLiveChatAccount, agentToken, ticketEmail: s.escalation.ticketEmail || storedTicketEmail(currentLiveChatAccount) } : undefined;
      let requestBody;
      let headers;
      if (files.length) {
        const form = new FormData();
        form.append("ticket", JSON.stringify({ fields, author }));
        const attachmentField = ticketAttachmentField();
        const partName = attachmentField?.key || attachmentField?.label || "Attachment";
        for (const file of files) form.append(partName, file, file.name);
        requestBody = form;
      } else {
        headers = { "Content-Type": "application/json" };
        requestBody = JSON.stringify({ fields, author });
      }
      const res = await fetch("/ticket-create", { method: "POST", headers, body: requestBody });
      const data = await res.json();
      if (!data.ok) { failure = data; if (data.needTicketEmail) s.ticketEmailNeeded = true; throw new Error(data.error || "Submit failed"); }
      s.ticketRef = data.ref;
      s.ticketNotice = data.warning || "";
      s.ticketEmailNeeded = false;
      noteTicketAccountUsed(data);
      if (s.escalation.ticketEmail) storeTicketEmail(currentLiveChatAccount, s.escalation.ticketEmail);
      s.ticketLookupRef = data.ref;
      s.escalationSubmitted = true;
      s.ticketView = "detail";
      s.escalationError = "";
      s.ticketAttachmentError = "";
      ticketAttachmentsByChat.delete(chatId);
      ticketSearchResultsByChat.delete(chatId);
      try { await loadTicketStatus(chatId, data.ref); } catch (_) { }
      setStatus(`Ticket ${data.ref} created.`, "success");
    } catch (err) {
      s.escalationError = "Ticket creation failed: " + err.message;
      if (failure) showTicketProblem(chatId, failure, () => resubmitTicket(chatId));
    } finally {
      ticketCreateInFlight.delete(chatId);
    }
    saveState();
    card.querySelector(".escalation-slot").innerHTML = renderEscalationSection(chatId);
  }

  if (btn.dataset.action === "recheckTicketAccount") {
    await checkTicketAccount(chatId, { force: true });
    return;
  }

  if (btn.dataset.action === "enterTicketEmail") {
    showTicketProblem(chatId, { needTicketEmail: true, triedEmail: ticketAccount.email, error: "Enter the email of your ticket-system account." }, () => checkTicketAccount(chatId, { force: true }));
    return;
  }

  if (btn.dataset.action === "replyTicketComment") {
    s.commentReplyTo = Number(btn.dataset.comment) || null;
    renderTicketSlot(chatId);
    return;
  }

  if (btn.dataset.action === "cancelReplyTicketComment") {
    s.commentReplyTo = null;
    renderTicketSlot(chatId);
    return;
  }

  if (btn.dataset.action === "sendTicketComment") {
    await sendTicketComment(chatId);
    return;
  }

  if (btn.dataset.action === "lookupTicket") {
    const refInput = card.querySelector(".ticket-ref-input");
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      await loadTicketStatus(chatId, refInput?.value);
      setStatus(`Ticket ${s.ticketRecord.ref} status refreshed.`, "success");
    } catch (err) {
      s.escalationError = "Status lookup failed: " + err.message;
    }
    card.querySelector(".escalation-slot").innerHTML = renderEscalationSection(chatId);
  }

  if (btn.dataset.action === "newTicket") {
    s.ticketView = "create";
    s.escalationSubmitted = false;
    s.ticketRef = "";
    s.ticketNotice = "";
    s.ticketRecord = null;
    s.escalationError = "";
    s.ticketAttachmentError = "";
    renderTicketSlot(chatId);
    void applyDefaultMarketToNewTicket(chatId);
    saveState();
  }

  if (btn.dataset.action === "toggleExpand") {
    const wasExpanded = s.expanded;
    Object.values(state).forEach((st) => { st.expanded = false; });
    s.expanded = !wasExpanded;
    renderChats(activeChats);
  }

  if (btn.dataset.action === "selectStatus") {
    s.status = btn.dataset.value;
    logCaseOrigin(chatId, "status picked");
    s.statusDropdownOpen = false;
    const searchInput = card.querySelector(".status-search");
    if (searchInput) { searchInput.value = ""; searchInput.blur(); }
    refreshStatusChip(card, chatId);
    card.querySelector(".status-dropdown").innerHTML = renderStatusDropdown(chatId, "");
    card.querySelector(".status-dropdown").classList.add("hidden");
  }

  if (btn.dataset.action === "clearStatus") {
    s.status = "";
    s.statusDropdownOpen = false;
    refreshStatusChip(card, chatId);
    card.querySelector(".status-dropdown").innerHTML = renderStatusDropdown(chatId, "");
    card.querySelector(".status-dropdown").classList.add("hidden");
  }

  if (btn.dataset.action === "toggleBrandDropdown") {
    const dropdown = card.querySelector(".brand-dropdown");
    const willOpen = dropdown.classList.contains("hidden");
    closeAllDropdowns();
    if (willOpen) {
      dropdown.classList.remove("hidden");
      s.brandDropdownOpen = true;
      dropdown.querySelector(".brand-search")?.focus();
    }
  }

  if (btn.dataset.action === "selectBrand") {
    s.brand = btn.dataset.value;
    s.brandDropdownOpen = false;
    card.querySelector(".brand-display").innerHTML = renderBrandDisplay(chatId);
    card.querySelector(".brand-dropdown").innerHTML = renderBrandDropdown(chatId);
    card.querySelector(".brand-dropdown").classList.add("hidden");
  }

  if (btn.dataset.action === "toggleDobCalendar") {
    const cal = card.querySelector(".dob-calendar");
    const willOpen = cal.classList.contains("hidden");
    closeAllDropdowns();
    if (willOpen) {
      s.dobCalendarOpen = true;
      cal.innerHTML = renderDobCalendar(chatId);
      cal.classList.remove("hidden");
    }
  }

  if (btn.dataset.action === "dobNavMonth") {
    if (!s.dobView) renderDobCalendar(chatId);
    let { year, month } = s.dobView;
    month += Number(btn.dataset.dir);
    if (month < 0) { month = 11; year--; }
    if (month > 11) { month = 0; year++; }
    s.dobView = { year, month };
    card.querySelector(".dob-calendar").innerHTML = renderDobCalendar(chatId);
  }

  if (btn.dataset.action === "toggleDobMonthDropdown") {
    const dropdown = card.querySelector(".dob-cal-month-dropdown");
    const willOpen = dropdown.classList.contains("hidden");
    document.querySelectorAll(".dob-cal-jump-dropdown").forEach((d) => d.classList.add("hidden"));
    if (willOpen) {
      dropdown.classList.remove("hidden");
      dropdown.querySelector(".dob-cal-month-search")?.focus();
    }
  }

  if (btn.dataset.action === "toggleDobYearDropdown") {
    const dropdown = card.querySelector(".dob-cal-year-dropdown");
    const willOpen = dropdown.classList.contains("hidden");
    document.querySelectorAll(".dob-cal-jump-dropdown").forEach((d) => d.classList.add("hidden"));
    if (willOpen) {
      dropdown.classList.remove("hidden");
      dropdown.querySelector(".dob-cal-year-search")?.focus();
    }
  }

  if (btn.dataset.action === "selectDobMonthValue") {
    s.dobView = { year: s.dobView.year, month: Number(btn.dataset.value) };
    card.querySelector(".dob-calendar").innerHTML = renderDobCalendar(chatId);
  }

  if (btn.dataset.action === "selectDobYearValue") {
    s.dobView = { year: Number(btn.dataset.value), month: s.dobView.month };
    card.querySelector(".dob-calendar").innerHTML = renderDobCalendar(chatId);
  }

  if (btn.dataset.action === "selectDobDay") {
    s.dob = btn.dataset.value;
    const [y, m] = s.dob.split("-").map(Number);
    s.dobView = { year: y, month: m - 1 };
    s.dobCalendarOpen = false;
    card.querySelector(".dob-display").innerHTML = renderDobDisplay(chatId);
    card.querySelector(".dob-calendar").classList.add("hidden");
  }

  if (btn.dataset.action === "dobClear") {
    s.dob = "";
    s.dobCalendarOpen = false;
    card.querySelector(".dob-display").innerHTML = renderDobDisplay(chatId);
    card.querySelector(".dob-calendar").classList.add("hidden");
  }

  if (btn.dataset.action === "dobToday") {
    const t = new Date();
    s.dob = `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
    s.dobView = { year: t.getFullYear(), month: t.getMonth() };
    s.dobCalendarOpen = false;
    card.querySelector(".dob-display").innerHTML = renderDobDisplay(chatId);
    card.querySelector(".dob-calendar").classList.add("hidden");
  }

  } catch (err) {
    console.error("Action failed:", btn.dataset.action, err);
    setStatus(`Something went wrong (${btn.dataset.action}): ` + err.message, "error");
  } finally {
    saveState();
  }
});

chatListEl.addEventListener("input", (e) => {
  const ticketChoiceSearch = e.target.closest(".ticket-choice-search");
  if (ticketChoiceSearch) {
    const menu = ticketChoiceSearch.closest(".ticket-choice-menu");
    const query = ticketChoiceSearch.value.trim().toLowerCase();
    let visible = 0;
    menu?.querySelectorAll(".ticket-choice-option").forEach((option) => {
      const matches = !query || String(option.dataset.search || "").includes(query);
      option.classList.toggle("hidden", !matches);
      if (matches) visible++;
    });
    menu?.querySelector(".ticket-choice-empty")?.classList.toggle("hidden", visible > 0);
    return;
  }
  const feedbackInput = e.target.closest(".vs96-feedback-input");
  if (feedbackInput) {
    const chatId = feedbackInput.dataset.chat;
    const s = state[chatId];
    if (!s) return;
    if (feedbackInput.dataset.feedback === "query1") s.vs96FeedbackQuery1 = feedbackInput.value;
    if (feedbackInput.dataset.feedback === "query2") s.vs96FeedbackQuery2 = feedbackInput.value;
    const ticket = feedbackInput.closest(".ticket-vs96");
    const complete = !!(
      String(s.vs96FeedbackQuery1 || "").trim()
      && String(s.vs96FeedbackQuery2 || "").trim()
    );
    ticket?.classList.toggle("feedback-complete", complete);
    const claimBtn = ticket?.querySelector('.claim-btn[data-program="vs96Feedback"]');
    if (claimBtn && claimBtn.dataset.action === "claim") {
      const anotherClaimIsActive = Object.entries(s.claimedPrograms || {})
        .some(([key, value]) => key !== "vs96Feedback" && value);
      claimBtn.disabled = !complete || anotherClaimIsActive;
      claimBtn.title = complete ? "" : "Fill in both player feedback answers first";
    }
    const note = ticket?.querySelector(".vs96-feedback-note");
    if (note) note.textContent = complete
      ? "✓ Both feedback answers collected"
      : "Fill in both feedback answers before claiming.";
    saveState();
    return;
  }
  const halloweenField = e.target.closest(".hw-deposit, .hw-link");
  if (halloweenField) {
    const chatId = halloweenField.dataset.chat;
    const s = state[chatId];
    if (!s) return;
    if (halloweenField.classList.contains("hw-deposit")) {
      const cleaned = halloweenField.value.replace(/[^0-9.]/g, "");
      const decimalAt = cleaned.indexOf(".");
      halloweenField.value = decimalAt < 0
        ? cleaned
        : cleaned.slice(0, decimalAt + 1) + cleaned.slice(decimalAt + 1).replaceAll(".", "");
      s.halloweenDeposit = halloweenField.value;
    } else {
      s.halloweenPostLink = halloweenField.value;
    }
    patchHalloweenCard(chatId, halloweenField);
    saveState();
    return;
  }
  const riskReloadInput = e.target.closest(".risk-reload-input");
  if (riskReloadInput) {
    const chatId = riskReloadInput.dataset.chat;
    const s = state[chatId];
    if (!s) return;
    const cleaned = riskReloadInput.value.replace(/[^0-9.]/g, "");
    const decimalAt = cleaned.indexOf(".");
    riskReloadInput.value = decimalAt < 0
      ? cleaned
      : cleaned.slice(0, decimalAt + 1) + cleaned.slice(decimalAt + 1).replaceAll(".", "");
    s.riskReloadAmount = riskReloadInput.value;
    const calculation = riskPlayerCalculation(s.matchedRow?.riskPlayer, s.riskReloadAmount);
    const ticket = riskReloadInput.closest(".ticket-risk-player");
    const preview = ticket?.querySelector(".risk-claim-preview");
    preview?.classList.toggle("ready", calculation.valid);
    const value = ticket?.querySelector(".risk-claim-value");
    if (value) value.textContent = calculation.valid ? `RM${calculation.formattedClaim}` : "—";
    const claimBtn = ticket?.querySelector('.claim-btn[data-program="riskPlayer"]');
    if (claimBtn && claimBtn.dataset.action === "claim") {
      const anotherClaimIsActive = Object.entries(s.claimedPrograms || {})
        .some(([key, active]) => key !== "riskPlayer" && active);
      claimBtn.disabled = !calculation.valid || anotherClaimIsActive;
      claimBtn.title = calculation.valid ? "" : "Enter the customer reload amount first";
    }
    saveState();
    return;
  }
  const inquiryInput = e.target.closest(".inquiry-search");
  if (inquiryInput) {
    const card = inquiryInput.closest(".chat-card");
    card.querySelector(".inquiry-dropdown").innerHTML = renderInquiryDropdown(card.dataset.chatId, inquiryInput.value);
    return;
  }
  const statusSearch = e.target.closest(".status-search");
  if (statusSearch) {
    const card = statusSearch.closest(".chat-card");
    card.querySelector(".status-dropdown").innerHTML = renderStatusDropdown(card.dataset.chatId, statusSearch.value);
    return;
  }
  const brandSearch = e.target.closest(".brand-search");
  if (brandSearch) {
    const card = brandSearch.closest(".chat-card");
    card.querySelector(".brand-options").innerHTML = renderBrandOptions(card.dataset.chatId, brandSearch.value);
    return;
  }
  const dobMonthSearch = e.target.closest(".dob-cal-month-search");
  if (dobMonthSearch) {
    const card = dobMonthSearch.closest(".chat-card");
    card.querySelector(".dob-cal-month-options").innerHTML = renderDobMonthOptions(card.dataset.chatId, dobMonthSearch.value);
    return;
  }
  const dobYearSearch = e.target.closest(".dob-cal-year-search");
  if (dobYearSearch) {
    const card = dobYearSearch.closest(".chat-card");
    card.querySelector(".dob-cal-year-options").innerHTML = renderDobYearOptions(card.dataset.chatId, dobYearSearch.value);
    return;
  }
  const ticketRefInput = e.target.closest(".ticket-ref-input");
  if (ticketRefInput) {
    const s = state[ticketRefInput.dataset.chat];
    if (s) s.ticketLookupRef = ticketRefInput.value;
    return;
  }
  const ticketSearchInput = e.target.closest(".ticket-search-input");
  if (ticketSearchInput) {
    const s = state[ticketSearchInput.dataset.chat];
    if (s) s.ticketSearchQuery = ticketSearchInput.value;
    return;
  }
  const escInput = e.target.closest(".esc-input");
  if (escInput) {
    const s = state[escInput.dataset.chat];
    if (escInput.dataset.ticketNumeric === "true") {
      const cleaned = escInput.value.replace(/[^0-9.]/g, "");
      const decimalAt = cleaned.indexOf(".");
      escInput.value = decimalAt < 0
        ? cleaned
        : cleaned.slice(0, decimalAt + 1) + cleaned.slice(decimalAt + 1).replaceAll(".", "");
    }
    if (escInput.dataset.field.startsWith("edit:")) ticketLiveTyping(escInput.dataset.chat, escInput.dataset.field.slice(5), escInput.value);
    else if (s) s.escalation[escInput.dataset.field] = escInput.value;
    return;
  }
  const amountInput = e.target.closest(".amount-input");
  if (amountInput) {
    const s = state[amountInput.dataset.chat];
    if (s) {
      s.releasedBonusAmount = amountInput.value;
      s.releasedAmountRaw = amountInput.value;
    }
    return;
  }
  const usernameInput = e.target.closest(".username-input");
  if (usernameInput) {
    const card = usernameInput.closest(".chat-card");
    const s = state[card?.dataset.chatId];
    if (s) s.username = usernameInput.value;
  }
});

chatListEl.addEventListener("change", (e) => {
  const liveInput = e.target.closest(".ticket-live-input");
  if (liveInput && liveInput.dataset.field?.startsWith("edit:")) {
    const name = liveInput.dataset.field.slice(5);
    void commitTicketChange(liveInput.dataset.chat, ticketChangeFor(name, liveInput.value));
    return;
  }
  const bulkTick = e.target.closest(".ticket-bulk-tick");
  if (bulkTick) {
    ticketBulkToggle(bulkTick.dataset.chat, bulkTick.dataset.ref, bulkTick.checked);
    renderTicketSlot(bulkTick.dataset.chat);
    return;
  }
  const attachmentInput = e.target.closest(".ticket-attachment-input");
  if (attachmentInput) {
    const chatId = attachmentInput.dataset.chat;
    const slot = attachmentInput.closest(".escalation-slot");
    Promise.all(Array.from(attachmentInput.files).map(compressPicture)).then((prepared) => {
      addTicketAttachments(chatId, prepared);
      slot.innerHTML = renderEscalationSection(chatId);
    });
    return;
  }
  const secretCheck = e.target.closest(".secret-check");
  if (secretCheck) {
    const s = state[secretCheck.dataset.chat];
    if (s) {
      s.claimSecret = secretCheck.checked;
      s.claimSecretManual = true;
      const label = secretCheck.closest(".auto-value")?.querySelector(".secret-label");
      if (label) label.textContent = s.claimSecret ? "✓ Ticked" : "— Not ticked";
      if (s.logged) resyncLoggedRecord(secretCheck.dataset.chat);
      saveState();
    }
    return;
  }
  const tgCheck = e.target.closest(".tg-check");
  if (tgCheck) {
    const s = state[tgCheck.dataset.chat];
    if (s) {
      s.telegram = tgCheck.checked;
      s.telegramManual = true;
    }
    return;
  }
  const escSelect = e.target.closest(".esc-select");
  if (escSelect) {
    const s = state[escSelect.dataset.chat];
    if (s) s.escalation[escSelect.dataset.field] = escSelect.value;
    return;
  }
  const unknownCheck = e.target.closest(".unknown-check");
  if (unknownCheck) {
    const uState = state[unknownCheck.dataset.chat];
    if (uState) uState.notVipResult = false;
    setUnknown(unknownCheck.dataset.chat, unknownCheck.checked);
    renderChats(activeChats);
    saveState();
  }
});

function reportUnknownTick(chatId, ticked, auto) {
  const s = state[chatId];
  if (previewMode || !s || !selectedAgent) return;
  const live = String(s.chatUrl || "").match(/\/chats\/([^/?#]+)\/([^/?#]+)/);
  const archived = String(s.chatUrl || "").match(/\/archives\/([^/?#]+)/);
  const threadId = live ? live[2] : archived ? archived[1] : "";
  const body = { agentName: selectedAgent, ticked, source: auto ? "auto" : "manual", threadId, chatId: live ? live[1] : String(chatId) };
  fetch("/unknown-tick", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
}

function reportClaim(chatId, claim) {
  const s = state[chatId];
  if (previewMode || !s || !selectedAgent) return;
  const live = String(s.chatUrl || "").match(/\/chats\/([^/?#]+)\/([^/?#]+)/);
  const archived = String(s.chatUrl || "").match(/\/archives\/([^/?#]+)/);
  const threadId = live ? live[2] : archived ? archived[1] : "";
  const body = { agentName: selectedAgent, threadId, chatId: live ? live[1] : String(chatId), ...(claim ? { claim } : { remove: true }) };
  fetch("/claim-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
}

function setUnknown(chatId, value, { silent = false } = {}) {
  const s = state[chatId];
  if (!s) return;
  s.isUnknown = value;
  reportUnknownTick(chatId, value, silent);
  if (value && unrecordedChats.some((chat) => chat.threadId === chatId)) resolveUnrecorded(chatId, "Ignored");
  if (value) removeStaleRecordsForChat(chatId, silent);
  if (!s.isUnknown || !s.caRecordId) return;

  if (previewMode) {
    s.caRecordId = null;
    s.logged = false;
    s.loggedSnapshot = "";
    s.autoRecordError = "";
    return;
  }

  const hasClaim = Object.values(s.claimedPrograms || {}).some(Boolean);
  if (hasClaim) {
    if (!silent) setStatus("Marked Unknown, but its Lark record was kept because a bonus is claimed on it. Unclaim the bonus first if the record should be removed.", "error");
    return;
  }

  const staleRecordId = s.caRecordId;
  if (!ownsCaseRecord(s)) {
    s.caRecordId = null;
    s.logged = false;
    s.loggedSnapshot = "";
    return;
  }
  s.caRecordId = null;
  s.logged = false;
  s.loggedSnapshot = "";
  s.autoRecordError = "";
  const restore = () => { forgetDeletedRecord(staleRecordId); if (!s.caRecordId) s.caRecordId = staleRecordId; };
  rememberDeletedRecord(staleRecordId);
  fetch("/lark-delete-record", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recordId: staleRecordId, agentName: selectedAgent }),
  }).then((res) => res.json()).then((data) => {
    if (!data.ok) {
      restore();
      logDiagnostic(`Failed to remove the record for this Unknown-marked chat: ${data.error}`, "warn");
      if (!silent) setStatus("Couldn't remove the record from Lark Base: " + data.error, "error");
    } else if (!silent) {
      setStatus("Unknown player — the record was removed from Lark Base.", "success");
    }
  }).catch(() => {
    restore();
    if (!silent) setStatus("Couldn't reach Lark to remove the record.", "error");
  });
}

function removeStaleRecordsForChat(chatId, silent) {
  const s = state[chatId];
  if (previewMode || !selectedAgent || !s) return;
  if (Object.values(s.claimedPrograms || {}).some(Boolean)) return;
  const link = String(s.chatUrl || "").match(/\/(?:chats\/[^/?#]+\/|archives\/)([^/?#]+)/);
  const threads = new Set([String(chatId), link ? link[1] : ""].filter(Boolean));
  const rows = staleRecords.filter((r) => r.threadId && threads.has(String(r.threadId)) && r.recordId !== s.caRecordId);
  for (const row of rows) {
    rememberDeletedRecord(row.recordId);
    fetch("/lark-stale-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentName: selectedAgent, deleteRecordId: row.recordId }),
    }).then((res) => res.json()).then((data) => {
      if (!data.ok) throw new Error(data.error || "Remove failed");
      staleRecords = staleRecords.filter((r) => r.recordId !== row.recordId);
      renderNeedsAttentionPanel();
      if (!silent) setStatus("Unknown player — the leftover record was removed from Lark Base.", "success");
    }).catch((err) => {
      forgetDeletedRecord(row.recordId);
      logDiagnostic(`Failed to remove the leftover record for this Unknown-marked chat: ${err.message}`, "warn");
      if (!silent) setStatus("Couldn't remove the leftover record from Lark Base: " + err.message, "error");
    });
  }
  if (rows.length) renderNeedsAttentionPanel();
}

const MERGED_SEARCH_BOXES = [
  { search: ".inquiry-search", box: ".inquiry-box", wrapper: ".inquiry-select", dropdown: ".inquiry-dropdown", stateKey: "inquiryDropdownOpen" },
  { search: ".status-search", box: ".status-box", wrapper: ".status-picker", dropdown: ".status-dropdown", stateKey: "statusDropdownOpen" },
];

chatListEl.addEventListener("focusin", (e) => {
  for (const cfg of MERGED_SEARCH_BOXES) {
    const input = e.target.closest(cfg.search);
    if (!input) continue;
    closeAllDropdowns();
    input.closest(cfg.wrapper)?.querySelector(cfg.dropdown)?.classList.remove("hidden");
    const chatId = input.closest(".chat-card")?.dataset.chatId;
    if (chatId && state[chatId]) state[chatId][cfg.stateKey] = true;
    return;
  }
});

chatListEl.addEventListener("click", (e) => {
  if (e.target.closest(".inquiry-chip-remove, .status-chip-slot .inquiry-chip-remove")) return;
  for (const cfg of MERGED_SEARCH_BOXES) {
    const box = e.target.closest(cfg.box);
    if (!box) continue;
    const searchInput = box.querySelector(cfg.search);
    if (e.target === searchInput) return;
    const dropdown = box.closest(cfg.wrapper)?.querySelector(cfg.dropdown);
    if (dropdown && !dropdown.classList.contains("hidden")) {
      dropdown.classList.add("hidden");
      const chatId = box.closest(".chat-card")?.dataset.chatId;
      if (chatId && state[chatId]) state[chatId][cfg.stateKey] = false;
      searchInput?.blur();
    } else {
      searchInput?.focus();
    }
    return;
  }
});

document.addEventListener("click", (e) => {
  const path = e.composedPath();
  document.querySelectorAll(".inquiry-select, .status-picker, .brand-picker, .dob-picker, .dob-cal-jump-picker").forEach((wrap) => {
    if (path.includes(wrap)) return;
    const dropdown = wrap.querySelector(".inquiry-dropdown, .status-dropdown, .brand-dropdown, .dob-calendar, .dob-cal-jump-dropdown");
    if (!dropdown) return;
    dropdown.classList.add("hidden");
    const chatId = wrap.closest(".chat-card")?.dataset.chatId;
    const s = chatId && state[chatId];
    if (!s) return;
    for (const cls of dropdown.classList) {
      const key = DROPDOWN_STATE_KEY[cls];
      if (key) s[key] = false;
    }
  });
});

const recordSubmitInFlight = new Map();
const recordRetryTimers = new Map();
const recordRetryAttempts = new Map();

function clearRecordRetry(chatId) {
  const timer = recordRetryTimers.get(chatId);
  if (timer) clearTimeout(timer);
  recordRetryTimers.delete(chatId);
  recordRetryAttempts.delete(chatId);
}

function keyboardDropdownOptions(container, selector) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(selector)).filter((option) => (
    !option.disabled
    && !option.classList.contains("disabled")
    && !option.classList.contains("hidden")
  ));
}

function focusKeyboardOption(options, current, direction) {
  if (!options.length) return;
  const currentIndex = options.indexOf(current);
  const nextIndex = currentIndex < 0
    ? (direction > 0 ? 0 : options.length - 1)
    : (currentIndex + direction + options.length) % options.length;
  options[nextIndex].focus();
  options[nextIndex].scrollIntoView({ block: "nearest" });
}

function closeKeyboardDropdown(target, { restoreFocus = true } = {}) {
  const ticketMenu = target.closest(".ticket-choice-menu");
  if (ticketMenu) {
    ticketMenu.classList.add("hidden");
    const trigger = ticketMenu.closest(".ticket-choice")?.querySelector(".ticket-choice-trigger");
    trigger?.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger?.focus();
    return;
  }

  const dropdown = target.closest(".inquiry-dropdown, .status-dropdown, .brand-dropdown, .dob-cal-jump-dropdown");
  if (!dropdown) return;
  dropdown.classList.add("hidden");
  const card = dropdown.closest(".chat-card");
  const s = card && state[card.dataset.chatId];
  if (s) {
    if (dropdown.classList.contains("inquiry-dropdown")) s.inquiryDropdownOpen = false;
    if (dropdown.classList.contains("status-dropdown")) s.statusDropdownOpen = false;
    if (dropdown.classList.contains("brand-dropdown")) s.brandDropdownOpen = false;
  }
  if (!restoreFocus) return;
  const trigger = dropdown.classList.contains("inquiry-dropdown")
    ? card?.querySelector(".inquiry-search")
    : dropdown.classList.contains("status-dropdown")
      ? card?.querySelector(".status-search")
      : dropdown.classList.contains("brand-dropdown")
        ? card?.querySelector(".brand-display")
        : dropdown.classList.contains("dob-cal-month-dropdown")
          ? card?.querySelector('[data-action="toggleDobMonthDropdown"]')
          : card?.querySelector('[data-action="toggleDobYearDropdown"]');
  trigger?.focus();
}

async function writeLarkRecord(payload) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("/lark-record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      let data;
      try { data = await res.json(); } catch (_) { data = null; }
      if (!res.ok || !data?.ok) {
        const err = new Error(data?.error || `Record failed (${res.status || "network error"})`);
        err.retryable = !res.status || res.status >= 500;
        throw err;
      }
      return data;
    } catch (err) {
      lastError = err;
      const retryable = err?.retryable || err instanceof TypeError || /failed to fetch|network/i.test(String(err?.message || ""));
      if (!retryable || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
    }
  }
  throw lastError || new Error("Record failed");
}

function scheduleRecordRetry(chatId) {
  const s = state[chatId];
  if (!s || s.logged || recordRetryTimers.has(chatId)) return;
  const attempt = (recordRetryAttempts.get(chatId) || 0) + 1;
  recordRetryAttempts.set(chatId, attempt);
  const delay = Math.min(5_000 * (2 ** (attempt - 1)), 60_000);
  const timer = setTimeout(async () => {
    recordRetryTimers.delete(chatId);
    const current = state[chatId];
    if (!current || current.logged || current.isUnknown) return clearRecordRetry(chatId);
    await submitRecord(chatId, { auto: true, reason: "Retrying the interrupted save" });
  }, delay);
  recordRetryTimers.set(chatId, timer);
}

function shouldResumeInterruptedSave(s) {
  return !!(s && !s.logged && !s.isUnknown && s.caRecordId && s.username && s.brand
    && (s.inquiry || []).length && s.status
    && /failed to fetch|network|save interrupted/i.test(String(s.autoRecordError || "")));
}

async function resyncLoggedRecord(chatId) {
  const s = state[chatId];
  if (previewMode) return true;
  if (!s || !s.logged || !s.caRecordId || s.isUnknown) return false;
  if (!s.inquiry.length || !s.status) {
    setStatus("Add an inquiry and a status before saving.", "error");
    return false;
  }
  try {
    await writeLarkRecord({
        recordId: s.caRecordId,
        username: s.username,
        agentName: selectedAgent,
        brand: s.brand,
        inquiry: s.inquiry,
        status: s.status,
        releasedAmount: s.releasedBonusAmount,
        releasedAmountRaw: s.releasedAmountRaw,
        claimSecret: s.claimSecret,
        chatLink: s.chatUrl || activeChats.find((c) => c.chatId === chatId)?.link || "",
        dob: s.dob || "",
        telegram: !!s.telegram,
        vs96FeedbackQuery1: s.vs96FeedbackQuery1 || "",
        vs96FeedbackQuery2: s.vs96FeedbackQuery2 || "",
      });
    markCaseRecorded(s);
    setStatus("Changes saved to Lark Base.", "success");
    return true;
  } catch (err) {
    setStatus("Couldn't update Lark: " + err.message, "error");
    return false;
  }
}

async function submitRecord(chatId, options = {}) {
  if (recordSubmitInFlight.has(chatId)) return recordSubmitInFlight.get(chatId);
  const task = submitRecordOnce(chatId, options);
  recordSubmitInFlight.set(chatId, task);
  try {
    return await task;
  } finally {
    if (recordSubmitInFlight.get(chatId) === task) recordSubmitInFlight.delete(chatId);
  }
}

async function submitRecordOnce(chatId, { auto, reason } = {}) {
  const s = state[chatId];
  if (previewMode) return;
  if (!s || s.logged) return;
  const card = chatListEl.querySelector(`.chat-card[data-chat-id="${chatId}"]`);
  const reasonText = reason || "Chat closed";

  if (s.isUnknown) {
    s.logged = true;
    s.autoRecordError = "";
    logDiagnostic(`Chat closed — marked Unknown, not recorded.`, "success");
    renderChats(activeChats);
    renderNeedsAttentionPanel();
    return;
  }

  if (isLoggingPaused()) {
    if (!auto) setStatus("Logging is paused while you are on another tab — go back to Retention to record this chat.", "error");
    return;
  }

  if (auto && (!agentActed(s) || (AGENT_LOGIN_LIVE && caseNeverLookedUp(s)))) {
    if (!(await agentWroteInChat(chatId))) {
      if (!s.logged && s.autoRecordError) s.autoRecordError = "";
      return;
    }
    if (s.logged) return;
  }

  if (!selectedAgent) {
    if (auto) {
      s.autoRecordError = `${reasonText}, but no agent name is set — open Settings (⚙), then fill in and record manually.`;
      logDiagnostic(s.autoRecordError, "error");
      renderChats(activeChats);
    } else {
      setStatus("Set your agent name in Settings (⚙) before recording.", "error");
      openSettingsPanel();
    }
    return;
  }

  if (s.caRecordId && !ownsCaseRecord(s)) {
    const msg = `This case's Lark record belongs to ${s.caOwner}. Press Look up to log your own record — theirs is kept.`;
    if (auto) {
      s.autoRecordError = msg;
      logDiagnostic(msg, "warn");
      renderChats(activeChats);
    } else {
      setStatus(msg, "error");
    }
    return;
  }

  s.agentName = selectedAgent;
  s.liveChatAccount = currentLiveChatAccount;

  const brand = s.brand || "";
  const status = s.status || "";

  const missing = [];
  if (!s.username) missing.push("username");
  if (!s.caRecordId) missing.push("look up the username");
  if (!brand) missing.push("brand");
  if (!s.inquiry.length) missing.push("inquiry");
  if (!status) missing.push("status");

  if (missing.length) {
    if (auto) {
      s.autoRecordError = `${reasonText} but not fully filled in (missing: ${missing.join(", ")}) — complete it and click Record to Lark Base.`;
      const missingKey = missing.join(",");
      if (autoMissingLoggedFor.get(chatId) !== missingKey) {
        autoMissingLoggedFor.set(chatId, missingKey);
        logDiagnostic(s.autoRecordError, "error");
      }
      renderChats(activeChats);
    } else {
      setStatus(`Missing before recording: ${missing.join(", ")}.`, "error");
    }
    return;
  }

  s.autoRecordError = "";
  const submitBtn = card?.querySelector('button[data-action="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Recording…"; }

  try {
    await writeLarkRecord({
        recordId: s.caRecordId,
        username: s.username,
        agentName: selectedAgent,
        brand: s.brand,
        inquiry: s.inquiry,
        status: s.status,
        releasedAmount: s.releasedBonusAmount,
        releasedAmountRaw: s.releasedAmountRaw,
        claimSecret: s.claimSecret,
        chatLink: s.chatUrl || activeChats.find((c) => c.chatId === chatId)?.link || "",
        dob: s.dob || "",
        telegram: !!s.telegram,
        vs96FeedbackQuery1: s.vs96FeedbackQuery1 || "",
        vs96FeedbackQuery2: s.vs96FeedbackQuery2 || "",
      });
    s.logged = true;
    clearRecordRetry(chatId);
    markCaseRecorded(s);
    saveState();
    setStatus(`Logged ${s.username} to Lark Base${auto ? ` (auto — ${reasonText.toLowerCase()})` : ""}.`, "success");
    renderChats(activeChats);
    renderNeedsAttentionPanel();
    scheduleNeedsAttentionRefresh(200);
  } catch (err) {
    if (auto) {
      s.autoRecordError = `Save interrupted (${err.message}) — retrying automatically.`;
      logDiagnostic(s.autoRecordError, "error");
      renderChats(activeChats);
      scheduleRecordRetry(chatId);
    } else {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Record to Lark Base";
      }
      setStatus("Recording failed: " + err.message, "error");
    }
  }
}

const DIAGNOSTICS_LOG_MAX = 50;
const diagnosticsLog = [];

function logDiagnostic(text, kind) {
  diagnosticsLog.unshift({ time: new Date(), text, kind: kind || "info" });
  if (diagnosticsLog.length > DIAGNOSTICS_LOG_MAX) diagnosticsLog.length = DIAGNOSTICS_LOG_MAX;
}

function setStatus(text, kind) {
  logDiagnostic(text, kind);
  if (kind === "error") {
    statusEl.textContent = text;
    statusEl.className = "status-bar error";
  } else {
    statusEl.textContent = "";
    statusEl.className = "status-bar hidden";
  }
}

const OPTIONS_REFRESH_MS = 10 * 60_000;
async function refreshDropdownOptions({ fresh = false } = {}) {
  const loaded = await fetchBootstrapOptions({ fresh });
  if (!loaded) {
    await Promise.allSettled([
      fetchAgentOptions({ fresh }), fetchBrandOptions({ fresh }), fetchInquiryOptions({ fresh }),
      fetchStatusOptions({ fresh }), fetchConfiguredBonusPrograms({ fresh }),
    ]);
  }
  if (!IS_EMBEDDED_APP || DEPARTMENT_TABS_LIVE || AUTO_TICKET_LIVE) await fetchTicketConfig({ fresh });
}
setInterval(() => {
  if (!document.hidden) refreshDropdownOptions();
}, OPTIONS_REFRESH_MS);

function handleRefreshClick() {
  if (window.deploymentUpdatePending?.()) {
    if (!window.canRefreshForDeployment()) {
      showChatToast("Finish or cancel your current lookup / claim / ticket / Blast first, then click ⟳ again.", "warn");
      return;
    }
    window.prepareForDeploymentRefresh();
    if (window.reloadForDeploymentUpdate() === "already-tried") {
      showChatToast("This update was already tried in this tab. Give it a minute to finish publishing, then click ⟳ again.", "info");
    }
    return;
  }
  refreshDropdownOptions({ fresh: true });
  fetchUnrecordedChats();
  if (liveWidget) {
    const profile = liveWidget.getCustomerProfile();
    const currentChatId = activeChats[0]?.chatId;
    const nextChatId = profile?.chat?.id ? String(profile.chat.id) : "";
    const currentState = currentChatId ? state[currentChatId] : null;
    const hasPendingLookup = !!(currentState && (currentState.usernameDraft || currentState.lookupInFlight));
    if (currentChatId && currentChatId !== nextChatId && hasPendingLookup) {
      const pending = currentState.lookupInFlight ? "lookup in progress" : `unsent username “${currentState.usernameDraft}”`;
      showChatToast(`Refresh kept this chat open — ${pending}. Finish or cancel it before switching chats.`, "info");
    } else {
      applyProfile(profile);
      setStatus("Refreshed from LiveChat.", "success");
    }
  } else {
    setStatus("Preview mode — showing sample chats until connected to LiveChat.");
    renderChats(activeChats);
  }
}
document.getElementById("refreshBtn").addEventListener("click", handleRefreshClick);
document.getElementById("settingsBtn").addEventListener("click", () => openSettingsPanel());

function setBlastLoggingLock(active) {
  const next = Boolean(active);
  if (next === blastLoggingLock) return;
  blastLoggingLock = next;
  logDiagnostic(next ? "Chat logging paused automatically while Blast is running." : "Blast finished; chat logging restored.", next ? "warn" : "success");
  renderChats(activeChats);
}

window.addEventListener("message", async (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type === "blast-run-state") {
    if (event.source !== document.querySelector('#blastView iframe')?.contentWindow) return;
    blastRunInProgress = Boolean(event.data.running);
    syncMainTabs();
    if (blastRunInProgress) { try { sessionStorage.setItem(MAIN_TAB_SESSION_KEY, "blast"); } catch (_) {} }
    setBlastLoggingLock(Boolean(event.data.active));
    return;
  }
  if (event.data?.type !== "bonus-config-changed") return;
  await fetchConfiguredBonusPrograms();
  renderChats(activeChats);
});

function runWhenIdle(task, timeout = 1500) {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(task, { timeout });
  } else {
    setTimeout(task, Math.min(timeout, 500));
  }
}

(async () => {
  Object.assign(state, loadPersistedState());
  for (const chatId of Object.keys(state)) markStateSynced(chatId);
  if (!IS_EMBEDDED_APP) logDiagnostic("Preview mode — showing sample chats until connected to LiveChat.");
  applyDepartmentChrome();
  syncMainTabs();
  updateAgentBadge();
  renderChats(activeChats);

  initLiveChatSdk();

  const optionsReady = refreshDropdownOptions();
  if (TICKET_DEMO) selectedAgent = "Demo Agent";
  else if (AGENT_LOGIN_LIVE) await requireAgentLogin();
  if (PREVIEW_LOGIN_GATE) {
    try {
      await requirePreviewLiveChatLogin();
    } catch (error) {
      logDiagnostic(`LiveChat login setup failed: ${error.message}`, "error");
      const overlay = document.createElement("div");
      overlay.className = "settings-overlay";
      overlay.innerHTML = `<div class="settings-panel"><div class="settings-head">LiveChat login unavailable</div><p class="settings-hint">${escapeHtml(error.message)}</p></div>`;
      document.body.appendChild(overlay);
      return;
    }
  }
  const originalAgentSetup = !DEPARTMENT_SEPARATION_ENABLED || (!previewMode && !DEPARTMENT_TABS_LIVE);
  if ((originalAgentSetup || !departmentKnown || currentDepartment === "rtn") && !selectedAgent && !qaView) {
    await Promise.race([
      optionsReady,
      new Promise((resolve) => setTimeout(resolve, 1200)),
    ]);
    openSettingsPanel();
  }

  optionsReady.finally(() => {
    if (BONUS_SHOWCASE_PREVIEW) renderChats(activeChats);
    if (activeMainTab === "tickets") renderChats(activeChats);
    const chatId = activeChats[0]?.chatId;
    const groupID = chatId ? groupIdFor.get(chatId) : null;
    if (chatId && groupID && !state[chatId]?.brand) resolveBrandFromGroupId(chatId, groupID);
  });

  setTimeout(startLookupResume, 1500);
  runWhenIdle(() => {
    renderNeedsAttentionPanel();
    fetchStaleRecords();
    if (!isLoggingPaused()) {
      for (const [chatId, saved] of Object.entries(state)) {
        if (shouldResumeInterruptedSave(saved)
          && (!currentLiveChatAccount || saved.liveChatAccount === currentLiveChatAccount)
          && (!saved.caOwner || saved.caOwner === selectedAgent)) {
          scheduleRecordRetry(chatId);
        }
      }
    }
  }, 2000);
})();

setInterval(() => {
  if (!document.hidden) saveState();
}, 10_000);
window.addEventListener("storage", (e) => {
  if (e.key !== STATE_STORAGE_KEY) return;
  storageDirty = true;
  saveState();
  renderNeedsAttentionPanel();
  scheduleNeedsAttentionRefresh(300);
});

chatListEl.addEventListener("paste", (event) => {
  const box = event.target.closest?.(".ticket-comment-input");
  if (!box) return;
  const files = Array.from(event.clipboardData?.items || []).filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  event.preventDefault();
  const chatId = box.dataset.chat;
  const row = box.closest(".ticket-comment-composer")?.querySelector(".ticket-comment-files-row");
  Promise.all(files.map(compressPicture)).then((prepared) => {
    addCommentFiles(chatId, prepared);
    if (row) row.innerHTML = renderCommentFiles(chatId);
  });
});
chatListEl.addEventListener("change", (event) => {
  const input = event.target.closest?.(".ticket-comment-file-input");
  if (!input) return;
  const chatId = input.dataset.chat;
  const picked = Array.from(input.files);
  input.value = "";
  const row = input.closest(".ticket-comment-composer")?.querySelector(".ticket-comment-files-row");
  Promise.all(picked.map(compressPicture)).then((prepared) => {
    addCommentFiles(chatId, prepared);
    if (row) row.innerHTML = renderCommentFiles(chatId);
  });
});
new MutationObserver(hydrateTicketImages).observe(chatListEl, { childList: true, subtree: true });

chatListEl.addEventListener("paste", (event) => {
  const picker = event.target.closest?.(".ticket-attachment-picker");
  if (!picker) return;
  const files = Array.from(event.clipboardData?.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  event.preventDefault();
  const chatId = picker.dataset.chat;
  const slot = picker.closest(".escalation-slot");
  Promise.all(files.map(compressPicture)).then((prepared) => {
    addTicketAttachments(chatId, prepared);
    slot.innerHTML = renderEscalationSection(chatId);
  });
});

document.addEventListener("click", (event) => {
  if (event.target.closest?.(".ticket-choice")) return;
  document.querySelectorAll(".ticket-choice-menu").forEach((menu) => menu.classList.add("hidden"));
  document.querySelectorAll(".ticket-choice-trigger").forEach((trigger) => trigger.setAttribute("aria-expanded", "false"));
});
window.addEventListener("pagehide", saveState);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveState(); });

const PENDING_SWEEP_MS = 8_000;
const SWEEP_BACKOFF_CAP_MS = 5 * 60_000;
const SWEEP_TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
function holdsSweepLease() {
  const key = `rc-sweeper:${currentLiveChatAccount || "-"}:${selectedAgent || "-"}`;
  try {
    const now = Date.now();
    let lease = null;
    try { lease = JSON.parse(localStorage.getItem(key) || "null"); } catch (_) { lease = null; }
    if (lease && lease.tabId !== SWEEP_TAB_ID && lease.expiresAt > now) return false;
    localStorage.setItem(key, JSON.stringify({ tabId: SWEEP_TAB_ID, expiresAt: now + PENDING_SWEEP_MS * 3 }));
    const check = JSON.parse(localStorage.getItem(key) || "null");
    return !!check && check.tabId === SWEEP_TAB_ID;
  } catch (_) { return true; }
}
function nextSweepDelay(failures) { return Math.min(PENDING_SWEEP_MS * 2 ** Math.max(0, failures - 1), SWEEP_BACKOFF_CAP_MS); }
function sweepSignature(s) {
  const { _savedAt, sweepRetry, ...rest } = s || {};
  return JSON.stringify(rest);
}

async function sweepPendingChats() {
  if (!holdsSweepLease()) { renderNeedsAttentionPanel(); return; }
  let persisted;
  try {
    persisted = loadPersistedState();
  } catch (_) {
    return;
  }
  const currentChatId = activeChats[0]?.chatId;
  for (const [chatId, saved] of Object.entries(persisted)) {
    if (chatId === currentChatId && !document.hidden) continue;
    if (!saved || saved.logged) continue;
    if (currentLiveChatAccount && saved.liveChatAccount !== currentLiveChatAccount) continue;
    if (saved.caOwner && saved.caOwner !== selectedAgent) continue;
    if (!state[chatId]) {
      state[chatId] = saved;
      markStateSynced(chatId);
      if (agentActed(saved)) logCaseOrigin(chatId, "a case saved earlier in this browser was picked up by the retry");
    }
    if (saved.chatOpen === false) {
      if (isLoggingPaused()) continue;
      const idle = state[chatId] || saved;
      if (!agentTouchedChat(idle) && !(AGENT_LOGIN_LIVE && agentWroteVerdict(idle) === undefined)) {
        if (idle.autoRecordError) idle.autoRecordError = "";
        continue;
      }
      const live = state[chatId] || saved;
      const backoff = live.sweepRetry;
      if (backoff && backoff.signature === sweepSignature(live) && Date.now() < backoff.nextAt) continue;
      await submitRecord(chatId, { auto: true, reason: "Retrying an earlier failed auto-record" });
      const after = state[chatId] || saved;
      if (after.logged) delete after.sweepRetry;
      else {
        const failures = (backoff && backoff.signature === sweepSignature(live) ? backoff.n : 0) + 1;
        after.sweepRetry = { n: failures, nextAt: Date.now() + nextSweepDelay(failures), signature: sweepSignature(after) };
      }
    } else {
      await checkChatStatus(chatId);
    }
  }
  renderNeedsAttentionPanel();
}
setInterval(sweepPendingChats, PENDING_SWEEP_MS);

function getIncompleteChats() {
  if (IS_EMBEDDED_APP && !currentLiveChatAccount) return [];
  let persisted;
  try {
    persisted = loadPersistedState();
  } catch (_) {
    return [];
  }
  return Object.entries(persisted)
    .filter(([, s]) => s && s.chatOpen === false && !s.logged && !s.isUnknown && !s.attentionIgnored && s.autoRecordError
      && agentTouchedChat(s)
      && s.agentName === selectedAgent
      && (!currentLiveChatAccount || s.liveChatAccount === currentLiveChatAccount))
    .map(([chatId, s]) => ({
      chatId,
      username: s.username || "(no username)",
      reason: s.autoRecordError,
      chatUrl: s.chatUrl ? archiveUrlFor(chatId) : "",
      recordId: s.caRecordId || null,
    }));
}

const linkSaveInFlight = new Set();
async function saveLinkToRecord(chatId) {
  const s = state[chatId];
  if (!s || !s.caRecordId || !s.chatUrl || s.caLinkSaved || s.logged || linkSaveInFlight.has(chatId)) return;
  if (!ownsCaseRecord(s)) return;
  const recordId = s.caRecordId;
  const retry = s.linkSaveRetry;
  const sameTarget = !!retry && retry.recordId === recordId && retry.url === s.chatUrl;
  if (sameTarget && Date.now() < retry.nextAt) return;
  linkSaveInFlight.add(chatId);
  try {
    const res = await fetch("/lark-record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordId, linkOnly: true, chatLink: s.chatUrl, agentName: selectedAgent, username: s.username }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "link save failed");
    if (s.caRecordId === recordId) s.caLinkSaved = true;
    delete s.linkSaveRetry;
  } catch (err) {
    const failures = (sameTarget ? retry.n : 0) + 1;
    s.linkSaveRetry = { n: failures, nextAt: Date.now() + nextSweepDelay(failures), recordId, url: s.chatUrl };
    logDiagnostic("Couldn't save chat link to Lark yet: " + err.message + ` (retrying in ${Math.round(nextSweepDelay(failures) / 1000)} s)`, "warn");
  } finally {
    linkSaveInFlight.delete(chatId);
  }
}

function archiveUrlFor(threadId) {
  return `https://my.livechatinc.com/archives/${encodeURIComponent(threadId)}`;
}

function markResolvedElsewhere(recordIds) {
  if (!recordIds || !recordIds.length) return;
  const ids = new Set(recordIds);
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_STORAGE_KEY) || "{}");
    let changed = false;
    for (const entry of Object.values(raw)) {
      if (entry && ids.has(entry.caRecordId) && !entry.logged) {
        entry.logged = true;
        entry.autoRecordError = "";
        entry._savedAt = Date.now();
        changed = true;
      }
    }
    if (changed) localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(raw));
  } catch (_) { }
  for (const [chatId, st] of Object.entries(state)) {
    if (st && ids.has(st.caRecordId) && !st.logged) {
      st.logged = true;
      st.autoRecordError = "";
      markStateSynced(chatId);
    }
  }
}

const larkRestoreTried = new Set();

const DELETED_RECORDS_KEY = "rc-deleted-records";
const DELETED_RECORDS_TTL_MS = 60 * 60_000;
function readDeletedRecords() {
  try {
    const raw = JSON.parse(localStorage.getItem(DELETED_RECORDS_KEY) || "{}") || {};
    const now = Date.now();
    const fresh = {};
    for (const [id, at] of Object.entries(raw)) if (now - Number(at) < DELETED_RECORDS_TTL_MS) fresh[id] = at;
    return fresh;
  } catch (_) { return {}; }
}
function rememberDeletedRecord(recordId) {
  if (!recordId) return;
  try {
    const all = readDeletedRecords();
    all[recordId] = Date.now();
    localStorage.setItem(DELETED_RECORDS_KEY, JSON.stringify(all));
  } catch (_) { }
}
function forgetDeletedRecord(recordId) {
  try {
    const all = readDeletedRecords();
    delete all[recordId];
    localStorage.setItem(DELETED_RECORDS_KEY, JSON.stringify(all));
  } catch (_) { }
}
function isDeletedRecord(recordId) {
  return !!recordId && Object.prototype.hasOwnProperty.call(readDeletedRecords(), recordId);
}
function deletedRecordAgeMs(recordId) {
  const at = recordId ? Number(readDeletedRecords()[recordId]) : 0;
  return at ? Date.now() - at : Infinity;
}
const DELETED_RECORD_HIDE_MS = 3 * 60_000;

function epochToDateInput(ms) {
  if (typeof ms !== "number") return "";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function caseFromLarkRow(r) {
  const amount = typeof r.amount === "number" ? String(r.amount) : "";
  const c = {
    caRecordId: r.recordId,
    inquiry: r.inquiry || [],
    status: r.status || "",
    releasedBonusAmount: amount,
    releasedAmountRaw: amount ? "RM" + amount : "",
    claimSecret: !!r.claimSecret,
    claimSecretManual: true,
    dob: epochToDateInput(r.dob),
    telegram: !!r.telegram,
    vs96FeedbackQuery1: r.vs96FeedbackQuery1 || "",
    vs96FeedbackQuery2: r.vs96FeedbackQuery2 || "",
    claimedPrograms: claimedProgramsFromSavedCase(r),
    gracePeriodActivated: false,
    logged: !!((r.inquiry || []).length && r.status),
    autoRecordError: "",
    loggedSnapshot: "",
    caLinkSaved: !!r.link,
    caOwner: selectedAgent,
    liveChatAccount: currentLiveChatAccount,
  };
  if (c.logged) c.loggedSnapshot = caseContentJson(c);
  return c;
}

async function restoreCardFromLark(threadId, { archived = false, customerName = "" } = {}) {
  if (!selectedAgent || !threadId || larkRestoreTried.has(threadId)) return false;
  larkRestoreTried.add(threadId);
  const agentAtRequest = selectedAgent;
  let records;
  try {
    const res = await fetch("/lark-chat-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentName: agentAtRequest, threadId }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "lookup failed");
    records = (data.records || []).filter((r) => !isDeletedRecord(r.recordId));
  } catch (err) {
    larkRestoreTried.delete(threadId);
    logDiagnostic("Couldn't check Lark for this chat's saved case: " + err.message, "warn");
    return false;
  }
  if (!records.length || agentAtRequest !== selectedAgent) return false;

  if (!state[threadId]) {
    ensureChatState({ chatId: threadId, customerName, link: "", isTelegram: false, groupName: "" });
  }
  const s = state[threadId];
  if (s.caRecordId || (s.logs && s.logs.length) || s.lookupInFlight) return false;

  const latest = records[records.length - 1];
  const earlier = records.slice(0, -1).filter((r) => (r.inquiry || []).length && r.status);
  s.logs = earlier.map((r, i) => ({ ...caseFromLarkRow(r), caseNo: i + 1, matchedRow: undefined, otherBrandMatches: [] }));
  Object.assign(s, caseFromLarkRow(latest));
  s.caseNo = earlier.length + 1;
  s.username = latest.username;
  s.usernameDraft = "";
  if (latest.brand) s.brand = latest.brand;
  if (!s.chatUrl && /\/chats\//.test(latest.link)) s.chatUrl = latest.link;
  s.agentName = selectedAgent;
  s.liveChatAccount = currentLiveChatAccount;
  s.restoredFromLark = true;
  if (archived) {
    s.chatOpen = false;
    if (!s.logged) s.autoRecordError = "Chat ended without Inquiry/Status — restored from Lark. Fill in and record.";
  }
  saveState();
  renderChats(activeChats);
  renderNeedsAttentionPanel();
  showChatToast(`Restored ${latest.username}'s case from Lark`, "info");
  logDiagnostic(`Restored ${records.length} Lark record(s) for thread ${threadId} (${latest.username}).`, "success");
  return true;
}

const STALE_POLL_MS = 240_000;
let staleRecords = [];
let needsAttentionRefreshTimer = null;

function scheduleNeedsAttentionRefresh(delay = 150) {
  clearTimeout(needsAttentionRefreshTimer);
  needsAttentionRefreshTimer = setTimeout(() => {
    needsAttentionRefreshTimer = null;
    if (!document.hidden) fetchStaleRecords();
  }, delay);
}

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function formatAge(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

let unrecordedChats = [];
let unrecordedLoaded = false;
const UNRECORDED_SHOWN_MAX = 25;
const unrecordedResolving = new Set();
async function postUnrecorded(body) {
  const token = liveChatAgentTokens()[currentLiveChatAccount];
  if (!token) return null;
  const response = await fetch("/livechat-unrecorded", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountKey: currentLiveChatAccount, agentToken: token, ...body }),
  });
  return response.json();
}
function reopenArchivedFromList() {
  if (!liveWidget) return;
  let profile = null;
  try { profile = liveWidget.getCustomerProfile(); } catch (_) { return; }
  if (!profile || profile.source !== "archives" || !profile.chat || !profile.chat.id) return;
  const threadId = String(profile.chat.id);
  if (activeChats[0] && activeChats[0].chatId === threadId) return;
  if (unrecordedChats.some((chat) => chat.threadId === threadId)) applyProfile(profile);
}
async function fetchUnrecordedChats() {
  if (!AGENT_LOGIN_LIVE || !currentLiveChatAccount) return;
  try {
    const data = await postUnrecorded({ action: "list" });
    if (data && data.ok && Array.isArray(data.chats)) {
      unrecordedChats = data.chats;
      unrecordedLoaded = true;
      reopenArchivedFromList();
      if (data.chats.length || data.notConfigured) logDiagnostic(data.notConfigured ? "Unrecorded-chats list: not set up on the server." : `Unrecorded-chats list: ${data.chats.length} from the crosscheck.`, "info");
      renderNeedsAttentionPanel();
    } else if (data && data.error) logDiagnostic(`Couldn't read your unrecorded-chats list: ${data.error}`, "warn");
  } catch (_) { }
}
async function resolveUnrecorded(threadId, status) {
  unrecordedChats = unrecordedChats.filter((chat) => chat.threadId !== threadId);
  renderNeedsAttentionPanel();
  if (unrecordedResolving.has(threadId)) return;
  unrecordedResolving.add(threadId);
  try { await postUnrecorded({ action: "resolve", threadId, status }); } catch (_) { }
}
async function ignoreAllUnrecorded() {
  const count = unrecordedChats.length;
  if (!count) return;
  if (!confirm(`Ignore all ${count} of these chats?\n\nThey will not be shown again. Do this only after you have looked at the newest ones and the rest were not cases to record.`)) return;
  unrecordedChats = [];
  renderNeedsAttentionPanel();
  try {
    for (let round = 0; round < 40; round += 1) {
      const data = await postUnrecorded({ action: "resolveAll" });
      if (!data || !data.ok) { logDiagnostic(`Couldn't write off the whole list: ${data?.error || "no answer"} — the rest shows again next start.`, "warn"); return; }
      if (!data.remaining) { logDiagnostic(`Ignored ${count} unrecorded chats.`, "success"); return; }
    }
  } catch (_) { }
}
function getUnrecordedChats() {
  if (!unrecordedChats.length) return [];
  let persisted = {};
  try { persisted = loadPersistedState(); } catch (_) { }
  const local = (threadId) => state[threadId] || persisted[threadId];
  return unrecordedChats.filter((chat) => {
    const s = local(chat.threadId);
    if (s && s.logged && (s.inquiry || []).length && s.status) { resolveUnrecorded(chat.threadId, "Done"); return false; }
    if (s && s.isUnknown) { resolveUnrecorded(chat.threadId, "Ignored"); return false; }
    if (s && s.chatOpen === false && !s.logged && s.autoRecordError && s.agentName === selectedAgent) return false;
    return !(s && s.attentionIgnored);
  });
}

async function fetchStaleRecords() {
  if (!selectedAgent) { staleRecords = []; renderNeedsAttentionPanel(); return; }
  if (IS_EMBEDDED_APP && !currentLiveChatAccount) {
    staleRecords = [];
    renderNeedsAttentionPanel();
    return;
  }
  const agentAtRequest = selectedAgent;
  try {
    const res = await fetch("/lark-stale-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentName: agentAtRequest,
        accountKey: currentLiveChatAccount,
        localRecordIds: getIncompleteChats().map((c) => c.recordId).filter(Boolean),
      }),
    });
    const data = await res.json();
    if (agentAtRequest !== selectedAgent) return;
    if (!data.ok) {
      logDiagnostic("Unfinished-records check failed: " + (data.error || "unknown error"), "error");
      return;
    }
    staleRecords = data.records || [];
    markResolvedElsewhere(data.resolvedIds || []);
  } catch (err) {
    logDiagnostic("Unfinished-records check failed: " + err.message, "error");
    return;
  }
  renderNeedsAttentionPanel();
}

function getStaleLarkRecords() {
  if (IS_EMBEDDED_APP && !currentLiveChatAccount) return [];
  let persisted = {};
  try { persisted = loadPersistedState(); } catch (_) { }
  const localByRecord = new Map();
  for (const s of [...Object.values(persisted), ...Object.values(state)]) {
    if (s && s.caRecordId) localByRecord.set(s.caRecordId, s);
  }
  const shownLocally = new Set(getIncompleteChats().map((c) => c.recordId).filter(Boolean));
  return staleRecords
    .filter((r) => {
      if (currentLiveChatAccount && r.accountKey && r.accountKey !== currentLiveChatAccount) return false;
      if (shownLocally.has(r.recordId)) return false;
      if (deletedRecordAgeMs(r.recordId) < DELETED_RECORD_HIDE_MS) return false;
      const local = localByRecord.get(r.recordId);
      if (!local) return true;
      if (local.attentionIgnored) return false;
      if (local.logged && (local.inquiry || []).length && local.status) return false;
      return local.chatOpen === false;
    })
    .map((r) => {
      const local = localByRecord.get(r.recordId);
      return { ...r, chatUrl: r.openUrl || (local && local.chatUrl) || "" };
    });
}

async function removeStaleRecord(recordId, btn) {
  const rec = staleRecords.find((r) => r.recordId === recordId);
  const label = rec ? `${rec.username} (${rec.brand})` : "this record";
  if (!confirm(`Remove the empty Lark record for ${label}?

Only do this if the case doesn't need logging. It's only removed if Inquiry and Status are still empty.`)) return;
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/lark-stale-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentName: selectedAgent, deleteRecordId: recordId }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Remove failed");
    rememberDeletedRecord(recordId);
    staleRecords = staleRecords.filter((r) => r.recordId !== recordId);
    setStatus(`Removed empty record for ${label}.`, "success");
  } catch (err) {
    setStatus(`Couldn't remove record: ${err.message}`, "error");
    fetchStaleRecords();
  }
  if (btn) btn.disabled = false;
  renderNeedsAttentionPanel();
}

function ignoreAttention(chatId) {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_STORAGE_KEY) || "{}");
    if (raw[chatId]) {
      raw[chatId].attentionIgnored = true;
      raw[chatId].logged = true;
      raw[chatId]._savedAt = Date.now();
      localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(raw));
    }
  } catch (_) { }
  if (state[chatId]) {
    state[chatId].attentionIgnored = true;
    state[chatId].logged = true;
  }
  renderNeedsAttentionPanel();
}

function renderNeedsAttentionPanel() {
  const panel = document.getElementById("needsAttentionPanel");
  const countEl = document.getElementById("needsAttentionCount");
  const listEl = document.getElementById("needsAttentionList");
  if (!panel || !countEl || !listEl) return;

  const incomplete = getIncompleteChats();
  const stale = getStaleLarkRecords();
  const unrecorded = getUnrecordedChats();
  const unrecordedShown = [...unrecorded].sort((a, b) => b.date - a.date).slice(0, UNRECORDED_SHOWN_MAX);
  const previewCount = previewMode && showPreviewClosedChat ? 1 : 0;
  const total = incomplete.length + stale.length + unrecorded.length + previewCount;
  if (!total) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  countEl.textContent = total === 1
    ? "⚠ 1 chat needs attention"
    : `⚠ ${total} chats need attention`;
  const now = Date.now();
  listEl.innerHTML = (previewCount ? `
    <div class="na-item">
      <div class="na-item-username">Preview player · alex3344</div>
      <div class="na-item-reason">Chat ended without Inquiry or Status — not recorded. Preview only.</div>
      <div class="na-item-actions"><span class="preview-mode-badge">LOCAL EXAMPLE</span></div>
    </div>
  ` : "") + incomplete.map((c) => `
    <div class="na-item">
      <div class="na-item-username">${c.username}</div>
      <div class="na-item-reason">${c.reason}</div>
      <div class="na-item-actions">
        ${c.chatUrl ? `<a class="na-item-link" href="${c.chatUrl}" target="_blank">Open ↗</a>` : ""}
        <button type="button" class="na-item-ignore" data-action="ignoreAttention" data-chat="${c.chatId}" title="Stop showing this chat here">Ignore</button>
      </div>
    </div>
  `).join("") + stale.map((r) => `
    <div class="na-item">
      <div class="na-item-username">${escapeHtml(r.username)} · ${escapeHtml(r.brand)}</div>
      <div class="na-item-reason">${r.chatEnded ? "Chat ended" : "Not finished"}${r.accountKey ? "" : " · account unknown"} — no Inquiry/Status in Lark (looked up ${formatAge(now - r.createdAt)})</div>
      <div class="na-item-actions">
        ${r.chatUrl ? `<a class="na-item-link" href="${escapeHtml(r.chatUrl)}" target="_blank">Open ↗</a>` : ""}
        <button type="button" class="na-item-ignore" data-action="removeStale" data-record="${escapeHtml(r.recordId)}" title="Delete this empty row from Lark">Remove</button>
      </div>
    </div>
  `).join("") + unrecordedShown.map((c) => `
    <div class="na-item">
      <div class="na-item-username">${escapeHtml(c.customer || "Customer")}${c.date ? ` · ${escapeHtml(new Date(c.date).toLocaleDateString())}` : ""}</div>
      <div class="na-item-reason">You wrote in this chat but it was never recorded.</div>
      <div class="na-item-actions">
        <a class="na-item-link" href="${escapeHtml(archiveUrlFor(c.threadId))}" target="_blank">Open ↗</a>
        <button type="button" class="na-item-ignore" data-action="ignoreUnrecorded" data-thread="${escapeHtml(c.threadId)}" title="Stop showing this chat here (for example it was not a player case)">Ignore</button>
      </div>
    </div>
  `).join("") + (unrecorded.length > unrecordedShown.length ? `
    <div class="na-item">
      <div class="na-item-reason">…and ${unrecorded.length - unrecordedShown.length} older chats you wrote in that were never recorded. They appear here as you clear these.</div>
    </div>
  ` : "") + (unrecorded.length > 1 ? `
    <div class="na-item">
      <div class="na-item-actions">
        <button type="button" class="na-item-ignore" data-action="ignoreAllUnrecorded" title="Clear all ${unrecorded.length} of these chats at once">Ignore all ${unrecorded.length}</button>
      </div>
    </div>
  ` : "");
}

document.getElementById("needsAttentionList").addEventListener("click", (e) => {
  const staleBtn = e.target.closest("button[data-action='removeStale']");
  if (staleBtn) { removeStaleRecord(staleBtn.dataset.record, staleBtn); return; }
  if (e.target.closest("button[data-action='ignoreAllUnrecorded']")) { ignoreAllUnrecorded(); return; }
  const unrecordedBtn = e.target.closest("button[data-action='ignoreUnrecorded']");
  if (unrecordedBtn) { resolveUnrecorded(unrecordedBtn.dataset.thread, "Ignored"); return; }
  const btn = e.target.closest("button[data-action='ignoreAttention']");
  if (!btn) return;
  ignoreAttention(btn.dataset.chat);
});
setInterval(() => {
  if (!document.hidden) fetchStaleRecords();
}, STALE_POLL_MS);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    scheduleNeedsAttentionRefresh(150);
    if (chatStatusPollTick) chatStatusPollTick();
  }
});

document.getElementById("needsAttentionToggle").addEventListener("click", () => {
  const listEl = document.getElementById("needsAttentionList");
  const toggleBtn = document.getElementById("needsAttentionToggle");
  const willOpen = listEl.classList.contains("hidden");
  if (willOpen) {
    renderNeedsAttentionPanel();
    scheduleNeedsAttentionRefresh(0);
  }
  listEl.classList.toggle("hidden", !willOpen);
  toggleBtn.classList.toggle("open", willOpen);
});

window.prepareForDeploymentRefresh = () => { try { saveState(); } catch (_) { } };

window.canRefreshForDeployment = () => {
  if (blastRunInProgress || Object.values(state).some(s => s?.lookupInFlight || s?.unclaimInFlight)) return false;
  if (recordSubmitInFlight.size || linkSaveInFlight.size) return false;
  if (Object.values(state).some((s) => s && !s.logged && String(s.usernameDraft || "").trim())) return false;
  if (ticketCreateInFlight.size || claimWriteInFlight.size) return false;
  for (const files of ticketAttachmentsByChat.values()) if (files && files.length) return false;
  if (Object.values(state).some((s) => s && s.escalation && !s.escalationSubmitted
    && ["queries", "transactionId", "paymentGateway", "remarks"].some((key) => String(s.escalation[key] || "").trim()))) return false;
  for (let i = 0; i < sessionStorage.length; i++) {
    if (sessionStorage.key(i)?.startsWith('ca-livechat-engagement:queue:')) return false;
  }
  const element = document.activeElement;
  return !element || !['INPUT', 'TEXTAREA', 'SELECT', 'IFRAME'].includes(element.tagName);
};
