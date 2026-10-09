// The C9 ticket-system integration keeps its credentials in the server-side
// Pages environment; the browser only receives the fields it needs.
const ESCALATION_TICKET_ENABLED = true;
const IS_EMBEDDED_APP = window.self !== window.top;
// Department-based sections are being tested in the standalone preview.
// Keep them out of the installed LiveChat widget until rollout is approved.
const DEPARTMENT_TABS_LIVE = false;
const BLAST_LIVE = true;
const DEPARTMENT_SEPARATION_ENABLED = false;
const PREVIEW_LOGIN_GATE = false;
// Temporary preview fallback. Turn this back on after agents--my:ro has
// been added to both LiveChat OAuth clients.
const AUTOMATIC_DEPARTMENT_DETECTION = false;
const MANUAL_DEPARTMENT_SESSION_KEY = "rc-manual-department";
// LiveChat login decides the agent name (see requireAgentLogin and functions/agent-login.js): the first sign-in picks a
// name once, Lark remembers it for that LiveChat login, and Settings can no longer change it. ON for everyone. Adding
// agentLogin=0 to the page address (for the LiveChat widget: to its App URL) turns it off again without a deploy, e.g. if
// the login window cannot open somewhere. Independent of the department switches above.
const AGENT_LOGIN_LIVE = new URLSearchParams(location.search).get("agentLogin") !== "0";

/* ============================================================
   THEME
   ============================================================ */
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

/* ============================================================
   AGENT SETTINGS
   Agent name is stored in localStorage and required before
   any lookup or submit. On first load, settings panel opens
   automatically if no agent is saved.
   ============================================================ */
const AGENT_KEY = "rc-agent-name";
const BLAST_SYNC_STORAGE_KEY = "ca-livechat-engagement:sync";
const BLAST_LOCAL_STORAGE_KEY = "ca-livechat-engagement:local";
const CONFIGURED_LIVECHAT_ACCOUNT = /^lc[12]$/.test(new URLSearchParams(location.search).get("account") || "")
  ? new URLSearchParams(location.search).get("account")
  : "";
// With the LiveChat login on, a name the agent chose in an older version is not trusted: the name comes from the login,
// and until it arrives nothing can be recorded (every record path stops on "no agent name").
let selectedAgent = AGENT_LOGIN_LIVE ? "" : (localStorage.getItem(AGENT_KEY) || "");
let agentLocked = false; // true once the name came from the LiveChat login: Settings cannot change it
// Dropdown option lists are cached in localStorage, and a fetch can only ever
// REPLACE a list with a non-empty one. Before this, a slow/throttled Lark read
// came back as an empty list that overwrote the working one -- Brand
// auto-detection then found no matching option and Brand "disappeared".
const OPTIONS_CACHE_KEY = "rc-options-cache";
function readCachedOptions() { try { return JSON.parse(localStorage.getItem(OPTIONS_CACHE_KEY) || "{}") || {}; } catch (_) { return {}; } }
function writeCachedOptions(patch) { try { localStorage.setItem(OPTIONS_CACHE_KEY, JSON.stringify({ ...readCachedOptions(), ...patch })); } catch (_) { /* non-fatal */ } }
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

// Chats are recorded to Lark ONLY while the agent is on the Retention tab. Any other tab (Blast, Tickets, Knowledge, and any
// tab added later) pauses recording automatically, and so does a running Blast. This replaces the old manual "Don't log chats"
// checkbox. Nothing is lost while paused: submitRecord returns without marking the chat logged, so the background sweep
// records it a few seconds after the agent is back on Retention. To pause on a new tab, just don't add it to LOGGING_TABS.
const LOGGING_TABS = new Set(["customer"]);
let blastLoggingLock = false;
let blastRunInProgress = false;
function isLoggingPaused() { return blastRunInProgress || blastLoggingLock || !LOGGING_TABS.has(activeMainTab); }
// The old checkbox kept its state in localStorage; stale values must not linger.
try { localStorage.removeItem("rc-logging-paused"); localStorage.removeItem("rc-blast-logging-previous"); } catch (_) {}

async function fetchAgentOptions({ fresh = false } = {}) {
  try {
    const res = await fetch("/lark-pic-list", fresh ? { cache: "no-store" } : undefined);
    const data = await res.json();
    if (data.ok) setAgentOptions(data.pics);
  } catch (_) { /* non-fatal — settings panel still shows text input fallback */ }
}

// Brand's dropdown options — real Brand values from Customer Approaching's
// own field, not free text (see renderAutoFields). Fetched once at boot,
// same as agentOptions.
let brandOptions = Array.isArray(readCachedOptions().brands) ? readCachedOptions().brands : [];
function setBrandOptions(list) {
  if (!Array.isArray(list) || !list.length) return;
  brandOptions = list;
  writeCachedOptions({ brands: list });
  retryMissingBrandDetection(); // chats opened while the list was missing can now be matched
}
// Brand auto-detect depends on the option list AND on a LiveChat lookup; either
// can fail transiently. Retry a few times instead of leaving Brand blank.
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
  } catch (_) { /* non-fatal — falls back to just showing whatever's auto-detected */ }
}

// The ticket API returns its live field catalog, including SELECT options.
// Keeping that catalog here means changes in the ticket system do not need a
// corresponding hard-coded option update in this widget.
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
async function fetchTicketConfig({ fresh = false } = {}) {
  if (!ESCALATION_TICKET_ENABLED) return;
  try {
    const res = await fetch(fresh ? "/ticket-config?fresh=1" : "/ticket-config", fresh ? { cache: "no-store" } : undefined);
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
  if (typeof resumePendingLookups === "function") resumePendingLookups();   // an interrupted lookup was waiting for the agent name
}

// Settings panel — overlaid on top of the widget, blocking interaction
// until an agent is chosen.
function openSettingsPanel() {
  document.getElementById("settingsOverlay")?.remove();
  const blastFailures = readBlastStorage(BLAST_LOCAL_STORAGE_KEY).failureLog;
  const failureLog = Array.isArray(blastFailures) ? blastFailures : [];
  const overlay = document.createElement("div");
  overlay.id = "settingsOverlay";
  overlay.className = "settings-overlay";
  overlay.innerHTML = `
    <div class="settings-panel">
      <div class="settings-head">
        <div class="settings-title-block">
          <span>Settings</span>
          <small>Agent preferences and diagnostics</small>
        </div>
        ${selectedAgent ? `<button class="settings-close" id="settingsClose">✕</button>` : ""}
      </div>
      <div class="settings-card">
        <div class="settings-section-title"><span>Agent</span></div>
        <p class="settings-hint">${agentLocked ? "Your name comes from your LiveChat login and can't be changed here." : "Choose the name recorded on every submitted case."}</p>
        ${agentLocked
          ? `<div class="input settings-text" id="agentLockedName">${escapeHtml(selectedAgent)}</div>`
          : agentOptions.length
          ? `<select class="input settings-select" id="agentSelect">
               <option value="">Choose your name</option>
               ${agentOptions.map((a) => `<option value="${a}" ${a === selectedAgent ? "selected" : ""}>${a}</option>`).join("")}
             </select>`
          : `<input type="text" class="input settings-text" id="agentSelect" placeholder="Type your name (e.g. 96 Edwin)" value="${selectedAgent}" />`
        }
      </div>

      <div class="settings-card">
        <div class="settings-section-title"><span class="settings-section-icon">↗</span><span>Blast history</span></div>
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

  document.getElementById("settingsClearFailures")?.addEventListener("click", () => {
    const current = readBlastStorage(BLAST_LOCAL_STORAGE_KEY);
    delete current.failureLog;
    localStorage.setItem(BLAST_LOCAL_STORAGE_KEY, JSON.stringify(current));
    document.getElementById("settingsClearFailures")?.closest(".settings-failures")?.remove();
  });

  document.getElementById("settingsSave").addEventListener("click", () => {
    if (agentLocked) { overlay.remove(); return; }
    const val = document.getElementById("agentSelect").value.trim();
    if (!val) { setStatus("Choose your name before continuing.", "error"); return; }
    saveAgent(val);
    overlay.remove();
    updateAgentBadge();
    staleRecords = [];
    fetchStaleRecords();
    // A chat that loaded before any agent was picked (fresh incognito
    // window) skipped the Lark card restore -- re-run it now.
    if (liveWidget) applyProfile(liveWidget.getCustomerProfile());
    setStatus(`Agent set to ${selectedAgent}.`, "success");
  });

  document.getElementById("settingsClose")?.addEventListener("click", () => overlay.remove());
}

// Replaces the old "dump state to browser console" link — a plain-language
// activity log visible right in Settings, no devtools required. Every
// setStatus() call (errors and routine confirmations alike) lands here.
function renderDiagnosticsLog() {
  if (!diagnosticsLog.length) return `<div class="diag-empty">No activity logged yet.</div>`;
  return diagnosticsLog.map((e) => `
    <div class="diag-entry diag-${e.kind}">
      <span class="diag-time">${e.time.toLocaleTimeString()}</span> ${e.text}
    </div>`).join("");
}

function updateAgentBadge() {
  const badge = document.getElementById("agentBadge");
  if (badge) badge.textContent = selectedAgent ? `◉ ${selectedAgent}` : "⚠︎ No agent set";
  if (badge) badge.className = `agent-badge ${selectedAgent ? "set" : "unset"}`;
}

/* ============================================================
   SAMPLE DATA (stand-in until this is wired to LiveChat + Lark)
   ============================================================ */

// Each of these is its own bonus-program table in Lark (not columns on
// Customer Approaching) — lark-search.js already applies each table's own
// claim/hide rule and picks the single oldest still-claimable row, so by the
// time it gets here r[key] is either "" (nothing to show) or the one display
// value to render. Special Reload Event, Telegram RM28, and Redeem Code
// aren't listed here — they're "special" (instant claim-writes-to-Lark)
// tickets, handled separately below.
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
  const rtn = currentDepartment === "rtn";
  const settingsButton = document.getElementById("settingsBtn");
  const agentBadge = document.getElementById("agentBadge");
  if (settingsButton) settingsButton.hidden = !rtn;
  if (agentBadge) agentBadge.hidden = !rtn;
}

async function resolveLoggedInDepartment(accountKey, token) {
  const response = await fetch("/livechat-agent-department", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountKey, agentToken: token }),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || "Could not identify this LiveChat agent.");
  setCurrentLiveChatAccount(accountKey);
  setDepartmentFromGroups(data.groups || []);
  activeMainTab = data.department === "rtn" ? "customer" : "tickets";
  applyDepartmentChrome();
  syncMainTabs();
  renderChats(activeChats);
  return data;
}

function applyManualDepartment(accountKey, department) {
  setCurrentLiveChatAccount(accountKey);
  currentDepartment = department === "rtn" ? "rtn" : "cs";
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
    } catch (_) { /* show the login screen so the agent can reconnect */ }
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

/* ============================================================
   LIVECHAT LOGIN -> AGENT NAME (behind AGENT_LOGIN_LIVE)
   Sign in with LiveChat. The server checks the token with LiveChat and looks the login up in the "Livechat App Agent
   Logins" table: a known login gets its agent name back; a new one picks a name once (only names free on that
   LiveChat account are offered) and it is locked. Nothing can be recorded until this finishes.
   ============================================================ */
function dropLiveChatToken(accountKey) {
  forgetLiveChatLogin(accountKey);
}

async function postAgentLogin(accountKey, token, name) {
  const response = await fetch("/agent-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountKey, agentToken: token, ...(name ? { name } : {}) }),
  });
  return response.json();
}

// One blocking panel, replaced in place as the steps change.
function agentLoginPanel(innerHtml) {
  let overlay = document.getElementById("agentLoginOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "agentLoginOverlay";
    overlay.className = "settings-overlay agent-login-overlay";
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `<div class="agent-login-card"><div class="login-mark">◆</div><div class="agent-login-app">Console</div>${innerHtml}</div>`;
  return overlay;
}

// Opens LiveChat's login window for each account in turn and resolves with the first that signs in.
function connectLiveChatLogin(clients, redirectUri, onProgress) {
  return new Promise((resolve, reject) => {
    let callbackOrigin = location.origin;
    try { callbackOrigin = new URL(redirectUri).origin; } catch (_) { /* keep this origin */ }
    let index = -1;
    let pendingClient = null;
    let pendingState = "";
    const finish = (settle, value) => { window.removeEventListener("message", onMessage); settle(value); };
    const next = () => {
      index += 1;
      pendingClient = clients[index] || null;
      if (!pendingClient) return false;
      pendingState = crypto.randomUUID();
      onProgress(index ? "Checking your other LiveChat workspace…" : "Complete the login in the new window…");
      const url = new URL("https://accounts.livechat.com/");
      url.search = new URLSearchParams({ response_type: "token", client_id: pendingClient.clientId, redirect_uri: redirectUri, state: pendingState, prompt: "consent" }).toString();
      return Boolean(window.open(url, "livechat-agent-oauth", "popup=yes,width=560,height=720"));
    };
    const onMessage = (event) => {
      if (event.origin !== callbackOrigin || event.data?.source !== "ca-livechat-oauth" || event.data.state !== pendingState) return;
      if (event.data.type === "SUCCESS" && pendingClient) {
        finish(resolve, { accountKey: pendingClient.key, token: event.data.token, expiresAt: event.data.expiresAt });
        return;
      }
      if (!next()) finish(reject, new Error(event.data.error || "LiveChat login was not completed."));
    };
    window.addEventListener("message", onMessage);
    if (!next()) finish(reject, new Error("Your browser blocked the LiveChat login window. Allow popups and try again."));
  });
}

function applyBoundAgent(name, accountKey) {
  const changed = selectedAgent !== name;
  agentLocked = true;
  saveAgent(name);
  setCurrentLiveChatAccount(accountKey);
  updateAgentBadge();
  document.getElementById("agentLoginOverlay")?.remove();
  if (changed) {
    staleRecords = [];
    fetchStaleRecords();
    // A chat that loaded before the name was known skipped the Lark card restore -- run it again now.
    if (liveWidget) applyProfile(liveWidget.getCustomerProfile());
  }
  logDiagnostic(`Signed in with LiveChat as ${name}.`, "success");
  fetchUnrecordedChats();
}

// First sign-in: pick the agent name once. Resolves when it is saved.
function pickAgentName(accountKey, token, available) {
  return new Promise((resolve) => {
    const render = (names, error = "") => {
      const overlay = agentLoginPanel(`
        <div class="settings-head">Choose your agent name</div>
        <p class="settings-hint">This is saved to your LiveChat login and <strong>can't be changed later</strong>. If you pick the wrong one, ask your admin.</p>
        ${names.length
          ? `<select class="input settings-select" id="agentLoginSelect"><option value="">Choose your name</option>${names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("")}</select>
             <div class="login-actions"><button type="button" class="submit-btn" id="agentLoginConfirm">Save my name</button></div>`
          : `<p class="settings-hint">No free agent names are left on this LiveChat account — ask your admin.</p>`}
        <div class="login-status error" id="agentLoginStatus">${escapeHtml(error)}</div>`);
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

async function requireAgentLogin() {
  let config = null;
  try { config = await (await fetch("/livechat-oauth-config", { cache: "no-store" })).json(); } catch (_) { /* handled below */ }
  let clients = Array.isArray(config?.clients) ? config.clients : [];
  // A widget installed in one LiveChat account only ever signs in against that account.
  if (CONFIGURED_LIVECHAT_ACCOUNT) clients = clients.filter((client) => client.key === CONFIGURED_LIVECHAT_ACCOUNT);
  if (!clients.length) {
    agentLoginPanel(`<div class="settings-head">LiveChat login unavailable</div><p class="settings-hint">LiveChat login has not been configured for this widget.</p>`);
    return new Promise(() => {}); // nothing can be recorded without a login, so this never continues
  }
  const redirectUri = config.redirectUri || `${location.origin}/blast/oauth.html`;
  let failure = "";
  for (;;) {
    const tokens = liveChatAgentTokens();
    const usable = clients.map((client) => client.key).filter((key) => tokens[key]);
    for (const key of usable) {
      let data;
      try { data = await postAgentLogin(key, tokens[key]); } catch (_) { failure = "Couldn't reach the server — check your connection."; continue; }
      if (data.loginExpired) { dropLiveChatToken(key); failure = data.error || ""; continue; }
      if (data.ok && data.bound) { applyBoundAgent(data.name, key); return; }
      if (data.ok) { await pickAgentName(key, tokens[key], Array.isArray(data.available) ? data.available : []); return; }
      failure = data.error || "Agent login failed.";
    }
    // Needs a (re)connect, or a retry if the server could not be reached.
    await new Promise((resolve) => {
      // Retry only when a login is still stored (the server could not be reached); an expired one needs a new login.
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

// A chat closed with no action of this agent on its card (no Look up, inquiry, status ...): did they at least write to
// the customer? Asked of LiveChat once per chat, using the agent's own LiveChat login, and remembered in the chat's
// state. true = theirs, false = not theirs (e.g. only watched while supervising), and when LiveChat cannot be asked the
// chat is kept as theirs ("unsure") so a real case is reminded about, not lost; it is asked again on the next attempt.
// Only with the LiveChat login on: otherwise nothing identifies the agent to LiveChat and the answer is "not theirs".
//
// An answer saved by an older version of this check is not trusted and the chat is asked about again: version 2 fixed
// "did not write" answers that compared the login id with an email, version 3 made "the customer never wrote" (the agent
// reached out) count as not theirs, so a "wrote" from before is re-checked too. "unsure" is always asked again anyway.
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
  if (s.agentWrote === false || s.agentWrote === true) delete s.agentWrote; // an old, untrusted answer
  const token = liveChatAgentTokens()[currentLiveChatAccount];
  const link = String(s.chatUrl || "").match(/\/chats\/([^/]+)\/([^/]+)/);
  // No link yet means the chat closed before LiveChat's first status check resolved it (a chat opened and shut within
  // seconds): nothing happened that could need recording, and it is asked again once there is a link, not put on the list.
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
  // Theirs only if they wrote AND the customer wrote too: a thread where the customer never said anything is the agent
  // reaching out, with nothing to record. (An older server that does not say is taken as "the customer wrote".)
  const theirs = !!data.wrote && data.customerWrote !== false;
  s.agentWrote = theirs;
  s.agentWroteV = AGENT_WROTE_VERSION;
  if (!theirs) {
    // Shows both sides, so a mismatch in how LiveChat names agents is visible instead of silent.
    logDiagnostic(data.wrote
      ? "Not on your list: the customer never wrote in this chat (you reached out), so there is nothing to record."
      : `Not on your list: no message from you (${(data.me || []).join(" / ")}) in this chat. Agent messages by: ${(data.authors || []).join(", ") || "nobody"}.`, "info");
  }
  return s.agentWrote;
}

// Agent, Brand, Inquiry and Status all come from the same Lark table. The
// combined endpoint reads that table once, instead of making four duplicate
// field requests plus a separate bonus-config request during startup.
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

// Released Amount normally comes directly from these programs. Risk Player
// is calculated separately from the agent-entered customer reload amount.
// 12h VIP Booster, Redeem Code, and Special Reload don't carry an amount.
// Grace Period is included here for documentation, but never reaches the
// generic claim flow that reads this set — it has its own separate handling
// (see the claim handler) since one field packs two very different states.
// Telegram RM28 does carry a real per-row amount (its display string is
// "Eligible — RM18" etc.), so it's included here too.
const AMOUNT_ELIGIBLE_PROGRAMS = new Set(["topPnl", "ltvTest", "gracePeriod", "telegram28"]);

// Mirrors lark-record.js's own extractAmount() -- a number directly after
// "RM" takes priority over the first plain number found, since a bonus's
// raw display text often has other digits earlier (e.g. Top 10 P&L(Night)'s
// real format "Batch 09-09-2026 Pass RM58" -- a naive first-number-found
// match would grab "09" instead of the real "58").
function extractAmountNumber(str) {
  const s = String(str || "");
  const rmMatch = s.match(/RM\s*(-?\d+(?:\.\d+)?)/i);
  if (rmMatch) return rmMatch[1];
  const match = s.match(/-?\d+(?:\.\d+)?/);
  return match ? match[0] : "";
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

// One-line summary shown on a collapsed card — lets an agent glance across
// several queued chats without expanding each one. Priority order matches
// what's most actionable: a card needing attention should never be masked
// by a "Logged" badge from a stale render, etc.
function hasAnyBonus(chatId) {
  const r = state[chatId].matchedRow;
  if (!r) return false;
  if (allBonusPrograms().some((p) => isClaimableValue(r[p.key]))) return true;
  if (r.telegram28 && !isHiddenStatus(r.telegram28.status)) return true;
  if (r.redeemCode && !isHiddenStatus(r.redeemCode.status)) return true;
  if (r.specialReload) return true; // lark-search.js already filtered to only "Eligible Angpao"
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

// Word-boundary substring, not === -- mirrors hidden() in lark-search.js
// (see its own header note). Real Status/SW Check text embeds "claimed"/
// "expired"/"failed" in different positions per bonus table -- e.g. Top 10
// P&L(Night) is "Batch 09-09-2026 Claimed RM58", not the bare word alone --
// so an exact match let an already-claimed row still render its Claim
// button client-side even after the server itself stopped selecting it.
function isHiddenStatus(v) {
  const t = String(v || "").trim().toLowerCase();
  // "Not Eligible" / "Ineligible" = nothing to claim, same as Expired/Failed.
  return /\b(claimed|expired|failed|not\s+eligible|ineligible)\b/.test(t);
}

// Excludes: empty, "XD No Bonus" pattern, and Expired/Claimed
function isClaimableValue(v) {
  const s = String(v || "").trim();
  return !!(s && !NO_BONUS_PATTERN.test(s) && !isHiddenStatus(s));
}

// Simulates the real Lark base: same username can exist under multiple
// brands with completely different bonus states — matching must require
// BOTH Username AND Brand, never username alone. This now also LOGS the
// case (creates the Customer Approaching row) if one doesn't exist yet —
// that's what makes Lark's bonus lookup columns actually populate.
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
  // Pages occasionally returns an HTML edge-error page instead of the JSON
  // from the Function. Retry one transient response automatically; when a
  // chat link is available the endpoint can reuse its blank case row. Preview
  // mode is read-only.
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

// 2026-08-29: lark-search.js now queries every bonus's own source table
// directly (Username/UID + Brand) instead of waiting on Customer
// Approaching's Lookup columns to resolve — that Lookup delay (15-30s on a
// big base) was the entire reason the poll-and-wait dance below used to
// exist. lark-search.js's response is now already final, so there's nothing
// left to poll for.

// Fallback only — used until (or unless) the real LiveChat Agent App SDK
// connects. See initLiveChatSdk() below.
const SAMPLE_CHATS = [
  { chatId: "preview-test", customerName: "Bonus Test Preview", link: "", isTelegram: false, groupName: "VS96 Priority Support" },
];

// The list renderChats() actually draws from. Starts as the demo data;
// initLiveChatSdk() replaces it with the one real active chat once (if) the
// SDK connects. Kept as a list (not a single object) so renderChats/state
// keying by chatId didn't need to change shape for this swap.
// Inside LiveChat, start with an empty lightweight shell. Rendering the full
// preview card before the SDK resolves wastes a large DOM build on every chat
// switch, only for the SDK to replace it a moment later. The standalone admin
// preview keeps the sample card exactly as before.
let activeChats = IS_EMBEDDED_APP ? [] : SAMPLE_CHATS;
// Standalone Pages preview is a read-only test bench. It reads the same live
// bonus tables, but every write path is disabled until the LiveChat SDK
// successfully connects and replaces the sample cards with a real chat.
let previewMode = !IS_EMBEDDED_APP;
// The standalone admin/test preview is also the bonus showcase: populate one
// sample eligible result for every built-in and configured bonus so reviewers
// can see the complete card set without needing a live player lookup.
const BONUS_SHOWCASE_PREVIEW = !IS_EMBEDDED_APP;
let showPreviewClosedChat = false;
let activeMainTab = "customer";
const MAIN_TAB_SESSION_KEY = `rc-main-tab:${CONFIGURED_LIVECHAT_ACCOUNT || "default"}`;
try { if (sessionStorage.getItem(MAIN_TAB_SESSION_KEY) === "blast") activeMainTab = "blast"; } catch (_) {}

// Department access is intentionally session-only. Each incognito LiveChat
// window gets its own value, and closing that window clears it. Until a valid
// LiveChat group response arrives, use the smaller CS view.
const DEPARTMENT_SESSION_KEY = "rc-agent-department";
let currentDepartment = "cs";
try {
  const savedDepartment = sessionStorage.getItem(DEPARTMENT_SESSION_KEY);
  if (savedDepartment === "rtn" || savedDepartment === "cs") currentDepartment = savedDepartment;
} catch (_) { /* sessionStorage may be unavailable in a hardened iframe */ }

function departmentFromGroups(groups) {
  const names = Array.isArray(groups) ? groups.map((name) => String(name || "").trim()) : [];
  return names.some((name) => /^priority\s+(?:96|tc)$/i.test(name)) ? "rtn" : "cs";
}

function setDepartmentFromGroups(groups) {
  if (!Array.isArray(groups)) return;
  const previousTab = activeMainTab;
  currentDepartment = departmentFromGroups(groups);
  try { sessionStorage.setItem(DEPARTMENT_SESSION_KEY, currentDepartment); } catch (_) {}
  syncMainTabs();
  if (activeMainTab !== previousTab) renderChats(activeChats);
}

function mainTabAvailability() {
  if (!previewMode) {
    return { customer: true, tickets: false, blast: BLAST_LIVE, knowledge: false };
  }
  if (!DEPARTMENT_SEPARATION_ENABLED) {
    return { customer: true, tickets: ESCALATION_TICKET_ENABLED, blast: true, knowledge: true };
  }
  const rtn = currentDepartment === "rtn";
  return {
    customer: rtn,
    tickets: ESCALATION_TICKET_ENABLED,
    blast: rtn,
    knowledge: true,
  };
}

function syncMainTabs() {
  const available = mainTabAvailability();
  const { tickets: ticketsAvailable, blast: blastAvailable, knowledge: knowledgeAvailable } = available;
  // Chat/department updates can arrive after an agent starts Blast.
  // Keep its existing iframe visible for the lifetime of the queue.
  if (blastRunInProgress && blastAvailable) activeMainTab = "blast";
  if (!available[activeMainTab]) {
    activeMainTab = ticketsAvailable ? "tickets" : knowledgeAvailable ? "knowledge" : available.customer ? "customer" : "blast";
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
  document.querySelectorAll("[data-main-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mainTab === activeMainTab);
  });
  const chatList = document.getElementById("chatList");
  if (chatList) chatList.hidden = activeMainTab === "knowledge" || activeMainTab === "blast";
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
  const needsAttention = document.getElementById("needsAttentionPanel");
  if (needsAttention) needsAttention.style.display = activeMainTab === "customer" ? "" : "none";
}

// Builds our chat shape from the SDK's ICustomerProfile. One remaining gap,
// confirmed from the SDK's own type definitions (not just undocumented) —
// not solvable from the SDK alone: no chat permalink/URL, so link stays ""
// (Open ↗ link hidden). Brand and Telegram both start blank/false here too,
// but get filled in server-side shortly after (see resolveBrandFromGroupId
// and checkChatStatus) via LiveChat's own REST API, not from this object.
function chatFromProfile(profile) {
  return {
    chatId: profile.chat.id,
    customerName: profile.name || "Unknown customer",
    link: "",
    isTelegram: false,
    groupName: "",
  };
}

// Finds the card (state key) for an archived-chat profile. Cards are keyed
// by thread id, which is the id in /archives/{thread_id} -- and also the
// second segment of the /chats/{chat_id}/{thread_id} link saved in
// s.chatUrl, so both are checked. Deliberately NOT matched on chat_id (the
// first segment): that one is shared by every past session of the same
// customer and could open the wrong session's card.
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

// Set once the SDK actually connects — lets the Refresh button re-sync
// against the real widget on demand instead of always claiming "preview
// mode", which stopped being accurate the moment live mode existed.
let liveWidget = null;

// Top-level (not nested in initLiveChatSdk's closure) so the Refresh button
// can also call this directly for a manual re-sync.
// Small, self-dismissing on-screen confirmation, separate from the
// diagnostics-only statusBar (see setStatus -- routine confirmations are
// deliberately silent there). This one is specifically for "which chat did
// that action just affect" -- the thing CS has no other way to check in the
// moment, handling several chats at once.
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

// Called right before applyProfile swaps to a different chat -- this is the
// exact moment a stray click could otherwise land on the wrong customer.
// Flags it loudly, and extra loudly if the chat being swapped AWAY from had
// something unsaved (a typed-but-not-looked-up username, or a lookup still
// in flight) -- that's the specific situation that can turn into recording
// one customer's case under a different one's card.
function announceChatSwitch(prevChatId, nextChat) {
  const prev = prevChatId ? state[prevChatId] : null;
  const nextLabel = nextChat.customerName || nextChat.chatId;
  if (prev && prev.usernameDraft) {
    // Typed but never looked up: that one really can end up recorded under the wrong customer, so it stays a loud warning.
    showChatToast(`⚠ Switched chats before "${prev.usernameDraft}" was submitted — now viewing ${nextLabel}. Come back to the other chat to finish it.`, "warn");
  } else if (prev && prev.lookupInFlight && prevChatId !== nextChat.chatId) {
    // A running lookup is not a problem: it writes into ITS chat and the result is waiting there.
    showChatToast(`Lookup for ${prev.pendingLookup?.username || prev.username || "this player"} keeps running — results will be waiting when you come back.`, "info");
  } else if (prevChatId && prevChatId !== nextChat.chatId) {
    showChatToast(`Now viewing ${nextLabel}`, "info");
  }
}

// ---- A lookup keeps running when the agent switches chats ---------------------------------------------------------------------
// The request itself never depended on which chat is in front (it writes into ITS chat's state); what used to go wrong was what it SAID:
// its toast / status-bar text landed on whatever chat was focused by then, and a widget reload mid-lookup lost the result. Now:
//  * every message a lookup produces is stored on THAT chat's state (s.lookupMessage, shown in that chat's card), and goes to the global
//    status bar / toast only while that chat is still the focused one; otherwise ONE neutral toast says it finished elsewhere;
//  * a small pill shows "1 lookup running in another chat", then "Lookup for X done" for a few seconds;
//  * the running lookup is remembered (s.pendingLookup, no secrets) so a widget that is recreated mid-lookup can resume it once.
const LOOKUP_RESUME_MAX_AGE_MS = 40_000;   // an unfinished lookup older than this is "interrupted", not resumed
const LOOKUP_LOCK_MS = 10_000;             // lock lease; the running widget renews it every LOOKUP_LOCK_BEAT_MS
const LOOKUP_LOCK_BEAT_MS = 3_000;
const LOOKUP_DONE_PILL_MS = 10_000;
const LOOKUP_INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; // this copy of the widget
let bgLookupDone = null;                   // { chatId, text, attention, until }: the "done" pill
let bgLookupPillTimer = null;
let lookupResumeTimer = null;
let lookupResumeCandidates = null;         // chats that had an unfinished lookup when this widget loaded

function isFocusedChat(chatId) {
  return !!chatId && activeChats[0]?.chatId === chatId;
}

// What this lookup wants to say. Always remembered on its own chat; in the global status bar only while that chat is in front.
// `attention` = it failed or something is unavailable (the neutral "finished" toast then says so).
// The message is not drawn in the player card (only the status bar / Diagnostics); a finished lookup is recognised by it.
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

// A lookup ended while its chat was not in front: one neutral toast, and the "done" pill.
function announceLookupFinishedElsewhere(chatId, username) {
  const s = state[chatId];
  const who = username || s?.username || "a player";
  const attention = !!s?.lookupMessage?.attention;
  showChatToast(attention ? `⚠ Lookup for ${who} needs attention (other chat)` : `Lookup for ${who} finished (other chat)`, attention ? "warn" : "info");
  bgLookupDone = { chatId, text: attention ? `⚠ Lookup for ${who} needs a retry` : `✓ Lookup for ${who} done`, attention, until: Date.now() + LOOKUP_DONE_PILL_MS };
}

// ---- who may (re)run a chat's lookup: one widget copy at a time --------------------------------------------------------------
const lookupLockKey = (chatId) => `ca-lookup-lock:${chatId}`;
function lookupLockHeldByOther(chatId) {
  try {
    const lock = JSON.parse(localStorage.getItem(lookupLockKey(chatId)) || "null");
    return !!(lock && lock.instance !== LOOKUP_INSTANCE_ID && Number(lock.until) > Date.now());
  } catch (_) { return false; }                // unusable storage: do not block
}
function takeLookupLock(chatId) {
  try { localStorage.setItem(lookupLockKey(chatId), JSON.stringify({ instance: LOOKUP_INSTANCE_ID, until: Date.now() + LOOKUP_LOCK_MS })); } catch (_) { /* best effort */ }
}
function releaseLookupLock(chatId) {
  try {
    const lock = JSON.parse(localStorage.getItem(lookupLockKey(chatId)) || "null");
    if (lock && lock.instance === LOOKUP_INSTANCE_ID) localStorage.removeItem(lookupLockKey(chatId));
  } catch (_) { /* best effort */ }
}

// The lookup of one chat: the Look up button, and the resume after a widget reload, both end up here. `btn` is the clicked button (null
// when resumed). Nothing here reads the DOM of the chat that is in front: everything it needs is passed in or lives in state[chatId].
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
  s.lookupMessage = null;                                   // a new lookup replaces the previous message
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
    renderChats(activeChats);                               // resumed: show the Cancel button
  }
  refreshBackgroundLookupPill();
  saveState();                                              // a widget that is recreated now finds pendingLookup and can resume it
  try {
    // lark-search.js resolves every bonus's own source table directly now
    // (no more Customer Approaching Lookup-column delay) — this response
    // is already final, nothing left to poll for.
    //
    // One Customer Approaching row per chat, not one per Look Up click —
    // a repeat lookup for this same chat passes back the record created
    // last time so the backend deletes it first. Only sent if that
    // record hasn't been logged (submitted) yet — a completed case is
    // never deleted by a stray re-lookup (previousRecordId is decided by the caller).
    const { row, otherBrands, lookupWarnings, caRecordId, caseRowError, notVip } = await fetchBonusRow(username, brand, link, telegramNow, selectedAgent, previousRecordId, controller.signal);
    s.caLinkSaved = !!link;
    s.matchedRow = row;
    s.otherBrandMatches = otherBrands;
    s.caRecordId = caRecordId;
    if (previousRecordId && caRecordId !== previousRecordId) rememberDeletedRecord(previousRecordId); // the server replaced it
    s.caOwner = selectedAgent;
    s.claimedPrograms = {};
    s.vs96FeedbackQuery1 = "";
    s.vs96FeedbackQuery2 = "";
    s.riskReloadAmount = "";
    s.gracePeriodActivated = false;
    s.releasedBonusAmount = "";
    s.releasedAmountRaw = "";
    s.claimSecret = false;
    s.claimSecretManual = false;
    const sameForced = !!s.forcedVipFor && s.forcedVipFor.toLowerCase() === username.toLowerCase();
    if (isFocusedChat(chatId)) showChatToast(`✓ Looked up "${username}" — ${brand}`, "info");
    if (notVip && !forcing && !sameForced) {
      // CS only tracks VIP retention here — a confirmed non-VIP result
      // is treated the same as Unknown player: nothing about this chat
      // should end up in Customer Approaching (see setUnknown). The
      // checkbox/username row lives outside the three targeted slots
      // below, so this needs a full render -- done after the in-flight
      // flag clears, so the button comes back as "Force lookup".
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
    // The bonus results above are valid; only the Lark case row was not saved. Warn, do not fail.
    if (caseRowError) {
      lookupSay(chatId, lookupWarnings.length ? `${caseRowError} Also unavailable: ${lookupWarnings.join(", ")}.` : caseRowError, "error", true);
    }
  } catch (err) {
    if (forcing) s.isUnknown = true; // failed force lookup -- back to how it was
    if (controller.signal.aborted) {
      lookupSay(chatId, timedOut ? "Lookup timed out after 45 seconds. Try again." : "Lookup canceled.", timedOut ? "error" : "info", timedOut);
    } else {
      lookupSay(chatId, "Lookup failed: " + err.message, "error", true);
    }
  } finally {
    clearTimeout(timeoutId);
    clearInterval(lockBeat);
    if (lookupControllers.get(chatId) === controller) lookupControllers.delete(chatId);
    scheduleNeedsAttentionRefresh(1500); // a new case row may now belong in Needs Attention (the timer is slower now)
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
          if (playerInfo) playerInfo.innerHTML = renderPlayerInfo(chatId);
          if (ticketSlot) ticketSlot.innerHTML = renderTickets(chatId);
          if (autoFields) autoFields.innerHTML = renderAutoFields(chatId);
        }
      }
    } else {
      announceLookupFinishedElsewhere(chatId, username);      // its card is drawn fresh (with the message) when the agent comes back
    }
    refreshBackgroundLookupPill();
    saveState();
  }
}

// After the widget is (re)created: a lookup that was running when the old copy went away is re-run ONCE if it is recent. The server
// reuses the chat's blank row (chat link + the queue's create memory), so no second row appears. Older, or already resumed once:
// "interrupted". Never another agent's lookup, never one that another widget copy is (still) running or resuming.
function resumePendingLookups() {
  clearTimeout(lookupResumeTimer);
  if (!selectedAgent || !lookupResumeCandidates) return;
  let waiting = false;
  for (const chatId of [...lookupResumeCandidates]) {
    const s = state[chatId];
    const p = s?.pendingLookup;
    if (!p || s.lookupInFlight) { lookupResumeCandidates.delete(chatId); continue; }
    const age = Date.now() - Number(p.startedAt || 0);
    if (s.lookupMessage && Number(s.lookupMessage.at) >= Number(p.startedAt || 0)) { s.pendingLookup = null; lookupResumeCandidates.delete(chatId); continue; }   // it did finish
    if (p.agent !== selectedAgent || (s.caOwner && s.caOwner !== selectedAgent)) { lookupResumeCandidates.delete(chatId); continue; }   // somebody else's: leave it alone
    if (p.resumed || !(age >= 0 && age < LOOKUP_RESUME_MAX_AGE_MS)) {
      s.pendingLookup = null;
      lookupResumeCandidates.delete(chatId);
      lookupSay(chatId, "Lookup was interrupted — click Look up.", "info", true);
      saveState();
      continue;
    }
    if (lookupLockHeldByOther(chatId)) { waiting = true; continue; }       // another copy is on it (or just died: its lock lapses within seconds)
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

// The archived chat a "restore from Lark" is currently being waited for, so a slow answer cannot open a card for a chat the
// agent has already left.
let archiveOpening = "";

// An archived chat from the agent's unrecorded-chats list has no card anywhere (that is why it is on the list): no saved copy
// in this browser and no Lark row under their name. Build a fresh, closed card for it so they can look the player up and
// record it like any other chat, instead of finding an empty panel. Nothing is stamped on it until they record.
function openFreshArchivedCard(threadId, entry, profile) {
  if (!state[threadId]) {
    ensureChatState({ chatId: threadId, customerName: (profile && profile.name) || entry.customer || "", link: "", isTelegram: false, groupName: "" });
  }
  const s = state[threadId];
  s.chatOpen = false;
  // The link every other row carries: /chats/{chat_id}/{thread_id} (the chat id is what "last username" matching uses).
  if (!s.chatUrl && entry.chatId) s.chatUrl = `https://my.livechatinc.com/chats/${entry.chatId}/${threadId}`;
  saveState();
  resolveBrandFromGroupId(threadId, profile && profile.chat && profile.chat.groupID);
  showTrackedArchivedChat(threadId, profile);
  setStatus("Archived chat from your unrecorded list — look the player up and record it, or tick Unknown player.");
}

function applyProfile(profile) {
  archiveOpening = "";
  if (!profile || !profile.chat || !profile.chat.id) {
    stopChatStatusPolling();
    activeChats = [];
    renderChats(activeChats);
    return;
  }
  // The SDK fires this same customer_profile event/getCustomerProfile()
  // shape for three different contexts (profile.source): "chats" (a real
  // live conversation), "archives" (an agent just browsing chat history),
  // and "customers" (the Customers section). Confirmed live: opening an
  // archived chat was triggering a full lookup/status-polling cycle for it
  // exactly like a real live chat -- this widget has nothing useful to do
  // for either of the other two, so only "chats" is treated as an actual
  // active chat; everything else clears the widget the same as no profile
  // at all, rather than silently tracking something that's already over.
  // Exception: an archived chat this widget already has a card for. Once a
  // chat ends, LiveChat rewrites its link from /chats/{chat_id}/{thread_id}
  // to /archives/{thread_id}, so clicking Open on a Needs Attention card
  // lands here as an "archives" profile, not "chats". Matched by thread id
  // (the second id, and the key every card is stored under), so the agent
  // gets their own saved card back to finish and record it -- nothing is
  // tracked or polled, since the chat is already over.
  if (profile.source === "archives") {
    const trackedId = findTrackedChatByThread(profile);
    if (trackedId) {
      showTrackedArchivedChat(trackedId, profile);
      return;
    }
    // No saved card in this browser (e.g. a new incognito window) -- look
    // for this agent's own Lark rows for this thread and rebuild it.
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
  if (bgLookupDone && bgLookupDone.chatId === chat.chatId) bgLookupDone = null;   // the agent is back: no need to say it again
  refreshBackgroundLookupPill();
  // In live mode there's only ever one chat shown at a time, so a newly-
  // active chat should always render expanded — collapsing exists to save
  // space among several chats, which doesn't apply here.
  ensureChatState(chat);
  state[chat.chatId].expanded = true;
  renderChats(activeChats);
  resolveBrandFromGroupId(chat.chatId, profile.chat.groupID);
  startChatStatusPolling(chat.chatId);
  if (!state[chat.chatId].caRecordId) restoreCardFromLark(chat.chatId, { customerName: chat.customerName });
}

// The SDK only gives us an opaque groupID (chatFromProfile leaves groupName
// blank), so this resolves it server-side via LiveChat's own Groups API
// (see livechat-group-name.js — no LiveChat PAT configured just means this
// quietly does nothing) and runs the real name through the same
// deriveBrandFromGroup() the old demo data used.
// In-memory only (per widget copy): the brand this copy detected for each
// chat, and the group id it came from -- lets Look up recover Brand if the
// saved copy of the card ever loses it, and re-detect if it never had it.
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
  } catch (_) { /* OAuth remains optional until the agent connects LiveChat */ }
  return tokens;
}

// A new LiveChat tab starts with an empty sessionStorage, so the login used to be asked for again in every tab. The login is
// also kept in localStorage -- shared by the tabs of one browser window, forgotten when an incognito window closes -- and a tab
// copies it back into its own sessionStorage as it opens (the Blast page reads it from there). The expiry is the same as
// LiveChat's, so nothing outlives the token.
const LIVECHAT_LOGIN_BACKUP = "ca-livechat-login-backup";
function saveLiveChatLogin(accountKey, token, expiresAt) {
  try {
    sessionStorage.setItem(`ca-livechat-agent-token:${accountKey}`, token);
    sessionStorage.setItem(`ca-livechat-agent-token-expiry:${accountKey}`, String(expiresAt));
    sessionStorage.setItem("ca-livechat-selected-account", accountKey);
  } catch (_) { /* without sessionStorage this tab cannot keep the login */ }
  try { localStorage.setItem(`${LIVECHAT_LOGIN_BACKUP}:${accountKey}`, JSON.stringify({ token, expiresAt: Number(expiresAt) })); } catch (_) { /* other tabs will ask */ }
}
function forgetLiveChatLogin(accountKey) {
  try {
    sessionStorage.removeItem(`ca-livechat-agent-token:${accountKey}`);
    sessionStorage.removeItem(`ca-livechat-agent-token-expiry:${accountKey}`);
  } catch (_) { /* non-fatal */ }
  try { localStorage.removeItem(`${LIVECHAT_LOGIN_BACKUP}:${accountKey}`); } catch (_) { /* non-fatal */ }
}
// A tab without its own login takes the shared one, if it is still valid; an expired shared one is cleaned away.
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
    } catch (_) { /* no storage: the agent signs in as before */ }
  }
}

// One-time re-login. A LiveChat login made before the accounts scopes were added to the two LiveChat apps cannot read the
// agent's email, so every stored login is dropped once and the agent signs in again (their agent name comes straight back).
// The mark that this was done lives in both storages, so a new tab does not repeat it. To force another round later, change
// the epoch.
const LIVECHAT_TOKEN_EPOCH = "2026-10-08-accounts-scopes";
const LIVECHAT_TOKEN_EPOCH_KEY = "ca-livechat-token-epoch";
function dropOldLiveChatTokens() {
  let done = false;
  try { done = sessionStorage.getItem(LIVECHAT_TOKEN_EPOCH_KEY) === LIVECHAT_TOKEN_EPOCH; } catch (_) { /* non-fatal */ }
  try { done = done || localStorage.getItem(LIVECHAT_TOKEN_EPOCH_KEY) === LIVECHAT_TOKEN_EPOCH; } catch (_) { /* non-fatal */ }
  if (!done) for (const accountKey of ["lc1", "lc2"]) forgetLiveChatLogin(accountKey);
  try { sessionStorage.setItem(LIVECHAT_TOKEN_EPOCH_KEY, LIVECHAT_TOKEN_EPOCH); } catch (_) { /* non-fatal */ }
  try { localStorage.setItem(LIVECHAT_TOKEN_EPOCH_KEY, LIVECHAT_TOKEN_EPOCH); } catch (_) { /* non-fatal */ }
}
dropOldLiveChatTokens();
restoreLiveChatLogins();

async function resolveBrandFromGroupId(chatId, groupID) {
  if (groupID) groupIdFor.set(chatId, groupID);
  if (!chatId) return;
  if (!groupID) {
    // Silent before this — if the SDK profile ever lacks a groupID at all,
    // there'd be zero trace of why Brand never auto-filled. Logged once
    // instead of every call so a genuinely groupID-less setup doesn't spam.
    if (!rawGroupIdMissingLoggedFor.has(chatId)) {
      rawGroupIdMissingLoggedFor.add(chatId);
      logDiagnostic(`Brand auto-detect skipped for this chat — LiveChat's SDK profile had no groupID.`, "warn");
    }
  }
  try {
    const res = await fetch("/livechat-group-name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // chatId here is the thread id (see chatFromProfile) -- lets the server
      // find which LiveChat account owns the chat, since a group ID alone is
      // only unique within one account.
      body: JSON.stringify({ groupID, threadId: chatId, agentTokens: liveChatAgentTokens() }),
    });
    const data = await res.json();
    if (data.accountKey) setCurrentLiveChatAccount(data.accountKey, chatId);
    // Group names also carry the department marker. Run this before the
    // Brand early-return because Priority 96 / Priority TC deliberately do
    // not count as brand groups.
    if (data.ok && Array.isArray(data.departmentGroups)) {
      // Authoritative: these belong to the signed-in OAuth agent, rather
      // than whichever agent most recently participated in this chat.
      setDepartmentFromGroups(data.departmentGroups);
    }
    if (!data.ok || !data.groupName) {
      // Same deal — this used to fail completely silently, which is exactly
      // how the JUS-brand-never-detected report went untraceable. data.error
      // (from livechat-group-name.js's own catch) says why when there is one.
      logDiagnostic(
        `Brand auto-detect failed for group ID "${groupID}"${data.error ? `: ${data.error}` : " — group not found in LiveChat's group list."}`,
        "warn"
      );
      scheduleBrandRetry(chatId, groupID); // LiveChat lookup failed -- try again shortly
      return;
    }
    const s = state[chatId];
    // Bail if the agent already picked a brand manually, or the chat moved
    // on before this (network-latency) response arrived.
    if (!s || s.brand) return;
    // Only ever auto-fill Brand with a value that's an exact match (case-
    // insensitive) against brandOptions — Lark's Brand field is a Single
    // Select, and writing anything that isn't an existing option silently
    // creates a brand-new one there instead of erroring. A group naming
    // convention this parser doesn't fully understand (e.g. "AS126
    // GENERAL" deriving to "AS", which isn't a real Brand option) must
    // leave Brand blank for a manual pick, never guess and risk polluting
    // that field's option list.
    const derived = deriveBrandFromGroup(data.groupName);
    const matchedBrand = brandOptions.find((b) => b.toLowerCase() === derived.toLowerCase());
    if (!matchedBrand) {
      if (!brandOptions.length) scheduleBrandRetry(chatId, groupID); // option list not loaded yet
      // A Brand added in Lark after this widget loaded is not in the in-memory list yet (it is only
      // re-read on a slow timer). Re-read it now -- at most once every 30 s -- and try again.
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
    s.brand = matchedBrand; // canonical casing from Lark's own option list, not whatever the group name happened to use
    // Full code (with digits) for the Escalation Ticket section's own Brand
    // field, which expects e.g. "VS96" not "VS" -- only fills in if blank,
    // same as Brand itself, so a manual pick there sticks too.
    if (!s.escalation.brand) s.escalation.brand = deriveFullBrandCode(data.groupName);
    logDiagnostic(`Auto-detected brand "${s.brand}" from group "${data.groupName}"${data.groups && data.groups.length > 1 ? ` (chat's groups: ${data.groups.join(", ")})` : ""}.`);
    if (activeChats[0]?.chatId === chatId) renderChats(activeChats);
    checkLastUsername(chatId); // brand is one of the two things this needs — try now that it's ready
  } catch (err) {
    logDiagnostic(`Brand auto-detect request failed: ${err.message}`, "warn");
    scheduleBrandRetry(chatId, groupID);
  }
}
const rawGroupIdMissingLoggedFor = new Set(); // avoid re-logging the same missing-groupID chat repeatedly

// LiveChat's URL is /chats/{chat_id}/{thread_id} — chat_id stays the same
// across every reopen of a given customer's conversation, thread_id is
// unique to each individual chat session (confirmed via the auto-close
// investigation). Only chat_id can ever match a *previous* chat's link.
function extractStableChatId(link) {
  const m = String(link || "").match(/\/chats\/([^/]+)\/[^/]+/);
  return m ? m[1] : "";
}

// Looks up P&L's "Live Chat link" field for a row whose link contains THIS
// chat's stable chat_id — if this exact customer chatted before and that
// case got recorded, this recognizes them before the agent even asks.
// Needs both Brand (to scope the search — never search another brand's
// players) and the resolved chat link (only available once
// livechat-chat-status.js resolves the real chat_id, ~a poll tick after the
// chat opens) — safe to call from either place, since it no-ops until both
// are ready and only ever runs once per chat.
//
// lastUsernameStarted (not lastUsernameChecked) is the "don't call twice"
// guard, set the instant this begins — separate from lastUsernameLoading
// (the visible state) so an agent sees "Checking…" immediately instead of
// nothing changing until the network round trip finishes. Without that
// visible cue, someone might start typing their own guess in the still-
// empty box while this is in flight — since the auto-fill only ever fills
// an empty box, that typing would silently and permanently pre-empt it for
// this chat, with no obvious reason why the auto-fill "didn't work."
async function checkLastUsername(chatId) {
  const s = state[chatId];
  if (!s || s.lastUsernameStarted) return;
  // Prefer s.chatUrl (survives once this chat isn't the focused one
  // anymore) over activeChats[].link, which only exists while it is.
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
      // Semi-auto: only fills the box if the agent hasn't already typed
      // something themselves — never overwrites a manual entry.
      if (!s.username) s.username = data.username;
    } else {
      s.lastUsernameFound = false;
      // "Live Chat link" on P&L is a Lookup field, not a plain stored
      // value — whether Lark's search API can even filter by a Lookup at
      // all is unverified. If it can't, this is where that would show up,
      // so surface it rather than let this look identical to "no match".
      if (data.error) logDiagnostic(`Last-username lookup failed: ${data.error}`, "warn");
    }
  } catch (_) { /* non-fatal — just no "last username" hint shown */ }
  s.lastUsernameLoading = false;
  s.lastUsernameChecked = true;
  updateLastUsernameUi(chatId);
}

// Surgical DOM update (not a full renderChats) so this never disrupts
// whatever the agent might be actively doing elsewhere on the card —
// updates the username box's placeholder/value and the player-info line.
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

// Polls LiveChat's Agent Chat API (via livechat-chat-status.js) for the
// currently active chat's Telegram/open-closed status — there's no push
// event for either (confirmed for Telegram from the SDK's own types;
// confirmed for chat-closed from the SDK having no such event at all), so
// this is the only way to detect them short of a full webhook integration.
// The Telegram toggle stays manually overridable alongside this (see the
// "change" listener below) — chat-closed detection has no manual fallback
// anymore since the "Close chat" button was removed once this auto-close
// path proved reliable.
let chatStatusPollTimer = null;
const CHAT_STATUS_POLL_MS = 2_000; // worst-case detection latency = this value; avg = half of it
const CLOSE_STATUS_CONFIRMATIONS = 2;
const closeStatusEvidenceByChat = new Map();
const rawStatusDebugLoggedFor = new Set(); // avoid re-logging the same raw payload every tick
const firstCheckLoggedFor = new Set(); // one confirmation per chat that get_chat succeeded at all
const errorLoggedFor = new Set(); // avoid spamming the same persistent error every 20s
const autoMissingLoggedFor = new Map(); // chatId -> last "missing" list logged by submitRecord's auto path, so sweepPendingChats retrying a permanently-incomplete chat doesn't spam the identical message every 8s forever

let chatStatusPollTick = null;
function stopChatStatusPolling() {
  chatStatusPollTick = null;
  if (chatStatusPollTimer) {
    clearInterval(chatStatusPollTimer);
    chatStatusPollTimer = null;
  }
}

// Owns the tight (every CHAT_STATUS_POLL_MS) poll for whichever ONE chat is
// currently focused/on screen — the only chat this widget instance can ever
// actually be "live" for (see sweepPendingChats below for everything else).
// The "should this timer keep going" decision lives here, not inside
// checkChatStatus itself, since checkChatStatus is also called directly by
// the sweep for other chats and must never be able to stop THIS timer as a
// side effect of checking some other chat.
function startChatStatusPolling(chatId) {
  stopChatStatusPolling();
  const tick = () => {
    const s = state[chatId];
    if (!s || !s.chatOpen || s.logged) { stopChatStatusPolling(); return; }
    // A hidden widget cannot show anything, so do not spend a Lark/LiveChat call every 2 s on it.
    // The background sweep still checks this chat while hidden (see sweepPendingChats), and one
    // immediate tick runs the moment the widget becomes visible again.
    if (document.hidden) return;
    checkChatStatus(chatId);
  };
  chatStatusPollTick = tick;
  tick(); // don't wait for the first interval tick
  chatStatusPollTimer = setInterval(tick, CHAT_STATUS_POLL_MS);
}

// Checks ONE chat's open/Telegram status and auto-records it if it just
// closed. Deliberately has no dependency on activeChats[0] or the
// chatStatusPollTimer above — callable equally for the currently-focused
// chat (via startChatStatusPolling) or any other pending chat (via
// sweepPendingChats), since LiveChat's Details widget only runs one
// instance per focused chat and a background chat needs exactly the same
// check, just from a different caller and cadence.
async function checkChatStatus(chatId) {
  const s = state[chatId];
  if (!s || !s.chatOpen || s.logged) return;
  try {
    // Once a previous check has resolved s.chatUrl, pull the real chat_id
    // back out of it (https://my.livechatinc.com/chats/{chatId}/{threadId})
    // and send it along -- lets the backend look this exact chat up
    // directly instead of searching list_chats' 100-most-recent window,
    // which a backgrounded chat silently falls out of over time (see
    // livechat-chat-status.js's getChatFor header note).
    const realChatId = s.chatUrl?.match(/\/chats\/([^/]+)\//)?.[1] || null;
    const res = await fetch("/livechat-chat-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // accountKey: ask the license this chat is known to belong to first; debug: ask for the raw
      // LiveChat payload only until this chat's first successful check has been logged.
      body: JSON.stringify({ chatId, realChatId, accountKey: s.liveChatAccount || currentLiveChatAccount || undefined, debug: !firstCheckLoggedFor.has(chatId) || undefined }),
    });
    const data = await res.json();
    if (!data.ok) return;
    if (data.accountKey) setCurrentLiveChatAccount(data.accountKey, chatId);

    // chatId here is actually the thread id (see livechat-chat-status.js
    // header note) — the backend resolves the real chat id via list_chats
    // and hands back a ready-to-click chatUrl once it does. Logged wherever
    // available so the agent can cross-check against LiveChat's own UI.
    const linkSuffix = data.chatUrl ? ` (${data.chatUrl})` : ` (thread ${chatId}, chat id not yet resolved)`;

    // Saved on state itself (not just activeChats[].link) so it's still
    // there for submitRecord/checkLastUsername once this chat isn't the
    // focused one anymore — activeChats[].link (what the "Open ↗" button
    // and claim's chatLink read) is kept in sync too, when there's a live
    // entry for it. Previously always "" (chatFromProfile has no way to get
    // a permalink from the SDK alone), so both were silently blank for
    // every real chat until now.
    if (data.chatUrl && s.chatUrl !== data.chatUrl) {
      s.chatUrl = data.chatUrl;
      const chatEntry = activeChats.find((c) => c.chatId === chatId);
      if (chatEntry) chatEntry.link = data.chatUrl;
      if (activeChats[0]?.chatId === chatId) renderChats(activeChats);
      checkLastUsername(chatId); // the chat link is the other thing this needs — try now that it's ready
    }
    saveLinkToRecord(chatId);

    if (data.error) {
      // Once per chat — this call runs every 20s, and a persistent error
      // would otherwise spam the log with the identical line on every tick.
      if (!errorLoggedFor.has(chatId)) {
        errorLoggedFor.add(chatId);
        logDiagnostic(`Chat status check failed for thread "${chatId}": ${data.error}`, "error");
      }
      return;
    }

    if (data.notConfigured) {
      // Distinct, unmistakable message — this used to fall through to the
      // "raw" branch below with no raw payload to show, which crashed
      // JSON.stringify(undefined).slice(...) and got silently swallowed by
      // the catch, giving zero diagnostic feedback for the single most
      // likely misconfiguration (LIVECHAT_PAT missing on this site).
      if (!rawStatusDebugLoggedFor.has(chatId)) {
        rawStatusDebugLoggedFor.add(chatId);
        logDiagnostic("Telegram/auto-close detection is off — LIVECHAT_PAT isn't set on this site.", "warn");
      }
      return;
    }

    if (data.notFound) {
      // The thread wasn't among the chats list_chats returned — surfaced
      // distinctly so it's never mistaken for a confirmed close.
      if (!rawStatusDebugLoggedFor.has(chatId)) {
        rawStatusDebugLoggedFor.add(chatId);
        logDiagnostic(`Chat lookup for thread "${chatId}" found no match in list_chats — raw: ${JSON.stringify(data.raw ?? null)}`, "warn");
      }
      return;
    }

    // Confirms the lookup actually resolved this chat at least once —
    // otherwise a later miss is ambiguous: did it ever work, or was it
    // always broken for this chat? Logged once, success or not.
    if (!firstCheckLoggedFor.has(chatId)) {
      firstCheckLoggedFor.add(chatId);
      logDiagnostic(`First chat status check succeeded: isActive=${data.isActive}, isTelegram=${data.isTelegram}.${linkSuffix}`);
    }

    // Skips overwriting once CS has manually toggled this — otherwise the
    // next poll tick (every 2s) would just flip a manual correction right
    // back, making the override effectively impossible to keep.
    if (typeof data.isTelegram === "boolean" && data.isTelegram !== s.telegram && !s.telegramManual) {
      s.telegram = data.isTelegram;
      logDiagnostic(`Auto-detected Telegram chat = ${data.isTelegram}.${linkSuffix}`);
      if (activeChats[0]?.chatId === chatId) renderChats(activeChats);
    } else if (data.isActive === null && !rawStatusDebugLoggedFor.has(chatId)) {
      // Expected fields weren't found — surface the raw response once so
      // the field paths can be corrected against real data.
      rawStatusDebugLoggedFor.add(chatId);
      logDiagnostic("Chat status fields not recognized — raw: " + JSON.stringify(data.raw ?? null).slice(0, 500), "warn");
    }

    if (data.isActive !== false) closeStatusEvidenceByChat.delete(chatId);

    if (data.isActive === false && s.chatOpen) {
      // list_chats can briefly return an old inactive thread summary just as
      // a chat is reopened. Never close from that broad snapshot; first get
      // the resolved chat id, then require two spaced confirmations from the
      // direct get_chat path before auto-recording anything.
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
      // Only stop chatStatusPollTimer if it's actually this chat's own —
      // checkChatStatus is also called for other chats by sweepPendingChats
      // below, which must never stop the currently-focused chat's timer as
      // a side effect of some other chat closing.
      if (activeChats[0]?.chatId === chatId) stopChatStatusPolling();
      s.chatOpen = false;
      if (activeChats[0]?.chatId === chatId) renderChats(activeChats);
      await submitRecord(chatId, { auto: true });
      renderNeedsAttentionPanel(); // reflect immediately if that submit left this chat incomplete
    }
  } catch (_) { /* non-fatal — just try again next tick */ }
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
    // We're definitely embedded in real LiveChat now (this promise only
    // resolves inside an actual Agent App) — stop showing demo data
    // immediately, even before we know whether a chat happens to be
    // selected yet. Previously this only replaced activeChats once a valid
    // profile arrived, so with nothing selected (getCustomerProfile()
    // returning null) the sample chats stayed visible forever, looking
    // like real data when it wasn't.
    activeChats = [];
    renderChats(activeChats);
    applyProfile(widget.getCustomerProfile());
    widget.on("customer_profile", applyProfile);
  }).catch((err) => {
    logDiagnostic("LiveChat Agent App SDK failed to connect (" + err.message + ") — staying in demo/preview mode.", "error");
  });
}

// Most LiveChat groups are named "<BRAND><DIGITS> Priority Support" —
// Lark's Brand lookup strips digits — "VS96 Priority Support" → "VS". Some
// (2026-09-10, confirmed from a real Groups list: "HOT GENERAL", "EZ
// GENERAL", "VS GENERAL", "RM GENERAL", "BM GENERAL", "AS126 GENERAL")
// instead use "<BRAND>[DIGITS] GENERAL" — same shape, different suffix, so
// stripped the same way. A plain "General"/"96 General" group (no real
// brand in the name at all) still correctly falls through to an empty
// string either way, leaving Brand for a manual pick same as always.
function deriveBrandFromGroup(groupName) {
  if (!groupName) return "";
  return groupName
    .replace(/\s*(prior\w*\s+support|general)\s*/i, "")
    .replace(/\d+/g, "")
    // Strips emoji (e.g. the flag LiveChat group names wrap the brand code
    // in) — Extended_Pictographic covers most emoji, Regional_Indicator
    // covers flag pairs specifically (flags aren't pictographic symbols),
    // ️/‍ are the variation selector/ZWJ used to combine glyphs.
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Same cleanup as deriveBrandFromGroup, but keeps the digits -- the
// escalation ticket's own Brand field expects the full brand+number code
// ("VS96", not "VS"; confirmed from the real table's Brand column values).
function deriveFullBrandCode(groupName) {
  if (!groupName) return "";
  return groupName
    .replace(/\s*(prior\w*\s+support|general)\s*/i, "")
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Fetched live from Lark's own Inquiry field (see fetchInquiryOptions) so a
// tag added/renamed/removed there shows up here without a redeploy. This
// array is only the fallback shown until that first fetch resolves (and if
// it ever fails outright, e.g. preview mode with no Lark configured) --
// kept as a snapshot of the real list so the app never opens on an empty
// Inquiry dropdown.
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
];
async function fetchInquiryOptions({ fresh = false } = {}) {
  try {
    const res = await fetch("/lark-inquiry-list", fresh ? { cache: "no-store" } : undefined);
    const data = await res.json();
    if (data.ok && data.options && data.options.length) inquiryOptions = data.options;
  } catch (_) { /* non-fatal — keeps whatever list it already had */ }
}

// Maps each bonus program to the closest Inquiry option — auto-selected
// the moment CS clicks Claim so they don't have to pick it manually.
const BONUS_INQUIRY_MAP = {
  riskPlayer: "Bonus Checking", // fallback only — see resolveInquiryForProgram
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

// Risk Player is a single Lark field, but its value encodes which day-tier
// bonus actually applies for this customer (e.g. "7D 20%", "14D 30%" —
// "1D No Bonus"/"3D No Bonus" never reach here at all, filtered out earlier
// by isClaimableValue/NO_BONUS_PATTERN). The Inquiry tag should reflect that
// specific tier ("7D", "14D", ...), not a generic "Bonus Checking" catch-all
// — those day-tier tags already exist in inquiryOptions. Falls back to the
// static map above if the value doesn't start with a recognized day-tier,
// so this never silently produces no inquiry at all.
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

// Fetched live from Lark's own Status field, same as inquiryOptions above —
// this fallback is only shown until that first fetch resolves.
let statusOptions = ["Solved", "Unsolved", "Given", "Not given", "Activated"];
async function fetchStatusOptions({ fresh = false } = {}) {
  try {
    const res = await fetch("/lark-status-list", fresh ? { cache: "no-store" } : undefined);
    const data = await res.json();
    if (data.ok && data.options && data.options.length) statusOptions = data.options;
  } catch (_) { /* non-fatal — keeps whatever list it already had */ }
}

/* ============================================================
   RENDER
   ============================================================ */
const chatListEl = document.getElementById("chatList");
document.getElementById("mainTabs")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-main-tab]");
  if (!button || button.hidden) return;
  activeMainTab = button.dataset.mainTab;
  syncMainTabs();
  try { sessionStorage.setItem(MAIN_TAB_SESSION_KEY, activeMainTab); } catch (_) {}
  if (activeMainTab !== "knowledge" && activeMainTab !== "blast") renderChats(activeChats);
});
const statusEl = document.getElementById("statusBar");
const state = {}; // chatId -> { username, bonus, claimed, brand, inquiry, telegram, logged }
const lookupControllers = new Map(); // per-chat request cancellation, kept out of persisted state
let hasAutoExpandedOnce = false; // see renderChats — only auto-expand a card on first load

// The same app origin is installed in both LiveChat accounts. Incognito
// localStorage is shared across those tabs, while sessionStorage is scoped
// to one top-level tab, so keep the current tab's anonymous account label in
// sessionStorage and stamp it onto every pending chat. No PAT is exposed.
const LIVECHAT_ACCOUNT_SESSION_KEY = "rc-livechat-account";
let currentLiveChatAccount = "";
try {
  const savedAccount = CONFIGURED_LIVECHAT_ACCOUNT || sessionStorage.getItem(LIVECHAT_ACCOUNT_SESSION_KEY) || "";
  if (/^lc[12]$/.test(savedAccount)) currentLiveChatAccount = savedAccount;
} catch (_) { /* storage can be unavailable in hardened browser modes */ }

function setCurrentLiveChatAccount(accountKey, chatId) {
  if (!/^lc[12]$/.test(String(accountKey || ""))) return;
  const changed = currentLiveChatAccount !== accountKey;
  currentLiveChatAccount = accountKey;
  try { sessionStorage.setItem(LIVECHAT_ACCOUNT_SESSION_KEY, accountKey); } catch (_) { /* non-fatal */ }
  const targetId = chatId || activeChats[0]?.chatId;
  if (targetId && state[targetId]) state[targetId].liveChatAccount = accountKey;
  if (changed) {
    staleRecords = [];
    renderNeedsAttentionPanel();
    scheduleNeedsAttentionRefresh(0);
    logDiagnostic(`This tab is connected to LiveChat ${accountKey === "lc1" ? "account 1" : "account 2"}.`, "success");
  }
}

// Persists `state` into localStorage so a lookup survives LiveChat's own
// in-app navigation and a plain page refresh — both just reload this
// widget's iframe, which otherwise wipes every in-memory chat state and
// forces a re-lookup. Scoped to this browser only, never sent anywhere.
// Each chat's saved copy carries its own _savedAt so stale entries (chats
// nobody's touched in a week) get pruned on load instead of accumulating
// in localStorage forever.
const STATE_STORAGE_KEY = "rc-chat-state";
const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Several copies of this widget can be alive at once against the same
// localStorage (the LiveChat window's own widget, plus the extra tab a
// Needs Attention "Open" link launches, the other LiveChat account, ...).
// This used to rebuild the WHOLE blob from this tab's memory every 3s, so a
// tab that hadn't touched a chat still overwrote the newer copy another tab
// had just saved -- e.g. a chat recorded in the "Open" tab flipped back to
// "not logged, needs attention" a few seconds later, and the copies also
// dropped each other's chats. Now each tab only writes chats IT changed
// since it last synced, keeps everything else already in storage, and adopts
// the newer stored copy of any chat it hasn't touched.
const lastSyncedJson = new Map(); // chatId -> JSON of that chat as of this tab's last load/save/adopt
// "A request is running right now" flags. They describe this tab's live network calls (and the AbortController
// that can cancel one is never persisted), so saving them leaves a reloaded widget with a Cancel button that has
// nothing to abort -- and a stuck lookup/unclaim that also blocks the ⟳ update. Never saved, never adopted.
function stateSnapshot(s) {
  const { _savedAt, lookupInFlight, unclaimInFlight, ...rest } = s || {};
  return JSON.stringify(rest);
}
function persistableState(s, savedAt) {
  const { lookupInFlight, unclaimInFlight, ...rest } = s;
  return { ...rest, _savedAt: savedAt };
}
// Last non-empty Brand seen for each chat in THIS tab. If merging with / adopting
// another tab's older saved copy would blank it, put it back.
const knownBrandFor = new Map();
function keepBrand(chatId, s) {
  if (s && !s.brand && knownBrandFor.get(chatId)) { s.brand = knownBrandFor.get(chatId); return true; }
  return false;
}
function markStateSynced(chatId) {
  lastSyncedJson.set(chatId, stateSnapshot(state[chatId]));
}

// saveState() runs every 10 s and from ~23 call sites. It used to JSON.parse ALL of localStorage and stringify
// every chat (twice) on each call even when nothing had changed. Now: if no chat in THIS tab changed since it
// last synced and no other tab has written (the 'storage' event sets storageDirty), it returns without
// touching localStorage. A full sync still runs at least once a minute as a safety net. The per-field merge /
// adopt logic below is unchanged.
let storageDirty = true;          // true until the first full sync; set again by the 'storage' event
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
        // BOTH this tab and another one changed this chat since this tab
        // last synced. Writing either whole copy loses the other's edits --
        // confirmed live: another tab's background sweep (checkChatStatus
        // setting chatUrl/telegram on its older copy) wrote back a copy
        // from before Brand was auto-detected, wiping Brand here ("Brand
        // hasn't been auto-detected yet" on Look up right after "Auto-
        // detected brand HOT"). Merge per field instead: whatever THIS tab
        // changed wins, everything else comes from the stored copy.
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
        continue;
      }
      if (synced !== undefined && cur === synced) {
        // Nothing changed in THIS tab -- another tab may have updated it.
        if (stored) {
          const { _savedAt, ...rest } = stored;
          if (storedJson !== cur) {
            // Mutate in place so existing references to state[chatId] stay valid.
            const { lookupInFlight, unclaimInFlight } = s;
            for (const k of Object.keys(s)) delete s[k];
            const storedSnapshot = stateSnapshot(rest);
            Object.assign(s, rest);
            if (lookupInFlight) s.lookupInFlight = true; // a request running in THIS tab is not in the stored copy
            if (unclaimInFlight) s.unclaimInFlight = true;
            const restoredBrand = keepBrand(chatId, s);
            // If Brand had to be restored, leave this tab "changed" so the next save writes it back.
            lastSyncedJson.set(chatId, restoredBrand ? storedSnapshot : stateSnapshot(s));
            adopted = true;
          }
        }
        continue;
      }
      raw[chatId] = persistableState(s, now);
      lastSyncedJson.set(chatId, cur);
      dirty = true;
    }
    if (dirty) {
      // Keep other tabs' chats, but still prune anything nobody has touched in a week.
      for (const [chatId, entry] of Object.entries(raw)) {
        if (!entry || now - (entry._savedAt || 0) >= STATE_MAX_AGE_MS) delete raw[chatId];
      }
      localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(raw));
    }
    if (adopted && typeof renderNeedsAttentionPanel === "function") renderNeedsAttentionPanel();
  } catch (_) { /* non-fatal — e.g. private browsing blocking storage */ }
}

function loadPersistedState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_STORAGE_KEY) || "{}");
    const now = Date.now();
    const fresh = {};
    for (const [chatId, s] of Object.entries(raw)) {
      if (s && now - (s._savedAt || 0) < STATE_MAX_AGE_MS) {
        delete s._savedAt;
        // Saved by an older version, or by a tab whose request died with it: nothing is running now.
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

// Status now mirrors Inquiry's own box exactly (merged chip + search
// input, not a separate display-button-plus-panel) — same
// renderXChips/renderXDropdown split, same .inquiry-chip/-option styling,
// just single-select (one chip max, picking a new one replaces it instead
// of adding a second).
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

// Updates the chip slot AND the search box's own placeholder together —
// same reasoning as Inquiry's refreshInquiryChips.
function refreshStatusChip(card, chatId) {
  card.querySelector(".status-chip-slot").innerHTML = renderStatusChip(chatId);
  const searchInput = card.querySelector(".status-search");
  if (searchInput) searchInput.placeholder = state[chatId].status ? "" : "Select status…";
}

// Brand, same custom-dropdown treatment as Status — a native <select>'s
// own dropdown chrome (including its scrollbar) can't be restyled via CSS
// in any browser, so this is the only way to actually theme it.
function renderBrandDisplay(chatId) {
  const s = state[chatId];
  const empty = !s.brand;
  return `<span class="status-value ${empty ? "placeholder" : ""}">${s.brand || "Select brand…"}</span><span class="status-caret">▾</span>`;
}

function renderBrandOptions(chatId, query) {
  const s = state[chatId];
  // Only ever offers real brandOptions — never an ad-hoc extra value, auto-
  // detected or otherwise. Lark's Brand field is a Single Select; writing
  // anything that isn't an existing option there silently creates a new
  // one instead of erroring, so this list (and resolveBrandFromGroupId,
  // which is now the only other place Brand ever gets set) must stay
  // restricted to what's already real.
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

// See renderStatusDropdown's header note — same panel/options split, same
// reason (search box inside the dropdown panel, filtered list re-rendered
// separately so typing never re-focuses the search input itself).
function renderBrandDropdown(chatId) {
  return `
    <input type="text" class="brand-search" placeholder="Search brand…" autocomplete="off" />
    <div class="brand-options">${renderBrandOptions(chatId, "")}</div>
  `;
}

// D.O.B. — a fully custom calendar, not <input type="date">. The native
// picker's popup calendar grid is OS/browser chrome with no CSS styling
// hook in any browser (unlike the icon, which is at least reachable) —
// this is the only way to actually theme it. dob is stored/read exactly
// like before ("YYYY-MM-DD", parsed by lark-record.js's toEpochMs).
const DOB_MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOB_WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const pad2 = (n) => String(n).padStart(2, "0");
const dobKey = (y, m, day) => `${y}-${pad2(m + 1)}-${pad2(day)}`;
// Descending, current year first -- a customer's DOB is virtually always
// somewhere in the last century, and jumping straight to a year (this
// dropdown) beats clicking a Previous Year arrow dozens of times to get
// there. currentYear is always included even if the picker's already
// looking further out, so the dropdown never has to omit the selected year.
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

// Builds exactly 6 rows (42 cells) so the grid is always the same height —
// leading/trailing cells spill into the adjacent month, shown dimmed but
// still clickable (a common calendar-UX convenience, not just filler).
function buildDobCalendarDays(year, month) {
  const firstWeekday = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7; // 0=Mon..6=Sun
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

// Custom dropdowns (not native <select>s) for the same reason Brand is one
// — see renderBrandDropdown's header note; a native <select>'s open list is
// OS/browser chrome with no CSS styling hook in any browser, so it can't be
// dark-themed and stands out badly against the rest of this app.
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

// See renderStatusDropdown's header note — same panel/options split, same
// reason. Both month and year get a search box for consistency with every
// other dropdown in this widget, even though month's own list (12 items)
// barely needs one — year's (up to 101) genuinely does.
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

// s.dobView (the month/year currently displayed — separate from s.dob, the
// actually-selected date) is lazily initialized here: starts on the
// selected date's month if one's set, otherwise today's.
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

// PIC dropped entirely — it's always the Retention Logger bot (every row is
// created by the app, never a human agent), so it carried no information.
// Name customer dropped too — no longer fetched (P&L is only queried for
// Tier now). D.O.B moved into the auto-grid next to Brand (see
// renderAutoFields). "Last username recorded" shows as soon as
// checkLastUsername resolves — before any Look Up, unlike Tier, which
// still only shows once matched.
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
    } catch (_) { /* embedded browsers may deny Clipboard API access */ }
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

// ---------------------------------------------------------------------
// Multiple cases per chat
// One chat can hold several separate Customer Approaching rows -- e.g. the
// customer asks about a free spin, then later about a deposit -- each with
// its own Inquiry / Status / Amount / Claim Secret. Username, brand, D.O.B,
// Telegram and the chat link carry over. The fields on state[chatId] always
// describe the ONE open case; every other case is parked in s.logs[] as a
// snapshot, and every parked case is already recorded in Lark. "Edit" swaps
// a parked case back in (parking the current one), so all the existing
// claim / unclaim / record code keeps working on "the open case" untouched.
// ---------------------------------------------------------------------
const CASE_CONTENT_KEYS = [
  "inquiry", "status", "releasedBonusAmount", "releasedAmountRaw", "claimSecret",
  "dob", "telegram", "claimedPrograms", "gracePeriodActivated",
  "vs96FeedbackQuery1", "vs96FeedbackQuery2", "riskReloadAmount",
];
const CASE_KEYS = [
  ...CASE_CONTENT_KEYS,
  "caseNo", "caRecordId", "matchedRow", "otherBrandMatches", "claimSecretManual",
  "logged", "autoRecordError", "loggedSnapshot", "caLinkSaved", "caOwner",
];

// Which agent's Lark row the open case is. After a chat transfer (PC crash
// / lost connection) each agent keeps their OWN row -- this browser never
// deletes, re-uses or records into a row that belongs to someone else (the
// server refuses too, see functions/_lib/ca-row.js ownedBy).
function ownsCaseRecord(s) {
  return !s.caOwner || s.caOwner === selectedAgent;
}

// Did THIS agent actually work the chat? A username auto-filled from an earlier recording of the same customer,
// or a chat that was only watched (supervising), has none of these: no Look up, no typed username, no inquiry or
// status, no earlier case. Such a chat is never auto-recorded, never stamped with the agent's name and never put
// on their Needs Attention list. The manual Record button still works on it.
function agentActed(s) {
  if (!s) return false;
  return !!(s.caRecordId || (s.inquiry && s.inquiry.length) || s.status || String(s.usernameDraft || "").trim()
    || (s.logs && s.logs.length) || Object.values(s.claimedPrograms || {}).some(Boolean));
}
// With the LiveChat login on, writing to the customer also makes a chat theirs (see agentWroteInChat): true = they wrote,
// "unsure" = LiveChat could not be asked, so they are reminded rather than a case being lost.
function agentTouchedChat(s) {
  return agentActed(s) || (!!s && (s.agentWrote === true || s.agentWrote === "unsure"));
}
const addingCaseFor = new Set(); // chatIds with an add/edit in flight (not persisted, so it can never get stuck)

// What actually gets written to Lark for a case -- used to tell whether a
// logged case has been changed since it was last saved.
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
  // Older persisted cases predate the VS96 fields. Clear them before loading
  // so switching cases can never carry another player's answers across.
  s.vs96FeedbackQuery1 = "";
  s.vs96FeedbackQuery2 = "";
  s.riskReloadAmount = "";
  for (const k of CASE_KEYS) if (snap[k] !== undefined) s[k] = JSON.parse(JSON.stringify(snap[k]));
}
function usedProgramsInOtherCases(s) {
  const used = new Set();
  for (const c of (s.logs || [])) {
    for (const [k, v] of Object.entries(c.claimedPrograms || {})) if (v) used.add(k);
    // Reconstruct claims from centrally saved Lark fields too. This covers
    // another browser/PC and older localStorage snapshots that do not carry
    // claimedPrograms, preventing a restored chat from showing a bonus that
    // the same case already recorded as Given.
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

// Makes sure the open case is saved in Lark before anything moves on from
// it. Resolves true only if it is.
async function ensureActiveCaseSaved(chatId) {
  const s = state[chatId];
  if (s.logged && !isCaseDirty(s)) return true;
  if (s.logged) return resyncLoggedRecord(chatId);
  await submitRecord(chatId, { auto: false }); // shows its own "missing …" / error message
  return !!s.logged;
}

// Start another case: record the open one, THEN run a fresh lookup (so any
// bonus the first case just claimed is already accounted for), park the
// finished case and open a clean one.
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
    s.gracePeriodActivated = false;
    s.vs96FeedbackQuery1 = "";
    s.vs96FeedbackQuery2 = "";
    s.riskReloadAmount = "";
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

// Swap a parked case back in for editing. The open case is parked first
// (saved to Lark), or -- if it was never touched -- its blank Lark row is
// removed instead of leaving an empty case behind.
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
        }).catch(() => { /* non-fatal — worst case a blank row stays in Lark */ });
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

  // Build one unified list of ticket definitions across all 3 sources —
  // the "only 1 claimable per case" lock applies across all of them together.
  const defs = [];
  // A bonus claimed in an earlier case of this chat stays gone even if Lark
  // hasn't caught up yet (its source row can lag behind).
  const usedElsewhere = usedProgramsInOtherCases(s);

  allBonusPrograms().forEach((p) => {
    if (usedElsewhere.has(p.key)) return;
    if (!isClaimableValue(r[p.key])) return;
    const def = { key: p.key, kind: "regular", label: p.label, display: r[p.key] };
    if (p.key === "vs96Feedback") def.requiresFeedback = true;
    // Grace Period's one field packs two different states: "Pass ..." means
    // the offer just needs activating (no money changes hands yet — button
    // says Activate, doesn't consume the one-claim-per-case slot); "Activated
    // : ... - Bonus N" means it's now a real, claimable bonus (normal Claim
    // button/lock behavior). See the claim handler for what each does.
    if (p.key === "gracePeriod") {
      const isPass = /^\s*pass\b/i.test(r.gracePeriod);
      def.claimLabel = isPass ? "Activate" : "Claim";
      def.doneLabel = isPass ? "✓ Activated" : "✓ Claimed";
      def.done = isPass ? !!s.gracePeriodActivated : !!s.claimedPrograms.gracePeriod;
      def.excludeFromLock = isPass;
      // A customer can fail to complete the challenge at either stage —
      // before activating, or after activating but before claiming — so
      // Reactivate sits alongside Activate/Claim always, not just once
      // one of those is already done (whose own button disables itself
      // the moment it's clicked, matching every other ticket's claimed/
      // locked look, so it can't just be re-clicked directly). Only while
      // the challenge's own "Expried" date hasn't fully passed yet, though
      // — once that date is before today, there's no window left to give
      // the customer another attempt in, so only Activate/Claim shows.
      // Compared as a whole calendar day (from local midnight), not exact
      // time, since the expiry itself is always stored as that day's
      // 23:59 — e.g. expiring 2026-09-10 no longer reactivates once it's
      // the 11th, but still does for the rest of the 10th itself.
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      def.reactivatable = typeof r.graceExpiryMs === "number" && r.graceExpiryMs >= startOfToday.getTime();
    }
    // Risk Player: surfaces its own "Date Expired" column as a line under
    // the ticket (see renderExpiryLine) -- previously fetched from Lark
    // (lark-search.js) but never actually shown anywhere in the app.
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

  // Distinct from the standalone "Telegram RM28" ticket above — this is the
  // Special Reload Event table's Ang Pao variant (its Free Spin variant is
  // retired). Already pre-filtered server-side to only "Eligible Angpao".
  if (r.specialReload && !usedElsewhere.has("specialReload")) {
    defs.push({ key: "specialReload", kind: "special", label: "Special Reload (Ang Pao)", display: r.specialReload.status });
  }

  if (!defs.length) {
    return `<div class="ticket empty">No active bonuses for this player right now</div>`;
  }

  // Only one bonus can be claimed per case — once any is claimed, the rest
  // lock. Grace Period's "Activate" state (def.excludeFromLock) is exempt in
  // both directions: it doesn't get locked out by another claim, and (since
  // it never sets s.claimedPrograms.gracePeriod) it never locks other
  // tickets either — it isn't a monetary claim.
  const alreadyClaimedOne = Object.values(s.claimedPrograms).some(Boolean);
  return `<div class="ticket-stack">` + defs.map((d) => {
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
  }).join("") + `</div>` + (alreadyClaimedOne ? `<div class="ticket-note">Only 1 bonus can be claimed per case</div>` : "");
}

// Grace Period's SW Check text carries the challenge date(s) inline -- wraps
// each date-looking piece so it stands out on the ticket. Covers numeric
// (09/09/2026, 2026-09-09, 9-9-26, 09.09) and written-month (9 Sep 2026,
// Sep 9) forms; anything else is left as plain text.
const DATE_PATTERN = new RegExp([
  String.raw`\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b`,
  String.raw`\b\d{1,2}[-/.]\d{1,2}(?:[-/.]\d{2,4})?\b`,
  String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?(?:,?\s+\d{2,4})?\b`,
  String.raw`\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{2,4})?\b`,
].join("|"), "gi");

// "RM28", "RM 28", "Bonus 28" -- the actual claimable amount buried in a raw
// Lark display string ("Pass RM28", "7D 20% Reload - Bonus 18", ...).
// Highlighted the same way across every ticket now, not just one table, so
// the number an agent actually cares about jumps out regardless of which
// source table's own wording it came from.
const AMOUNT_PATTERN = /\bRM\s?-?\d+(?:\.\d+)?\b|\bBonus\s+-?\d+(?:\.\d+)?\b/gi;
const PASS_VALUE_PATTERN = /\bPass\b(?:\s+\d+(?:\.\d+)?)?/gi;
const ELIGIBLE_PATTERN = /\bEligible\b/gi;

function highlightDates(text) {
  return escapeHtml(text).replace(DATE_PATTERN, (m) => `<span class="ticket-date">${m}</span>`);
}

// Every ticket's meta line goes through this now (previously only Grace
// Period's did) -- wraps dates AND RM/Bonus amounts so every bonus reads
// the same way at a glance: 📅 for a date, 🎁 for the actual amount. Escapes
// first (same order highlightDates already used), so this is safe to run
// on any raw table text without either pattern ever matching inside an
// HTML-escaped entity.
function formatTicketMeta(text) {
  let html = escapeHtml(text);
  html = html.replace(ELIGIBLE_PATTERN, (m) => `<span class="eligible-value">${m}</span>`);
  html = html.replace(PASS_VALUE_PATTERN, (m) => `<span class="pass-value">${m}</span>`);
  html = html.replace(DATE_PATTERN, (m) => `📅 <span class="ticket-date">${m}</span>`);
  html = html.replace(AMOUNT_PATTERN, (m) => `🎁 <span class="amount">${m}</span>`);
  return html;
}

// Risk Player's own "Date Expired" column, shown as its own line under the
// ticket so CS can see at a glance how much time is left -- previously not
// shown in the app at all. Color escalates the closer/past the deadline is:
// grey with plenty of time left, amber inside the last 24h, red once it's
// actually already past (the row can still be showing here briefly if the
// underlying Status text hasn't flipped to "Expired" yet on Lark's side).
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

// Inquiry is a searchable dropdown + chip list instead of a big always-open
// tag grid — same 70+ option list, same max-2 / Feedback-pairing rule, just
// collapsed behind a search box so the card stays short until it's used.
function renderInquiryChips(chatId) {
  const s = state[chatId];
  // No placeholder when empty — the "Search inquiry…" placeholder already
  // sitting in the search box says the same thing without needing its own
  // separate label crowding the box.
  if (!s.inquiry.length) return "";
  return s.inquiry.map((v) => `
    <span class="inquiry-chip">${v}<button type="button" class="inquiry-chip-remove" data-action="removeInquiry" data-chat="${chatId}" data-value="${v}" aria-label="Remove ${v}">✕</button></span>
  `).join("");
}

// Updates the chip row AND the search box's own placeholder together — the
// input's "Search inquiry…" text is dropped once there's already a chip
// (the chip itself makes the box's purpose obvious; the placeholder just
// crowds a one-line box next to it), same reasoning as dropping the old
// "No inquiry selected" label entirely.
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

// Brand is auto-detected (resolveBrandFromGroupId, via LiveChat's Groups
// API) but editable now — detection can fail (PAT not configured, API
// error, unrecognized group) or just be wrong, and submitRecord still
// requires a Brand to submit at all, so CS needs a way to fix/set it by
// hand rather than being stuck. A real dropdown (options from
// lark-brand-list.js — the Brand field's own Single Select choices on
// Customer Approaching) rather than free text, so a manual override can
// only ever be a real Brand value, never a typo that wouldn't match any
// per-table Brand column. Custom dropdown (not a native <select>) so it
// can actually be themed — see renderBrandDisplay/renderBrandDropdown and
// the toggleBrandDropdown/selectBrand action handlers.
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
  return `
    <div class="chat-card-head ticket-workspace-head">
      <div><span class="chat-name">Tickets</span><div class="hint">Admin preview · ${escapeHtml(chat.customerName)}</div></div>
      <div class="ticket-head-actions">
        <button type="button" class="ticket-notification-button" data-action="clearTicketNotifications" data-chat="${escapeHtml(chat.chatId)}" title="Clear ticket notifications">🔔 <span>${ticketNotifications.length}</span></button>
        <span class="preview-mode-badge ticket-live-badge">CREATES REAL TICKETS</span>
      </div>
    </div>
    <div class="ticket-admin-warning">This admin preview is connected to the live ticket API. Raising a ticket here creates a real ticket.</div>
    ${renderTicketNotifications()}
    <div class="escalation-slot">${renderEscalationSection(chat.chatId)}</div>
  `;
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

// GET /tickets describes SELECT fields but intentionally omits their choices.
// These documented values make those fields selectable while the datalist still
// accepts additional live values that the ticket team may add later.
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

// File objects cannot be serialized into localStorage. Keep them only in
// memory for the current admin-preview tab; incognito clears them with the
// session and a completed ticket clears them immediately.
const ticketAttachmentsByChat = new Map();
// Not persisted (module level): a ticket create / claim write that is running right now. Used by canRefreshForDeployment().
const ticketCreateInFlight = new Set();
const claimWriteInFlight = new Set();
const ticketSearchResultsByChat = new Map();
const watchedTicketSnapshots = new Map();
let ticketNotifications = [];
const TICKET_ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);
const TICKET_ATTACHMENT_MAX_BYTES = 1024 * 1024;

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
      <div class="ticket-attachment-help">PNG, JPG, WEBP or PDF · under 1MB each · up to 6 files · click here and press Ctrl+V to paste</div>
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
    const invalid = added.find((file) => !file.size || file.size >= TICKET_ATTACHMENT_MAX_BYTES || !TICKET_ATTACHMENT_TYPES.has(file.type));
    if (invalid) {
      error = !invalid.size
        ? `${invalid.name || "Attachment"} is empty.`
        : invalid.size >= TICKET_ATTACHMENT_MAX_BYTES
          ? `${invalid.name || "Attachment"} must be under 1MB.`
          : `${invalid.name || "Attachment"} must be PNG, JPG, WEBP, or PDF.`;
    }
  }
  if (!error) ticketAttachmentsByChat.set(chatId, combined);
  s.ticketAttachmentError = error;
  return !error;
}

function ticketStatusValue(ticket) {
  return String(ticket?.fields?.status || "");
}

function renderTicketNotifications() {
  if (!ticketNotifications.length) return "";
  return `<div class="ticket-notification-panel">
    ${ticketNotifications.slice(0, 5).map((item) => `<div><strong>${escapeHtml(item.ref)}</strong><span>${escapeHtml(item.message)}</span><small>${escapeHtml(new Date(item.time).toLocaleTimeString())}</small></div>`).join("")}
  </div>`;
}

function rememberTicketSnapshot(ticket, notify = true) {
  if (!ticket?.ref) return;
  const next = {
    updatedAt: ticket.updatedAt || "",
    status: ticketStatusValue(ticket),
    commentCount: Number(ticket.commentCount || 0),
    attachmentCount: Number(ticket.attachmentCount || 0),
  };
  const previous = watchedTicketSnapshots.get(ticket.ref);
  watchedTicketSnapshots.set(ticket.ref, next);
  if (!notify || !previous || JSON.stringify(previous) === JSON.stringify(next)) return;
  const changes = [];
  if (previous.status !== next.status) changes.push(`status changed to ${next.status || "blank"}`);
  if (next.commentCount > previous.commentCount) changes.push(`${next.commentCount - previous.commentCount} new comment${next.commentCount - previous.commentCount === 1 ? "" : "s"}`);
  if (next.attachmentCount > previous.attachmentCount) changes.push(`${next.attachmentCount - previous.attachmentCount} new file${next.attachmentCount - previous.attachmentCount === 1 ? "" : "s"}`);
  if (!changes.length) changes.push("ticket details were updated");
  ticketNotifications.unshift({ ref: ticket.ref, message: changes.join(" · "), time: Date.now() });
  ticketNotifications = ticketNotifications.slice(0, 20);
  setStatus(`${ticket.ref}: ${changes.join(" · ")}`, "success");
}

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
  return claimed;
}

function ticketChoiceSlug(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function ticketChoiceDisplayLabel(fieldKey, rawValue, rawLabel = rawValue) {
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
    <button type="button" class="input ticket-choice-trigger" data-action="toggleTicketChoice" data-chat="${escapeHtml(chatId)}" aria-haspopup="listbox" aria-expanded="false">
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
  const options = ticketFieldOptions(field);
  let control;

  if (options.length) {
    control = renderTicketChoice(chatId, spec.stateKey, value, options, {
      placeholder: required && !field.defaultValue ? "Please select" : "Use ticket default",
      allowEmpty: !required || Boolean(field.defaultValue),
    });
  } else if (field.type === "LONGTEXT" || spec.stateKey === "remarks") {
    control = `<textarea class="input esc-input" data-chat="${escapeHtml(chatId)}" data-field="${spec.stateKey}" placeholder="Type here" rows="2">${escapeHtml(value)}</textarea>`;
  } else {
    const numeric = field.type === "NUMBER" || field.type === "CURRENCY";
    // Use a text input with a decimal keyboard hint instead of type=number.
    // This keeps the field numeric while removing browser spinner buttons and
    // accidental mouse-wheel / ArrowUp / ArrowDown value changes.
    control = `<input type="text"${numeric ? ' inputmode="decimal" data-ticket-numeric="true"' : ""} class="input mono esc-input" data-chat="${escapeHtml(chatId)}" data-field="${spec.stateKey}" value="${escapeHtml(value)}" placeholder="Type here" />`;
  }

  return `<div class="escalation-field ${spec.stateKey === "remarks" ? "escalation-field-wide" : ""}">
    <label class="field-label">${label}</label>${control}
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

function renderTicketSearchResults(chatId) {
  const result = ticketSearchResultsByChat.get(chatId);
  if (!result) return "";
  if (result.mode === "all") return "";
  if (result.loading) return `<div class="ticket-results-empty">Loading tickets…</div>`;
  if (result.error) return `<div class="record-error-banner">⚠︎ ${escapeHtml(result.error)}</div>`;
  if (!result.tickets?.length) return `<div class="ticket-results-empty">No tickets found.</div>`;
  return `<div class="ticket-results">
    ${result.tickets.slice(0, 30).map((ticket) => {
      const status = ticket.fields?.status || "No status";
      const member = ticket.fields?.member_id || "No member ID";
      const department = ticket.currentDepartment?.name || ticket.currentDepartment?.code || "No department";
      return `<button type="button" class="ticket-result" data-action="openTicketResult" data-chat="${escapeHtml(chatId)}" data-ref="${escapeHtml(ticket.ref)}">
        <span><strong>${escapeHtml(ticket.ref)}</strong><small>${escapeHtml(member)} · ${escapeHtml(department)}</small></span>
        <span class="ticket-status-pill">${escapeHtml(status)}</span>
      </button>`;
    }).join("")}
    ${result.total > result.tickets.length ? `<div class="ticket-results-empty">Showing ${result.tickets.length} of ${result.total} tickets. Refine the search to narrow it down.</div>` : ""}
  </div>`;
}

function ticketPeople(ticket) {
  return [ticket.raisedBy, ...(Array.isArray(ticket.assignees) ? ticket.assignees : [])]
    .map((person) => person?.name || person?.email).filter(Boolean);
}

function renderTicketExplorer(chatId) {
  const s = state[chatId];
  const result = ticketSearchResultsByChat.get(chatId);
  const tickets = result?.mode === "all" ? (result.tickets || []) : [];
  const unique = (values) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const agents = unique(tickets.flatMap(ticketPeople));
  const statuses = unique(tickets.map((ticket) => ticket.fields?.status));
  const departments = unique(tickets.map((ticket) => ticket.currentDepartment?.name || ticket.currentDepartment?.code));
  const markets = unique(tickets.map((ticket) => ticket.market?.label || ticket.market?.code));
  const matches = (value, filter) => !filter || filter === "all" || String(value || "") === filter;
  const filtered = tickets.filter((ticket) =>
    (!s.ticketExplorerAgent || s.ticketExplorerAgent === "all" || ticketPeople(ticket).includes(s.ticketExplorerAgent))
    && matches(ticket.fields?.status, s.ticketExplorerStatus)
    && matches(ticket.currentDepartment?.name || ticket.currentDepartment?.code, s.ticketExplorerDepartment)
    && matches(ticket.market?.label || ticket.market?.code, s.ticketExplorerMarket));
  const options = (values, selected) => values.map((value) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`).join("");
  return `<section class="ticket-explorer">
    <div class="ticket-explorer-head">
      <div><span class="ticket-explorer-kicker">Ticket explorer</span><strong>Team tickets</strong><small>Pull recent tickets and narrow them by agent or ticket details.</small></div>
      <button type="button" class="secondary-btn" data-action="loadAllTickets" data-chat="${escapeHtml(chatId)}">${result?.mode === "all" ? "Refresh" : "Load tickets"}</button>
    </div>
    ${result?.mode === "all" ? `<div class="ticket-explorer-filters">
      <label><span>Agent</span><select class="input ticket-explorer-filter" data-chat="${escapeHtml(chatId)}" data-filter="ticketExplorerAgent"><option value="all">All agents</option>${options(agents, s.ticketExplorerAgent)}</select></label>
      <label><span>Status</span><select class="input ticket-explorer-filter" data-chat="${escapeHtml(chatId)}" data-filter="ticketExplorerStatus"><option value="all">All statuses</option>${options(statuses, s.ticketExplorerStatus)}</select></label>
      <label><span>Department</span><select class="input ticket-explorer-filter" data-chat="${escapeHtml(chatId)}" data-filter="ticketExplorerDepartment"><option value="all">All departments</option>${options(departments, s.ticketExplorerDepartment)}</select></label>
      <label><span>Market</span><select class="input ticket-explorer-filter" data-chat="${escapeHtml(chatId)}" data-filter="ticketExplorerMarket"><option value="all">All markets</option>${options(markets, s.ticketExplorerMarket)}</select></label>
    </div>
    <div class="ticket-explorer-summary"><span>${filtered.length} of ${tickets.length} tickets</span><span>Latest updated first</span></div>
    <div class="ticket-explorer-list">${filtered.length ? filtered.map((ticket) => `<button type="button" class="ticket-explorer-row" data-action="openTicketResult" data-chat="${escapeHtml(chatId)}" data-ref="${escapeHtml(ticket.ref)}">
      <span><strong>${escapeHtml(ticket.ref)}</strong><small>${escapeHtml(ticketPeople(ticket).join(", ") || "Unassigned")}</small></span>
      <span><b>${escapeHtml(ticket.fields?.status || "No status")}</b><small>${escapeHtml(ticket.currentDepartment?.name || ticket.currentDepartment?.code || "No department")}</small></span>
    </button>`).join("") : `<div class="ticket-results-empty">No tickets match these filters.</div>`}</div>`
    : `<div class="ticket-explorer-empty">Load up to 100 recently updated tickets. Filters will appear here.</div>`}
  </section>`;
}

function renderTicketStatus(chatId) {
  const s = state[chatId];
  const ticket = s.ticketRecord;
  if (!ticket) return "";
  const statusField = ticketFields.find((field) => field.key === "status")
    || ticketFields.find((field) => String(field.label).toLowerCase() === "status");
  const status = statusField ? ticket.fields?.[statusField.key] : ticket.fields?.status;
  const department = ticket.currentDepartment?.name || ticket.currentDepartment?.code || "—";
  const updated = ticket.updatedAt ? new Date(ticket.updatedAt).toLocaleString() : "—";
  const created = ticket.createdAt ? new Date(ticket.createdAt).toLocaleString() : "—";
  const raisedBy = ticket.raisedBy?.name || ticket.raisedBy?.email || "—";
  const market = ticket.market?.label || ticket.market?.code || "—";
  const assignees = Array.isArray(ticket.assignees) && ticket.assignees.length
    ? ticket.assignees.map((person) => person?.name || person?.email).filter(Boolean).join(", ")
    : "Unassigned";
  const attachments = Array.isArray(ticket.fields?.attachment) ? ticket.fields.attachment : [];
  const attachmentSummary = attachments.length
    ? `<div class="ticket-attachment-summary"><strong>Attachments:</strong> ${attachments.map((item) => escapeHtml(item?.name || "Attached file")).join(", ")}</div>`
    : "";
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  const commentThread = comments.length
    ? `<div class="ticket-comments">${comments.map((comment, index) => `<article class="ticket-comment">
        <span class="ticket-comment-avatar">${escapeHtml(String(comment.author || "?").trim().charAt(0).toUpperCase())}</span>
        <div><div class="ticket-comment-meta"><strong>${escapeHtml(comment.author || "Unknown")}</strong><span>${escapeHtml(comment.role || "")}</span><time>${escapeHtml(comment.time || "")}</time></div><p>${escapeHtml(comment.body || "")}</p></div>
      </article>`).join("")}</div>
      <div class="ticket-comment-composer">
        <textarea rows="2" placeholder="Write a reply…" aria-label="Future ticket reply preview"></textarea>
        <div><span>Future ticket comments preview</span><button type="button" disabled>Send reply</button></div>
      </div>`
    : `<p>The current ticket API returns the comment count but not the comment thread or history. Reading and posting replies here will switch on once the ticket API adds comment endpoints.</p>`;
  const fieldRows = Object.entries(ticket.fields || {})
    .filter(([key]) => key !== "attachment")
    .map(([key, value]) => `<div class="ticket-detail-row"><span>${escapeHtml(ticketFieldLabel(key))}</span><strong>${escapeHtml(ticketFieldDisplay(value))}</strong></div>`)
    .join("");
  return `<div class="ticket-status-card">
    <div class="ticket-status-heading"><div><span class="ticket-status-ref">${escapeHtml(ticket.ref)}</span><span class="ticket-status-pill">${escapeHtml(status || "No status")}</span></div><span class="hint">${Number(ticket.commentCount || 0)} comments · ${Number(ticket.attachmentCount || attachments.length)} files</span></div>
    <div class="ticket-status-meta">Department: ${escapeHtml(department)} · Market: ${escapeHtml(market)} · Updated: ${escapeHtml(updated)}</div>
    <div class="ticket-detail-grid">
      <div class="ticket-detail-row"><span>Created</span><strong>${escapeHtml(created)}</strong></div>
      <div class="ticket-detail-row"><span>Raised by</span><strong>${escapeHtml(raisedBy)}</strong></div>
      <div class="ticket-detail-row"><span>Assignees</span><strong>${escapeHtml(assignees)}</strong></div>
      ${fieldRows}
    </div>
    ${attachmentSummary}
    <div class="ticket-conversation-panel">
      <div class="ticket-conversation-head"><strong>Conversation</strong><span>${Number(ticket.commentCount || 0)} comments</span></div>
      ${commentThread}
    </div>
    <a class="ticket-open-link" href="https://tickets.96ghq.com/tickets?q=${encodeURIComponent(ticket.ref)}" target="_blank" rel="noopener">Open in ticket system ↗</a>
  </div>`;
}

async function loadTicketStatus(chatId, ref, { silent = false } = {}) {
  const s = state[chatId];
  const normalized = String(ref || "").trim().toUpperCase();
  if (!normalized) throw new Error("Enter a ticket reference");
  const res = await fetch(`/ticket-status?ref=${encodeURIComponent(normalized)}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Ticket status lookup failed");
  s.ticketLookupRef = normalized;
  s.ticketRecord = data.ticket;
  rememberTicketSnapshot(data.ticket, !silent);
  s.escalationError = "";
  saveState();
  return data.ticket;
}

async function searchTickets(chatId, query, mode = "search") {
  ticketSearchResultsByChat.set(chatId, { loading: true, tickets: [], mode });
  const res = await fetch(`/ticket-list?q=${encodeURIComponent(String(query || "").trim())}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Ticket search failed");
  ticketSearchResultsByChat.set(chatId, { loading: false, tickets: data.tickets || [], total: data.total || 0, mode });
  return data;
}

async function pollTicketUpdates() {
  if (activeMainTab !== "tickets" || !watchedTicketSnapshots.size) return;
  for (const ref of watchedTicketSnapshots.keys()) {
    const owner = Object.entries(state).find(([, value]) => value?.ticketRecord?.ref === ref);
    if (!owner) continue;
    try {
      const [chatId] = owner;
      await loadTicketStatus(chatId, ref);
      const slot = chatListEl.querySelector(`.chat-card[data-chat-id="${chatId}"] .escalation-slot`);
      if (slot) slot.innerHTML = renderEscalationSection(chatId);
    } catch (_) { /* a temporary poll failure should not interrupt the agent */ }
  }
}
setInterval(pollTicketUpdates, 30000);

// Creates tickets through the C9 Tickets REST API and reads their latest
// status. The API currently has no update route, so editing remains in the
// ticket system itself.
function renderEscalationSection(chatId) {
  const s = state[chatId];
  const departmentId = String(s.escalation.departmentId || "");
  const marketId = String(s.escalation.marketId || "");
  return `
    <div class="ticket-section-head">
      <label class="field-label">Ticket System</label>
      <span class="hint">Search, browse and create tickets</span>
    </div>
    <div class="ticket-search-row">
      <input type="search" class="input ticket-search-input" data-chat="${escapeHtml(chatId)}" value="${escapeHtml(s.ticketSearchQuery || "")}" placeholder="Ticket ref, member ID, agent, or ticket fields" />
      <button type="button" class="secondary-btn" data-action="searchTickets" data-chat="${escapeHtml(chatId)}">Search</button>
    </div>
    ${renderTicketSearchResults(chatId)}
    ${renderTicketStatus(chatId)}
    ${renderTicketExplorer(chatId)}
    ${ticketConfigError ? `<div class="record-error-banner">⚠︎ ${escapeHtml(ticketConfigError)}</div>` : ""}
    ${!ticketFields.length || s.escalationSubmitted ? "" : `
      <div class="ticket-form-title">Raise a new ticket</div>
      <div class="escalation-grid">
        <div class="escalation-field"><label class="field-label">Destination Department *</label>
          ${renderTicketChoice(chatId, "departmentId", departmentId, ticketDepartments.map((item) => ({ value: item.id, label: item.name || item.code || item.id })), { placeholder: "Please select", allowEmpty: false })}
        </div>
        <div class="escalation-field"><label class="field-label">Market</label>
          ${renderTicketChoice(chatId, "marketId", marketId, ticketMarkets.map((item) => ({ value: item.id, label: item.label || item.code || item.id })), { placeholder: "Use ticket default", allowEmpty: true })}
        </div>
      </div>
      <div class="escalation-grid">${TICKET_FIELD_SPECS.map((spec) => renderTicketInput(chatId, spec)).join("")}</div>
      ${renderTicketAttachments(chatId)}
      <div class="hint" style="margin:6px 0 10px">Attachments are uploaded with the new ticket. Existing tickets, comments and history cannot be changed through the current API.</div>
    `}
    ${s.escalationError ? `<div class="record-error-banner">⚠︎ ${escapeHtml(s.escalationError)}</div>` : ""}
    ${!ticketFields.length ? "" : s.escalationSubmitted
      ? `<button type="button" class="secondary-btn" data-action="newTicket" data-chat="${escapeHtml(chatId)}">Create another ticket</button>`
      : `<button class="submit-btn escalation-submit-btn" data-action="submitEscalation" data-chat="${escapeHtml(chatId)}">Raise ticket</button>`}
  `;
}

// Full default state shape for a chat we haven't seen before. Factored out
// so applyProfile() (live SDK mode) can ensure a new chat's state exists
// with every required field before forcing it expanded, rather than
// renderChats()'s own init pass silently skipping a partially-built object.
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
    // Extra cases logged in this same chat (see the "Multiple cases" block
    // above renderTickets). The fields above always describe the ONE case
    // currently open for editing; earlier cases are parked in logs[].
    logs: [], caseNo: 1, loggedSnapshot: "",
    // Set when a Look up came back "Not VVIP" and auto-marked the chat
    // Unknown -- turns the Look up button into "Force lookup". forcedVipFor
    // remembers a username CS force-looked-up so a repeat lookup of the same
    // player isn't auto-marked Unknown all over again.
    notVipResult: false, forcedVipFor: "",
    gracePeriodActivated: false,
    brand: deriveBrandFromGroup(chat.groupName),
    // C9MYR CS-PYM Escalation Ticket -- a separate Lark base/table entirely,
    // filled in and submitted independently of the Customer Approaching
    // record above. memberUserId auto-fills from s.username once looked up,
    // brand from deriveFullBrandCode (keeps the digits, e.g. "VS96" vs
    // "VS"), amount from whatever bonus gets claimed -- all editable, none
    // of them overwrite a value the agent already typed/picked.
    escalation: {
      memberUserId: "", brand: deriveFullBrandCode(chat.groupName), queries: "",
      status: "", transactionId: "", paymentGateway: "", remarks: "", vipLevel: "", amount: "",
      departmentId: "", marketId: "",
    },
    escalationSubmitted: false, escalationError: "", ticketAttachmentError: "",
    ticketRef: "", ticketLookupRef: "", ticketRecord: null, ticketSearchQuery: "",
    ticketExplorerAgent: "all", ticketExplorerStatus: "all", ticketExplorerDepartment: "all", ticketExplorerMarket: "all",
    // "Last username recorded" — see checkLastUsername. Runs once per chat,
    // as soon as both Brand and the resolved chat link are ready.
    // lastUsernameStarted guards against calling twice; lastUsernameLoading
    // is the visible "Checking…" state shown until it resolves.
    lastUsernameStarted: false, lastUsernameLoading: false,
    lastUsernameChecked: false, lastUsernameFound: false, lastUsernameValue: "",
    inquiry: [], status: "", telegram: chat.isTelegram, telegramManual: false, logged: false, dob: "", dobView: null,
    releasedBonusAmount: "", releasedAmountRaw: "", claimSecret: false,
    // Typed-but-not-yet-looked-up text in the username box, saved on every
    // keystroke (see the "input" listener below). Restores what CS was
    // typing if LiveChat swaps this widget to a different chat mid-typing
    // (a new incoming chat can steal focus at any moment) and they come
    // back to this one later — the box never silently reverts to blank,
    // and a stray click on a since-swapped-in card can't submit it either.
    usernameDraft: "",
    // Ticked when the customer never gave a username — unknown players
    // aren't counted toward chat data, so this skips recording entirely
    // (see submitRecord) rather than treating a blank username as an
    // incomplete record that needs chasing down.
    isUnknown: false,
    // Resolved by checkChatStatus, same value as activeChats[].link but
    // kept here too (not just on the transient activeChats entry) so it
    // survives once this chat isn't the focused one anymore — see
    // sweepPendingChats, which checks/auto-records chats other than
    // whichever one is currently on screen.
    chatUrl: "",
    // chatOpen mirrors the LiveChat conversation's open/closed state.
    // Recording only happens once a chat closes — checkChatStatus flips
    // this and calls submitRecord automatically once LiveChat reports the
    // chat inactive; there's no manual close button anymore.
    chatOpen: true, autoRecordError: "",
    // Guards the Look Up click handler against firing twice concurrently
    // for the same chat — btn.disabled alone isn't enough, since any
    // background re-render (checkChatStatus's Telegram-detection poll runs
    // every 2s and calls renderChats for the focused chat) replaces the
    // disabled button with a fresh enabled one mid-request. Without a
    // state-level guard, a second click landing in that window starts a
    // second lookup before the first has set s.caRecordId, so its "delete
    // my previous record" dedup sees nothing to delete -- both create a
    // fresh, empty Customer Approaching row, and only one ever gets
    // tracked. The other sits there forever as an orphaned duplicate
    // (confirmed from real data: the same username creating 3-4 rows
    // seconds apart, all blank past Username/Brand/Agent Name).
    lookupInFlight: false,
    // Collapsed by default — a card only expands to full detail when the
    // agent clicks it (see toggleExpand). Keeps up to 6 concurrent chats
    // glanceable instead of only ~2 fitting on screen at once.
    expanded: false,
    // Whether the D.O.B. calendar is currently open -- tracked in state
    // (not just a DOM class toggle) because renderChats does a full
    // re-render of every card, including on a background poll the agent
    // never triggered (checkChatStatus's telegram-detection check runs
    // every 2s). The initial card template used to hardcode the calendar
    // as hidden, so any such re-render silently closed it out from under
    // an agent still scrolling through it -- confirmed live as "the date
    // picker sometimes just closes on its own." See toggleDobCalendar and
    // the card template below.
    dobCalendarOpen: false,
  };
  // Standalone preview opens with a complete, read-only demonstration so
  // reviewers can assess the special bonus workflows without configuring a
  // brand and performing a live lookup first. Embedded LiveChat never uses
  // this sample state.
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

// Which text field is focused, by a selector stable across a re-render
// (class + which chat's card + which escalation field, where relevant) --
// used to restore focus/cursor position around renderChats() below, since
// it always tears down and rebuilds the whole card. Only a fixed, known
// set of fields are worth this: the ones an agent is realistically still
// typing into when a background poll's re-render lands mid-keystroke.
function focusableFieldSelector(el) {
  if (el.classList.contains("username-input")) return ".username-input";
  if (el.classList.contains("inquiry-search")) return ".inquiry-search";
  if (el.classList.contains("amount-input")) return ".amount-input";
  if (el.classList.contains("status-search")) return ".status-search";
  if (el.classList.contains("brand-search")) return ".brand-search";
  if (el.classList.contains("dob-cal-month-search")) return ".dob-cal-month-search";
  if (el.classList.contains("dob-cal-year-search")) return ".dob-cal-year-search";
  if (el.classList.contains("esc-input") && el.dataset.field) {
    return `.esc-input[data-field="${el.dataset.field}"]`;
  }
  return null;
}

// Selector -> [options-list selector, options re-renderer] for every search
// box whose typed filter text isn't mirrored into state (same situation as
// Inquiry's — see restoreFocus below).
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
  // Every search box here (Inquiry, Status, Brand, D.O.B month/year) has
  // its typed filter text live only in the DOM, never mirrored into state
  // (see each one's own "input" handler note) -- a fresh render always
  // starts it blank, so the typed text itself would otherwise be lost
  // outright, not just defocused. Every other captured field (username,
  // Escalation fields, the amount box) already renders with the right
  // value straight from state, so this is a no-op for them.
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
  try { el.setSelectionRange(captured.selectionStart, captured.selectionEnd); } catch (_) { /* not a text-selectable input type */ }
}

// Wraps the actual render so a background re-render (checkChatStatus
// detecting a link/Telegram/close, sweepPendingChats, etc.) never steals
// focus or loses in-progress typing -- confirmed live as "it just reloads
// while I'm typing." chatListEl.innerHTML = "" below always destroys every
// input node outright, so plain focus() alone isn't enough; this captures
// which field (and, for Inquiry's untracked search text, what was typed)
// before that happens and restores it after.
function renderChats(chats) {
  const focusCapture = captureFocus();
  renderChatsInner(chats);
  restoreFocus(focusCapture);
}

function renderChatsInner(chats) {
  chatListEl.innerHTML = "";

  if (!chats.length) {
    chatListEl.innerHTML = `<div class="empty-state">No chat currently open — select a conversation in LiveChat to see it here.</div>`;
    return;
  }

  // Pass 1: make sure every chat has state before deciding defaults below —
  // the "expand the first chat" default needs to see the whole list.
  for (const chat of chats) {
    ensureChatState(chat);
  }
  if ((previewMode || DEPARTMENT_TABS_LIVE) && activeMainTab === "tickets") {
    const chat = chats[0];
    const card = document.createElement("div");
    card.className = "chat-card ticket-workspace-card";
    card.dataset.chatId = chat.chatId;
    card.innerHTML = renderAdminTicketWorkspace(chat);
    chatListEl.appendChild(card);
    return;
  }
  // Default: expand exactly one chat (the first) on first load only, so
  // agents land on a usable full card and see how the pattern works. Must
  // NOT re-check "is anything expanded" on every render — collapsing the
  // last open card is a deliberate agent action (e.g. wanting the full
  // compact queue view) and shouldn't be silently reopened.
  if (!hasAutoExpandedOnce && chats.length) {
    state[chats[0].chatId].expanded = true;
    hasAutoExpandedOnce = true;
  }

  for (const chat of chats) {
    const s = state[chat.chatId];
    const expanded = previewMode ? s.expanded : true;

    const card = document.createElement("div");
    // Whole-card red highlight when a chat closed incomplete — meant to be
    // impossible to miss even at a glance across 6 concurrent chats, not
    // just a small line of text at the bottom.
    card.className = "chat-card"
      + (s.autoRecordError ? " needs-attention" : "")
      + (expanded ? "" : " collapsed");
    card.dataset.chatId = chat.chatId;
    card.innerHTML = expanded ? renderExpandedCard(chat) : renderCollapsedCard(chat);

    chatListEl.appendChild(card);
  }
}

// Which state flag backs each dropdown's open/closed persistence -- see
// closeAllDropdowns' header note for why this exists at all.
const DROPDOWN_STATE_KEY = {
  "inquiry-dropdown": "inquiryDropdownOpen",
  "status-dropdown": "statusDropdownOpen",
  "brand-dropdown": "brandDropdownOpen",
  "dob-calendar": "dobCalendarOpen",
};

// Hides every open dropdown/calendar across the whole widget (the "only
// one open at a time" rule) AND clears each one's state flag, not just its
// DOM class -- renderChats does a full re-render of every card, including
// from a background poll the agent never triggered (checkChatStatus's
// telegram-detection check runs every 2s). A card's initial template reads
// these state flags to decide whether to render a dropdown already open;
// if only the DOM class were cleared here, that flag would still say
// "open" and the very next re-render would silently reopen a dropdown the
// agent had already closed. Every toggle/select handler calls this instead
// of touching classList directly.
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

/* ============================================================
   EVENTS (delegated — cards re-render often)
   ============================================================ */
// The cases bar ("Save changes" appears once a logged case is edited) is
// refreshed after any click / input / change inside a card, since many
// handlers only update their own slot instead of re-rendering the card.
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
  const details = event.target.closest?.(".bonus-admin-embed");
  if (!details?.open) return;
  const frame = details.querySelector("iframe[data-src]");
  if (frame && !frame.src) frame.src = frame.dataset.src;
}, true);

chatListEl.addEventListener("input", (e) => {
  const input = e.target.closest(".username-input");
  if (!input) return;
  const id = input.closest(".chat-card")?.dataset.chatId;
  if (id && state[id]) state[id].usernameDraft = input.value;
});

chatListEl.addEventListener("keydown", (event) => {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target;
  const card = target.closest?.(".chat-card");

  // The primary text lookups should submit like a normal search field.
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
    // Enter and Space already activate these native buttons.
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
  const card = btn.closest(".chat-card");
  const s = state[chatId];

  // try/finally (rather than a saveState() call at the end of the function
  // body) so every branch below persists its change, including the several
  // early `return`s inside individual action blocks (e.g. lookup's
  // missing-username/brand guards).
  try {

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
    s.escalation[btn.dataset.field] = btn.dataset.value || "";
    card.querySelector(".escalation-slot").innerHTML = renderEscalationSection(chatId);
    return;
  }

  if (btn.dataset.action === "clearTicketNotifications") {
    ticketNotifications = [];
    renderChats(activeChats);
    return;
  }

  if (btn.dataset.action === "searchTickets") {
    btn.disabled = true;
    btn.textContent = "Searching…";
    try {
      const query = String(s.ticketSearchQuery || "").trim();
      if (/^TK[A-Z0-9]+$/i.test(query)) {
        await loadTicketStatus(chatId, query, { silent: true });
        ticketSearchResultsByChat.delete(chatId);
      } else {
        await searchTickets(chatId, query, "search");
      }
      s.escalationError = "";
    } catch (err) {
      ticketSearchResultsByChat.set(chatId, { loading: false, tickets: [], error: err.message, mode: "search" });
    }
    card.querySelector(".escalation-slot").innerHTML = renderEscalationSection(chatId);
    return;
  }

  if (btn.dataset.action === "loadAllTickets") {
    btn.disabled = true;
    btn.textContent = "Loading…";
    try {
      await searchTickets(chatId, "", "all");
      s.escalationError = "";
    } catch (err) {
      ticketSearchResultsByChat.set(chatId, { loading: false, tickets: [], error: err.message, mode: "all" });
      s.escalationError = "Ticket list failed: " + err.message;
    }
    card.querySelector(".escalation-slot").innerHTML = renderEscalationSection(chatId);
    return;
  }

  if (btn.dataset.action === "openTicketResult") {
    try {
      await loadTicketStatus(chatId, btn.dataset.ref, { silent: true });
      s.escalationError = "";
    } catch (err) {
      s.escalationError = "Ticket lookup failed: " + err.message;
    }
    card.querySelector(".escalation-slot").innerHTML = renderEscalationSection(chatId);
    return;
  }

  if (btn.dataset.action === "cancelLookup") {
    const controller = lookupControllers.get(chatId);
    if (s?.lookupInFlight && controller) {
      btn.disabled = true;
      btn.textContent = "Stopping…";
      controller.abort();
    } else {
      // Nothing is running for this chat (e.g. the flag outlived the request): clear it, or the card keeps
      // re-rendering a Cancel button that can never do anything.
      if (s) s.lookupInFlight = false;
      renderChats(activeChats);
    }
    return;
  }

  if (btn.dataset.action === "lookup") {
    if (!selectedAgent && !previewMode) { openSettingsPanel(); return; }
    // State-level guard, not just btn.disabled -- a background re-render
    // (checkChatStatus's 2s Telegram-detection poll calls renderChats for
    // the focused chat) replaces this button with a fresh enabled one
    // mid-request, and a second click landing in that window would start a
    // second lookup before the first has set s.caRecordId, creating a
    // duplicate empty Customer Approaching row that never gets tracked or
    // cleaned up. See ensureChatState's lookupInFlight for the full story.
    if (s.lookupInFlight) return;
    const username = card.querySelector(".username-input").value.trim();
    if (!username) { setStatus("Enter a username before looking up.", "error"); return; }
    if (!s.brand && detectedBrandFor.has(chatId)) s.brand = detectedBrandFor.get(chatId);
    const brand = s.brand;
    if (!brand) {
      // Kick detection off again rather than just waiting -- the first
      // attempt may have failed or never run for this chat.
      if (groupIdFor.has(chatId)) resolveBrandFromGroupId(chatId, groupIdFor.get(chatId));
      setStatus("Brand hasn't been auto-detected yet for this chat — pick it from the Brand box, or try again in a moment.", "error");
      return;
    }
    s.username = username;
    s.usernameDraft = "";
    if (!s.escalation.memberUserId) s.escalation.memberUserId = username;
    const chatDef = activeChats.find((c) => c.chatId === chatId);
    const telegramNow = card.querySelector(".tg-check").checked;
    // "Force lookup": the last lookup said Not VVIP and auto-ticked Unknown.
    // CS is saying the player is VIP anyway (the list just isn't updated
    // yet), so un-mark Unknown up front and don't auto-mark it again below.
    const forcing = !!s.notVipResult;
    if (forcing) s.isUnknown = false;
    // One Customer Approaching row per chat: a repeat lookup passes back the record created last time (only if it was not logged yet and is this
    // agent's own), so the backend deletes it first.
    const previousRecordId = (!s.logged && s.caRecordId && ownsCaseRecord(s)) ? s.caRecordId : null;
    await runLookup(chatId, { username, brand, telegramNow, link: s.chatUrl || chatDef?.link || "", previousRecordId, forcing, btn });
  }

  if (btn.dataset.action === "claim") {
    const programKey = btn.dataset.program;
    const r = s.matchedRow;

    // VS96 is only earned after CS records two separate pieces of player
    // feedback. Keep this guard here as well as disabling the button, so a
    // stale DOM or programmatic click cannot bypass the requirement.
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

    // Grace Period's one field packs two different states (see renderTickets)
    // and neither follows the generic claim flow below at all: "Pass ..."
    // just activates the offer — Inquiry/Status only, no amount/claim
    // secret, and it doesn't consume the one-claim-per-case slot. "Activated
    // : ... - Bonus N" is the real claim — amount comes from the number
    // after "Bonus" specifically (not "Deposit"), and it behaves like any
    // other claim (locks the rest, Claim Secret ticked).
    if (programKey === "gracePeriod") {
      const display = r.gracePeriod || "";
      if (/^\s*pass\b/i.test(display)) {
        s.gracePeriodActivated = true;
        s.inquiry = ["Grace Period"];
        s.status = "Activated";
      } else {
        const amountMatch = display.match(/Bonus\s*[:\-]?\s*(-?\d+(?:\.\d+)?)/i);
        const amount = amountMatch ? amountMatch[1] : "";
        s.claimedPrograms.gracePeriod = true;
        s.inquiry = ["Grace Period"];
        s.status = "Given";
        if (!s.claimSecretManual) s.claimSecret = true;
        // Bare number only, same convention as the generic claim path below
        // — no "Grace Period: " label prefix (the Inquiry tag already says
        // which bonus this is).
        s.releasedBonusAmount = amount || display;
        s.releasedAmountRaw = amount || display;
        if (!s.escalation.amount && amount) s.escalation.amount = amount;
      }
      card.querySelector(".ticket-slot").innerHTML = renderTickets(chatId);
      card.querySelector(".auto-fields-slot").innerHTML = renderAutoFields(chatId);
      refreshInquiryChips(card, chatId);
      card.querySelector(".inquiry-dropdown").innerHTML = renderInquiryDropdown(chatId, "");
      refreshStatusChip(card, chatId);
      card.querySelector(".status-dropdown").innerHTML = renderStatusDropdown(chatId);
      // "Pass" is only an activation, not a completed claim (see this
      // branch's own header note) — nothing to submit yet. The real claim
      // ("Activated: ...") sets everything submitRecord needs same as any
      // other program's claim, so it gets the same instant-submit treatment.
      if (s.claimedPrograms.gracePeriod && !previewMode) {
        await submitRecord(chatId, { auto: true, reason: "Grace Period claimed" });
      }
      return;
    }

    // Telegram RM28 / Redeem Code / Special Reload (Ang Pao) write live to
    // Lark the instant they're claimed — that's what fires the backoffice-
    // approval workflow. Regular (gold) tickets are read-only source-table
    // rows; they're only logged at submit.
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
    const allSources = [
      ...allBonusPrograms().map((p) => ({ key: p.key, label: p.label, display: r[p.key] })),
      { key: "telegram28", label: "Telegram RM28", display: r.telegram28?.status },
      { key: "redeemCode", label: "Redeem Code", display: r.redeemCode?.status },
      { key: "specialReload", label: "Special Reload (Ang Pao)", display: r.specialReload?.status },
    ];
    // Released Amount only ever applies to Top 10 P&L / LTV / Telegram RM28
    // (Grace Period has its own separate handling above). Risk Player uses
    // riskClaim, calculated from the customer reload amount and capped by
    // tier. 12h VIP Booster, Redeem Code, and Special Reload stay blank.
    //
    // The Amount box shows just the bare number now (e.g. "18"), not the
    // label/status text it used to ("Top 10 P&L: Pass RM18") -- confirmed
    // live as confusing to read, and the label added nothing the Inquiry
    // tag doesn't already say. extractAmountNumber mirrors lark-record.js's
    // own extractAmount(): a number directly after "RM" takes priority,
    // since a bonus's raw display text often has other digits earlier
    // (e.g. Top 10 P&L(Night)'s real format "Batch 09-09-2026 Pass RM58" --
    // the naive "first number found" pattern used here previously for
    // escalation.amount would have grabbed "09" instead of "58").
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

    // Auto-set inquiry from the bonus type — only the matching inquiry tag,
    // NOT "Feedback". CS adds Feedback manually if applicable.
    const mappedInquiry = resolveInquiryForProgram(programKey, r[programKey]);
    if (mappedInquiry) {
      s.inquiry = [mappedInquiry];
    }

    // Status auto-sets to "Given" the moment any bonus is claimed.
    s.status = "Given";

    card.querySelector(".ticket-slot").innerHTML = renderTickets(chatId);
    card.querySelector(".auto-fields-slot").innerHTML = renderAutoFields(chatId);
    refreshInquiryChips(card, chatId);
    card.querySelector(".inquiry-dropdown").innerHTML = renderInquiryDropdown(chatId, "");
    refreshStatusChip(card, chatId);
    card.querySelector(".status-dropdown").innerHTML = renderStatusDropdown(chatId);

    // Every field submitRecord requires is already fixed the instant any
    // bonus is claimed here — username/caRecordId from the Look Up that
    // had to happen first to see a claimable ticket at all, Brand
    // auto-detected, Inquiry/Status just set above — so nothing about the
    // Customer Approaching record still changes after this claim
    // (D.O.B./Telegram aside, which stay editable and can be recorded
    // later same as any other case). Submits immediately rather than
    // waiting for the chat to close, same as Special Reload originally did
    // — generalized to every program that reaches this shared completion
    // path, not just that one.
    if (!previewMode) {
      await submitRecord(chatId, { auto: true, reason: `${allSources.find((src) => src.key === programKey)?.label || "Bonus"} claimed` });
    } else {
      setStatus("Preview claim simulated. No Lark record was created or updated.", "success");
    }
  }

  // Click a claimed bonus again to undo it. Clears Inquiry, Status, Amount and
  // Claim Secret in the card AND blanks them on the existing Customer
  // Approaching record (the row itself is kept, never deleted). Claiming
  // auto-submits instantly (s.logged = true), so if it was already written
  // to Lark we send an unclaim update first, and only reset the card once
  // that succeeds -- otherwise the card would say "cleared" while Lark still
  // holds the old values. s.logged goes back to false so a re-claim (or the
  // normal record-on-close) can write the record again.
  //
  // Telegram RM28 / Redeem Code / Special Reload: their claim also set the
  // source table's own Status to "Claimed" (which fires the backoffice
  // workflow). That is deliberately NOT touched here -- only the Customer
  // Approaching record is cleared.
  if (btn.dataset.action === "unclaim") {
    if (s.unclaimInFlight) return;
    const programKey = btn.dataset.program;
    const wasGraceActivationOnly = programKey === "gracePeriod" && s.gracePeriodActivated && !s.claimedPrograms.gracePeriod;
    s.unclaimInFlight = true;
    btn.disabled = true;
    try {
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
    // Polling stops once a chat is logged -- restart it so the chat closing
    // still triggers the normal auto-record.
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

  // A customer can fail to complete the Grace Period challenge whether
  // they're mid-activation or already at the claim stage, so this sits
  // alongside Activate/Claim always (see renderTickets) rather than only
  // once one of those is already done — Activate/Claim's own button
  // disables itself the moment it's clicked, same look as every other
  // claimed ticket, so it can't just be re-clicked directly. Resets back
  // to a fresh "Activated, not yet claimed" state every time — including
  // undoing an already-made claim (amount/Claim Secret/the one-claim-per-
  // case lock) if there was one, since reactivating means giving them a
  // new attempt at the whole thing. Same effect as Activate itself either
  // way (nothing writes to Lark until the final submit), just
  // re-triggerable as many times as the case needs.
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
      // Same max-2 / "one must be Feedback" rule as before, just enforced
      // from a dropdown click instead of a checkbox change event.
      if (s.inquiry.length >= 2) {
        setStatus("Only 2 inquiries can be selected per case.", "error");
      } else if (s.inquiry.length === 1 && s.inquiry[0] !== "Feedback" && val !== "Feedback") {
        setStatus('When picking 2 inquiries, one of them must be "Feedback".', "error");
      } else {
        s.inquiry.push(val);
      }
    }
    // Clears whatever was typed to find this option — leaving it in place
    // left stale filter text sitting in the box (and the list still
    // filtered down to just that text) right after picking something.
    const searchInput = card.querySelector(".inquiry-search");
    if (searchInput) { searchInput.value = ""; searchInput.blur(); }
    refreshInquiryChips(card, chatId);
    card.querySelector(".inquiry-dropdown").innerHTML = renderInquiryDropdown(chatId, "");
    // Close after every pick (same as Status) -- needing a second inquiry
    // (e.g. Feedback) is just a click on the box to reopen it. The state
    // flag is cleared too, or the next background re-render would reopen it.
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
    ticketCreateInFlight.add(chatId);
    try {
      const files = ticketAttachmentsByChat.get(chatId) || [];
      let requestBody;
      let headers;
      if (files.length) {
        const form = new FormData();
        form.append("ticket", JSON.stringify({ fields }));
        const attachmentField = ticketAttachmentField();
        const partName = attachmentField?.key || attachmentField?.label || "Attachment";
        for (const file of files) form.append(partName, file, file.name);
        requestBody = form;
      } else {
        headers = { "Content-Type": "application/json" };
        requestBody = JSON.stringify({ fields });
      }
      const res = await fetch("/ticket-create", { method: "POST", headers, body: requestBody });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Submit failed");
      s.ticketRef = data.ref;
      s.ticketLookupRef = data.ref;
      s.escalationSubmitted = true;
      s.escalationError = "";
      s.ticketAttachmentError = "";
      ticketAttachmentsByChat.delete(chatId);
      try { await loadTicketStatus(chatId, data.ref); } catch (_) { /* creation succeeded; status can be retried */ }
      setStatus(`Ticket ${data.ref} created.`, "success");
    } catch (err) {
      s.escalationError = "Ticket creation failed: " + err.message;
    } finally {
      ticketCreateInFlight.delete(chatId);
    }
    saveState();
    card.querySelector(".escalation-slot").innerHTML = renderEscalationSection(chatId);
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
    s.escalationSubmitted = false;
    s.ticketRef = "";
    s.ticketRecord = null;
    s.escalationError = "";
    s.ticketAttachmentError = "";
    ticketAttachmentsByChat.delete(chatId);
    card.querySelector(".escalation-slot").innerHTML = renderEscalationSection(chatId);
    saveState();
  }

  if (btn.dataset.action === "toggleExpand") {
    const wasExpanded = s.expanded;
    // Accordion — only one full card open at a time, so the rest stay
    // collapsed and glanceable instead of the list growing unbounded.
    Object.values(state).forEach((st) => { st.expanded = false; });
    s.expanded = !wasExpanded;
    renderChats(activeChats);
  }

  if (btn.dataset.action === "selectStatus") {
    s.status = btn.dataset.value;
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
    closeAllDropdowns(); // only one dropdown open at a time across the whole widget
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
    closeAllDropdowns(); // only one dropdown open at a time across the whole widget
    if (willOpen) {
      s.dobCalendarOpen = true;
      cal.innerHTML = renderDobCalendar(chatId); // fresh each open — reflects any dob change since last shown
      cal.classList.remove("hidden");
    }
  }

  if (btn.dataset.action === "dobNavMonth") {
    if (!s.dobView) renderDobCalendar(chatId); // side effect: lazily initializes s.dobView
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
    // This whole handler previously had no catch -- an exception thrown by
    // ANY action here (not just saveCase) was swallowed by the browser
    // with zero feedback: no status message, no visible change, nothing in
    // the UI to suggest anything even happened. Surfacing it here doesn't
    // fix whatever throws, but at least tells the agent (and, via the
    // console.error below, tells us) what actually went wrong instead of
    // looking like the button silently does nothing.
    console.error("Action failed:", btn.dataset.action, err);
    setStatus(`Something went wrong (${btn.dataset.action}): ` + err.message, "error");
  } finally {
    saveState();
  }
});

// Inquiry search box: filter as the agent types.
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
  // Status's search box lives in its always-visible box now (matching
  // Inquiry exactly), so its dropdown panel holds nothing but the options
  // list already -- same renderStatusDropdown(chatId, query) call Inquiry's
  // own handler makes just above.
  const statusSearch = e.target.closest(".status-search");
  if (statusSearch) {
    const card = statusSearch.closest(".chat-card");
    card.querySelector(".status-dropdown").innerHTML = renderStatusDropdown(card.dataset.chatId, statusSearch.value);
    return;
  }
  // Brand/D.O.B month/year search boxes still live inside their own
  // dropdown panel (see renderBrandDropdown's header note) -- each only
  // replaces its sibling .*-options list, never the panel that contains
  // the search input itself.
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
  // Escalation Ticket text/number/textarea fields — same no-re-render,
  // just-sync-state pattern as D.O.B.
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
    if (s) s.escalation[escInput.dataset.field] = escInput.value;
    return;
  }
  // Risk Player's manually-typed Amount (see renderAutoFields) — both
  // fields lark-record.js reads at submit time double as the typed value
  // directly, same as every other program's auto-derived amount.
  const amountInput = e.target.closest(".amount-input");
  if (amountInput) {
    const s = state[amountInput.dataset.chat];
    if (s) {
      s.releasedBonusAmount = amountInput.value;
      s.releasedAmountRaw = amountInput.value;
    }
    return;
  }
  // Username isn't otherwise state-synced (only read from the DOM at Look
  // up time) — checkLastUsername can re-render this card in the background
  // while the agent is mid-typing, which would stomp an un-synced value.
  // Keeping state.username live here means any re-render is always safe.
  const usernameInput = e.target.closest(".username-input");
  if (usernameInput) {
    const card = usernameInput.closest(".chat-card");
    const s = state[card?.dataset.chatId];
    if (s) s.username = usernameInput.value;
  }
});

// Telegram stays auto-detected by default but is now editable — CS may
// need to correct it, and checkboxes fire "change" reliably, unlike
// "input", across browsers. (Brand's own editing now goes through the
// selectBrand action handler above, since it's a custom dropdown, not a
// native <select>, anymore.)
chatListEl.addEventListener("change", (e) => {
  const explorerFilter = e.target.closest(".ticket-explorer-filter");
  if (explorerFilter) {
    const s = state[explorerFilter.dataset.chat];
    const allowed = new Set(["ticketExplorerAgent", "ticketExplorerStatus", "ticketExplorerDepartment", "ticketExplorerMarket"]);
    if (s && allowed.has(explorerFilter.dataset.filter)) s[explorerFilter.dataset.filter] = explorerFilter.value;
    explorerFilter.closest(".escalation-slot").innerHTML = renderEscalationSection(explorerFilter.dataset.chat);
    saveState();
    return;
  }
  const attachmentInput = e.target.closest(".ticket-attachment-input");
  if (attachmentInput) {
    const chatId = attachmentInput.dataset.chat;
    addTicketAttachments(chatId, attachmentInput.files);
    attachmentInput.closest(".escalation-slot").innerHTML = renderEscalationSection(chatId);
    return;
  }
  // Claim Secret: auto-ticked on claim, but editable. If the record was
  // already written to Lark (claims auto-submit), push the edit through too,
  // otherwise it would only change on screen.
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
      s.telegramManual = true; // stops the auto-poll from overwriting this
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
    if (uState) uState.notVipResult = false; // a manual tick/untick ends the "Force lookup" offer
    setUnknown(unknownCheck.dataset.chat, unknownCheck.checked);
    renderChats(activeChats);
    saveState();
  }
});

// Shared by the manual "Unknown player" checkbox and the auto-tick once a
// Look Up comes back Not VVIP (see the lookup action handler) -- both mean
// the same thing to this widget: nothing about this chat should end up in
// Customer Approaching. Deletes the placeholder row a Look Up already
// created (username/brand/agent name only, nothing else filled in yet) so
// an Unknown-marked chat truly records nothing, not just an empty row.
// Doesn't render or save itself -- callers already do their own render
// right after (the checkbox handler above, the lookup handler's own
// unconditional slot refresh), so this stays a plain state mutation
// instead of triggering a second, redundant re-render on top of theirs.
function setUnknown(chatId, value, { silent = false } = {}) {
  const s = state[chatId];
  if (!s) return;
  s.isUnknown = value;
  // A chat on the agent's unrecorded list that they mark Unknown is written off in Lark right away, so it cannot come back
  // from there (an incognito window forgets the tick, Lark does not).
  if (value && unrecordedChats.some((chat) => chat.threadId === chatId)) resolveUnrecorded(chatId, "Ignored");
  if (!s.isUnknown || !s.caRecordId) return;

  if (previewMode) {
    s.caRecordId = null;
    s.logged = false;
    s.loggedSnapshot = "";
    s.autoRecordError = "";
    return;
  }

  // A record can already exist from a Look up (a guessed/wrong username, a
  // confirmed non-VIP) or even have been recorded already -- an Unknown
  // player should have no Customer Approaching row at all, so it's removed
  // either way. The one exception: a bonus claimed on it is real (the
  // source table was already marked Claimed), so that record is kept --
  // unclaim first (click the claimed bonus again) if it should go too.
  const hasClaim = Object.values(s.claimedPrograms || {}).some(Boolean);
  if (hasClaim) {
    if (!silent) setStatus("Marked Unknown, but its Lark record was kept because a bonus is claimed on it. Unclaim the bonus first if the record should be removed.", "error");
    return;
  }

  const staleRecordId = s.caRecordId;
  if (!ownsCaseRecord(s)) {
    // Another agent's row -- just stop using it here, never delete it.
    s.caRecordId = null;
    s.logged = false;
    s.loggedSnapshot = "";
    return;
  }
  s.caRecordId = null;
  s.logged = false;
  s.loggedSnapshot = "";
  s.autoRecordError = "";
  const restore = () => { forgetDeletedRecord(staleRecordId); if (!s.caRecordId) s.caRecordId = staleRecordId; }; // lets a re-tick retry
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

// Inquiry and Status both use this same merged box + search pattern now
// (Status rebuilt to match Inquiry exactly, single-select instead of up to
// 2 — see renderStatusChip's header note). One shared config drives both
// the focusin and click handlers below instead of duplicating each one
// per field.
const MERGED_SEARCH_BOXES = [
  { search: ".inquiry-search", box: ".inquiry-box", wrapper: ".inquiry-select", dropdown: ".inquiry-dropdown", stateKey: "inquiryDropdownOpen" },
  { search: ".status-search", box: ".status-box", wrapper: ".status-picker", dropdown: ".status-dropdown", stateKey: "statusDropdownOpen" },
];

// Dropdown opens on focus (no explicit toggle button, unlike Brand/D.O.B);
// closes whatever else is open first so only one shows at a time across
// the whole widget.
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

// Clicking anywhere in the merged box (not just the thin search input
// itself) focuses it — makes the whole box feel like one clickable control.
// Also makes a second click actually close it again (e.g. on the caret, or
// empty space in the box) — focus() alone never does, since the input's
// already focused by then and focusin (which is what opens it) doesn't
// refire. Scoped to clicks that land outside the search input itself so
// typing in it never closes the dropdown out from under whoever's still
// searching.
chatListEl.addEventListener("click", (e) => {
  if (e.target.closest(".inquiry-chip-remove, .status-chip-slot .inquiry-chip-remove")) return; // don't steal focus from a chip removal click
  for (const cfg of MERGED_SEARCH_BOXES) {
    const box = e.target.closest(cfg.box);
    if (!box) continue;
    const searchInput = box.querySelector(cfg.search);
    if (e.target === searchInput) return; // let native focus behavior handle a direct click into the input
    const dropdown = box.closest(cfg.wrapper)?.querySelector(cfg.dropdown);
    if (dropdown && !dropdown.classList.contains("hidden")) {
      dropdown.classList.add("hidden");
      const chatId = box.closest(".chat-card")?.dataset.chatId;
      if (chatId && state[chatId]) state[chatId][cfg.stateKey] = false;
      searchInput?.blur();
    } else {
      searchInput?.focus(); // opens via the focusin handler above
    }
    return;
  }
});

// Click anywhere outside a given dropdown's own wrapper closes it — so a
// click on one of its own options, which lives inside that same wrapper,
// never closes it prematurely.
//
// Uses composedPath(), not wrap.contains(e.target): chatListEl's own click
// handler runs first (closer ancestor, fires earlier in bubbling) and some
// actions (dobNavMonth, selectDobMonthValue/selectDobYearValue) replace their container's innerHTML to
// reflect the new month/year — which detaches the very button that was
// clicked from the document. By the time this handler runs, e.target is a
// detached node, and wrap.contains(detachedNode) is always false — every
// wrapper reads as "clicked outside," closing the calendar right as it
// tries to update instead of navigate. composedPath() is captured at
// dispatch time, before any handler can mutate the DOM, so it still lists
// the original ancestors regardless of what ran before this.
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

// Custom dropdowns need the keyboard behavior browsers provide for a native
// <select>: arrows move through the visible choices, Enter chooses one, and
// Escape closes the list. Keep this shared so Inquiry, Status, Brand, D.O.B.
// and ticket fields all behave the same way.
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

// Same-record updates are idempotent, so retrying a dropped request is safe:
// it can only write the same final values again, never create another row.
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

// Re-sends an already-logged chat's record with its current values -- used
// when something is edited AFTER the instant claim auto-submit (submitRecord
// returns early once s.logged is set, so it can't do this itself).
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

// Shared by the manual "Record to Lark Base" button and the auto-record
// triggered when a chat closes. Pulls Brand/Status straight from the DOM
// since the agent may have edited them after the card was last rendered.
// Always re-queries the card by chatId rather than taking a DOM reference,
// since renderChats() can have rebuilt the card (e.g. right before an
// auto-record call) and made any earlier reference stale.
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
  // Every auto message below used to hardcode "Chat closed" -- accurate for
  // checkChatStatus's own call, but not for e.g. an instant-submit right
  // after a claim (see the specialReload branch above), which happens
  // before the chat ever closes. reason lets each caller say what actually
  // triggered this.
  const reasonText = reason || "Chat closed";

  // Unknown players are intentionally excluded from chat data — skip
  // recording entirely rather than treating a blank username as an
  // incomplete record that needs chasing down (which is what would
  // otherwise happen the moment the chat closes). s.logged still gets set
  // so this chat stops being polled/swept/retried like a real completed
  // one, but the UI shows a distinct "not recorded" state, not "✓ Logged".
  if (s.isUnknown) {
    s.logged = true;
    s.autoRecordError = "";
    logDiagnostic(`Chat closed — marked Unknown, not recorded.`, "success");
    renderChats(activeChats);
    renderNeedsAttentionPanel();
    return;
  }

  // Global "Don't log chats" toggle (top bar) — unlike isUnknown, this
  // deliberately does NOT set s.logged: it's a temporary gate any chat
  // passes back through once unticked, not a permanent per-chat skip, so
  // the next attempt (a manual click, the next auto-close, or the next
  // background sweep retry) records normally once logging resumes. Never
  // flagged as an error either — nothing's actually wrong.
  if (isLoggingPaused()) {
    if (!auto) setStatus("Logging is paused while you are on another tab — go back to Retention to record this chat.", "error");
    return;
  }

  // Not worked by this agent (see agentTouchedChat): nothing to record or chase, and nothing is stamped on it.
  // No action of theirs on the card -- with the LiveChat login on, LiveChat is asked whether they wrote in the chat.
  if (auto && !agentActed(s)) {
    if (!(await agentWroteInChat(chatId))) {
      if (!s.logged && s.autoRecordError) s.autoRecordError = ""; // flagged earlier on an "unsure" answer
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

  // Transferred chat: this card's Lark row is another agent's -- never
  // record into it (and never stamp it as ours). The agent presses Look up
  // to get a row of their own; both agents' records are kept.
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

  // Stamps this chat as belonging to whichever agent's browser last tried
  // to record it — the Needs Attention panel uses this to only surface a
  // given agent's own incomplete chats (see getIncompleteChats), not every
  // agent's, since localStorage is shared across tabs but a shared/kiosk
  // browser can otherwise mix different agents' work together in the list.
  s.agentName = selectedAgent;
  s.liveChatAccount = currentLiveChatAccount;

  // Brand and Status are both discrete picks from a dropdown now (no free
  // text), written to state the instant they're clicked — state is always
  // the source of truth here, no need to reach into the DOM for either.
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
      // Logged, not shown in the top bar — the whole card turning red (see
      // .chat-card.needs-attention) is the urgency signal now, not a banner
      // at the top that may not even be about the card the agent is looking at.
      s.autoRecordError = `${reasonText} but not fully filled in (missing: ${missing.join(", ")}) — complete it and click Record to Lark Base.`;
      // Only the diagnostics-log write is deduped, not autoRecordError
      // itself — a permanently-incomplete chat (e.g. one that never had a
      // real lookup done at all) gets retried by sweepPendingChats every
      // 8s forever, and it was logging this identical line every single
      // time. The card still stays accurately red regardless.
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
        // s.chatUrl first — survives once this chat isn't the focused one
        // anymore (see checkChatStatus); activeChats[].link as a fallback
        // for anything relying on the older path.
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

// Every status message is logged here regardless of whether it's shown in
// the compact top bar — Settings → Diagnostics is where an agent (or
// whoever's troubleshooting) can see the full history without opening
// devtools. Only errors interrupt the top bar; routine confirmations
// ("Bonuses ready...", "Logged X to Lark Base") are logged silently since
// normal CS doesn't need to see them.
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
    // Not an error — keep the top bar clear/compact rather than showing
    // routine confirmations. Check Settings → Diagnostics for the log.
    statusEl.textContent = "";
    statusEl.className = "status-bar hidden";
  }
}

// Agent Name / Brand / Inquiry / Status dropdowns all come from Lark's own
// field option lists (see fetchAgentOptions etc. above) instead of being
// hardcoded, so a name/tag added, renamed or removed there shows up here
// without a redeploy. Re-fetched at boot, on every manual Refresh click,
// and on this slow background timer — a widget an agent leaves open all
// day would otherwise only ever see whatever was live when it first
// loaded. Doesn't touch anything already picked on an open card.
const OPTIONS_REFRESH_MS = 10 * 60_000; // was 3 min: every open widget re-read Lark's field catalog on this timer
async function refreshDropdownOptions({ fresh = false } = {}) {
  const loaded = await fetchBootstrapOptions({ fresh });
  if (!loaded) {
    await Promise.allSettled([
      fetchAgentOptions({ fresh }), fetchBrandOptions({ fresh }), fetchInquiryOptions({ fresh }),
      fetchStatusOptions({ fresh }), fetchConfiguredBonusPrograms({ fresh }),
    ]);
  }
  if (!IS_EMBEDDED_APP || DEPARTMENT_TABS_LIVE) await fetchTicketConfig({ fresh });
}
setInterval(() => {
  if (!document.hidden) refreshDropdownOptions();
}, OPTIONS_REFRESH_MS);

// ⟳ Refresh. When a new version has been deployed (deployment-refresh.js shows the notice and sets
// deploymentUpdatePending) this is also THE way to load it -- never automatic, because a reload would interrupt a ticket
// being created, a claim in flight, unsent attachments, or typing in LiveChat's own chat box. With no update pending it
// behaves exactly as before.
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
  fetchUnrecordedChats(); // the list is otherwise read only when the widget starts, so a list written since would not show
  if (liveWidget) {
    // Live mode — re-sync against the SDK on demand rather than just
    // re-rendering whatever we already had (which could be stale if a
    // customer_profile event was somehow missed).
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

// Blast reports whether a queue is active (running, paused or cleaning up); recording stays off for all of it.
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

// Schedules non-critical work after the first paint. requestIdleCallback is
// especially helpful on low-end devices; the timeout keeps the work from
// being postponed forever in a busy LiveChat window.
function runWhenIdle(task, timeout = 1500) {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(task, { timeout });
  } else {
    setTimeout(task, Math.min(timeout, 500));
  }
}

// Boot sequence: connect to LiveChat first. Lark option lists, stale-record
// checks and the settings UI must not compete with the SDK handshake.
(async () => {
  // Restore any chat state saved before this widget last reloaded — must
  // happen before the first renderChats/ensureChatState call, since
  // ensureChatState only fills in defaults for a chatId it hasn't seen yet.
  Object.assign(state, loadPersistedState());
  for (const chatId of Object.keys(state)) markStateSynced(chatId);
  if (!IS_EMBEDDED_APP) logDiagnostic("Preview mode — showing sample chats until connected to LiveChat.");
  applyDepartmentChrome();
  syncMainTabs();
  updateAgentBadge();
  renderChats(activeChats);

  // Keep this as one call with no retries: repeated createDetailsWidget()
  // handshakes are what caused the earlier timeout loop.
  initLiveChatSdk();

  const optionsReady = refreshDropdownOptions();
  // Off by default. When on, the agent name comes from the LiveChat login and nothing is recorded before it arrives.
  if (AGENT_LOGIN_LIVE) await requireAgentLogin();
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
  if ((originalAgentSetup || currentDepartment === "rtn") && !selectedAgent) {
    // Give the agent-name list a short chance to arrive, while never holding
    // the LiveChat connection or the first paint behind the network.
    await Promise.race([
      optionsReady,
      new Promise((resolve) => setTimeout(resolve, 1200)),
    ]);
    openSettingsPanel();
  }

  optionsReady.finally(() => {
    if (BONUS_SHOWCASE_PREVIEW) renderChats(activeChats);
    if (activeMainTab === "tickets") renderChats(activeChats);
    // Brand detection may have started before the Lark option list arrived.
    // Retry it once with the populated list rather than leaving Brand blank.
    const chatId = activeChats[0]?.chatId;
    const groupID = chatId ? groupIdFor.get(chatId) : null;
    if (chatId && groupID && !state[chatId]?.brand) resolveBrandFromGroupId(chatId, groupID);
  });

  setTimeout(startLookupResume, 1500);   // a lookup that was running when the previous copy of this widget went away
  runWhenIdle(() => {
    renderNeedsAttentionPanel();
    fetchStaleRecords();
    // Recover claims saved by an older app version that stopped at
    // "Auto-record failed (Failed to fetch)" while the chat was still open.
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

// Autosave safety nets beyond the explicit saveState() calls in the click/
// input/change handlers below — covers state mutated outside those (e.g.
// applyProfile's auto brand/telegram detection, checkLastUsername,
// checkChatStatus) and the moment this iframe actually goes away.
setInterval(() => {
  if (!document.hidden) saveState();
}, 10_000);
// Another tab just wrote state (e.g. finished recording a chat from a Needs
// Attention "Open" tab) -- pick it up and refresh the panel right away
// instead of waiting for the next sweep. saveState() only adopts/writes
// what actually differs, so this can't ping-pong between tabs.
window.addEventListener("storage", (e) => {
  if (e.key !== STATE_STORAGE_KEY) return;
  storageDirty = true; // another tab wrote: the next saveState() must read and adopt it
  saveState();
  renderNeedsAttentionPanel();
  scheduleNeedsAttentionRefresh(300);
});

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
  addTicketAttachments(chatId, files);
  picker.closest(".escalation-slot").innerHTML = renderEscalationSection(chatId);
});

document.addEventListener("click", (event) => {
  if (event.target.closest?.(".ticket-choice")) return;
  document.querySelectorAll(".ticket-choice-menu").forEach((menu) => menu.classList.add("hidden"));
  document.querySelectorAll(".ticket-choice-trigger").forEach((trigger) => trigger.setAttribute("aria-expanded", "false"));
});
window.addEventListener("pagehide", saveState);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveState(); });

// LiveChat's Agent App "Details" widget (createDetailsWidget, see
// initLiveChatSdk) only ever runs for whichever ONE chat is currently
// focused on screen — switching to a different chat reloads this widget's
// iframe just like a page refresh does (the same reload state persistence
// above works around), so a chat the agent switches away from gets zero
// status polling at all and its closure is only ever noticed once they
// switch back to it. This sweeps every OTHER pending (not yet logged,
// still open per its own last-known state) chat on a slower cadence,
// piggybacking off whichever tab/instance happens to be alive at the
// moment — localStorage is shared across every tab on this origin, so any
// currently-open LiveChat tab can pick up and auto-record a chat that
// closed while the agent was looking at a different one. checkChatStatus
// itself is safe to call this way — see its own header note.
const PENDING_SWEEP_MS = 8_000;
const SWEEP_BACKOFF_CAP_MS = 5 * 60_000;
const SWEEP_TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
// Every open tab/LiveChat account on this origin runs this timer against the same localStorage, which
// multiplied every retry. One tab per account+agent holds a short renewable lease and sweeps; the
// others skip until it expires (tab closed). Without usable storage this falls back to sweeping.
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
// 8 s, 16 s, 32 s ... capped at 5 min.
function nextSweepDelay(failures) { return Math.min(PENDING_SWEEP_MS * 2 ** Math.max(0, failures - 1), SWEEP_BACKOFF_CAP_MS); }
// What the agent could have changed to make a retry succeed; if it changes, retry immediately.
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
    // The focused chat has its own tight poll -- unless that poll is paused because the widget is hidden.
    if (chatId === currentChatId && !document.hidden) continue;
    if (!saved || saved.logged) continue;
    // Two LiveChat accounts share this origin's incognito localStorage.
    // Never sweep or auto-record another account's pending chat.
    if (currentLiveChatAccount && saved.liveChatAccount !== currentLiveChatAccount) continue;
    // Another agent's case (shared browser) -- theirs to record, not ours.
    if (saved.caOwner && saved.caOwner !== selectedAgent) continue;
    // Adopt the persisted copy only if this tab has no live copy of its own
    // — never clobber an in-memory one that might be ahead of what was last
    // saved.
    if (!state[chatId]) { state[chatId] = saved; markStateSynced(chatId); }
    if (saved.chatOpen === false) {
      // While logging is paused, submitRecord would just no-op anyway (see
      // its own isLoggingPaused() check) -- skip calling it at all so a chat
      // that's permanently missing fields (or anything else that'll never
      // resolve on its own) doesn't keep re-attempting and re-logging every
      // sweep tick while the agent has deliberately paused recording.
      // Resumes retrying normally as soon as the agent is back on the Retention tab.
      if (isLoggingPaused()) continue;
      // A chat this agent never worked has nothing to retry (submitRecord would skip it anyway).
      const idle = state[chatId] || saved;
      // (With the LiveChat login on, a chat not yet checked goes to submitRecord, which asks LiveChat once.)
      if (!agentTouchedChat(idle) && !(AGENT_LOGIN_LIVE && agentWroteVerdict(idle) === undefined)) {
        if (idle.autoRecordError) idle.autoRecordError = ""; // flagged by an older version of this widget
        continue;
      }
      // Already known closed but never successfully recorded — the one-time
      // auto-record attempt that fired when checkChatStatus first detected
      // the close can still fail for reasons that have nothing to do with
      // whether the chat is open (a transient network blip, a momentary
      // Lark API error) and nothing used to retry it afterward — the chat
      // would just sit there needing the agent to notice the red "needs
      // attention" card and resubmit manually, easy to miss if they'd
      // already moved on. Retry the submit itself here instead of
      // checkChatStatus, which has nothing left to check once a chat's
      // open/closed status is already known.
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

// Every chat the CURRENT agent's own browser knows about that closed
// without ever being completed (missing Inquiry/Status/etc.) -- read
// straight from persisted state, not just whichever chat happens to be the
// currently-focused card (see sweepPendingChats' own header note on why
// that distinction matters: LiveChat's SDK only ever shows this widget one
// real chat at a time, so a case the agent already navigated away from
// would otherwise be invisible until they happened to reopen that exact
// conversation). Filtered to s.agentName === selectedAgent so a shared/
// kiosk browser used by multiple agents across shifts doesn't mix other
// agents' incomplete chats into this one's list.
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
      // Closed chats only open under /archives/{thread_id} -- the card key.
      chatUrl: s.chatUrl ? archiveUrlFor(chatId) : "",
      recordId: s.caRecordId || null,
    }));
}

// Look Up writes the chat link onto its new Lark row straight away, but the
// real link only resolves ~2s after a chat opens -- a Look Up done before
// that created the row without one. Fills it in once it's known, so every
// row (even one never completed) can be traced back to its chat.
const linkSaveInFlight = new Set(); // not persisted, so it can never get stuck
async function saveLinkToRecord(chatId) {
  const s = state[chatId];
  if (!s || !s.caRecordId || !s.chatUrl || s.caLinkSaved || s.logged || linkSaveInFlight.has(chatId)) return;
  if (!ownsCaseRecord(s)) return;
  const recordId = s.caRecordId;
  // This is called from the 2 s chat-status tick, so a failing save used to hit Lark every 2 s. Back off
  // (8 s, 16 s, ... cap 5 min) per record+link; a different record or link retries immediately.
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

// Local Needs Attention entries whose Lark row turned out to be filled in
// (recorded from another browser/tab) or removed -- stop flagging them, and
// stop this browser's sweep from retrying (and overwriting) them.
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
  } catch (_) { /* non-fatal */ }
  for (const [chatId, st] of Object.entries(state)) {
    if (st && ids.has(st.caRecordId) && !st.logged) {
      st.logged = true;
      st.autoRecordError = "";
      markStateSynced(chatId);
    }
  }
}

/* Rebuilding a card from Lark. Agents run LiveChat in incognito, so closing
   the window wipes every saved card. Look Up saves the chat link on the
   Lark row, so when a chat (live, or archived via Needs Attention's Open)
   shows up with no saved card here, this agent's rows for that chat are
   found by its thread id -- the SECOND id, the only part shared by the
   /chats/{chat_id}/{thread_id} link and the /archives/{thread_id} one --
   and put back on the card: newest row as the open case, earlier completed
   rows as its other cases. Only ever the selected agent's own rows. */
const larkRestoreTried = new Set(); // not persisted -- a reload may try again

// Records this browser just deleted (Unknown ticked, an empty case dropped, an empty row removed). Lark's search can keep
// returning a deleted row for a few seconds, which rebuilt a "Logged" card from a row that no longer existed. They are
// remembered in storage so a reload or another tab honours it too, and forgotten after an hour.
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
  } catch (_) { /* non-fatal */ }
}
function forgetDeletedRecord(recordId) {
  try {
    const all = readDeletedRecords();
    delete all[recordId];
    localStorage.setItem(DELETED_RECORDS_KEY, JSON.stringify(all));
  } catch (_) { /* non-fatal */ }
}
function isDeletedRecord(recordId) {
  return !!recordId && Object.prototype.hasOwnProperty.call(readDeletedRecords(), recordId);
}
// How long ago this browser deleted the record (Infinity when it did not).
function deletedRecordAgeMs(recordId) {
  const at = recordId ? Number(readDeletedRecords()[recordId]) : 0;
  return at ? Date.now() - at : Infinity;
}
// Lark's search lags a delete by seconds, not minutes: past this a row Lark still lists is real and must be shown.
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
    claimSecretManual: true, // keep what Lark has; don't auto-fill over it
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
    caOwner: selectedAgent, // lark-chat-records only returns this agent's own rows
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
    larkRestoreTried.delete(threadId); // let a later visit try again
    logDiagnostic("Couldn't check Lark for this chat's saved case: " + err.message, "warn");
    return false;
  }
  if (!records.length || agentAtRequest !== selectedAgent) return false;

  if (!state[threadId]) {
    ensureChatState({ chatId: threadId, customerName, link: "", isTelegram: false, groupName: "" });
  }
  const s = state[threadId];
  // Something already happened on this card meanwhile -- never overwrite it.
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

// Lark-side half of Needs Attention (see functions/lark-stale-records.js):
// Customer Approaching rows stamped with THIS agent's name that still have
// no Inquiry/Status -- found straight from Lark, so an unfinished case can't
// vanish just because the browser that started it forgot about it
// (incognito closed, cleared storage, another PC). Only ever the selected
// agent's own rows, never anyone else's.
// One unbatchable Lark search per widget per tick, so keep it slow (was 60 s). A lookup or a recording
// triggers its own refresh right away (scheduleNeedsAttentionRefresh), so this is only the safety net.
const STALE_POLL_MS = 240_000;
let staleRecords = [];
let needsAttentionRefreshTimer = null;

// Coalesces bursts from recording, storage events and panel opens into one
// request. This makes the badge feel immediate without adding a busy poll.
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

// The one-time crosscheck (functions/crosscheck.js): chats since 7 Oct that THIS agent wrote in and nobody ever recorded.
// Read once per widget start, after the LiveChat login, with one small request; the list lives in the Lark table
// "Unrecorded Chats" and is matched to the agent by their LiveChat email, so there is nothing to poll.
let unrecordedChats = [];
let unrecordedLoaded = false;
const UNRECORDED_SHOWN_MAX = 25;
const unrecordedResolving = new Set(); // not persisted
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
// Needs Attention's "Open" opens the chat in a NEW tab, where the widget starts at the same moment as the archive page: the
// archived chat arrives before the list has been read, so it looked "not on the list" and showed nothing. When the list
// arrives, look at the chat that is open now and give it its card.
function reopenArchivedFromList() {
  if (!liveWidget) return;
  let profile = null;
  try { profile = liveWidget.getCustomerProfile(); } catch (_) { return; }
  if (!profile || profile.source !== "archives" || !profile.chat || !profile.chat.id) return;
  const threadId = String(profile.chat.id);
  if (activeChats[0] && activeChats[0].chatId === threadId) return; // its card is already showing
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
  } catch (_) { /* non-fatal: the list simply stays as it was */ }
}
// Marks one chat Done (recorded here) or Ignored (written off) in Lark and takes it off the list.
async function resolveUnrecorded(threadId, status) {
  unrecordedChats = unrecordedChats.filter((chat) => chat.threadId !== threadId);
  renderNeedsAttentionPanel();
  if (unrecordedResolving.has(threadId)) return;
  unrecordedResolving.add(threadId);
  try { await postUnrecorded({ action: "resolve", threadId, status }); } catch (_) { /* the row stays Open and shows again next start */ }
}
// Writes off the whole backlog in one go: gone from the list at once, then Lark is told in small chunks until none are left.
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
  } catch (_) { /* the rows stay Open and show again next start */ }
}
// What is still left to show: not completed in this browser since, and a completed one is told to Lark once.
function getUnrecordedChats() {
  if (!unrecordedChats.length) return [];
  let persisted = {};
  try { persisted = loadPersistedState(); } catch (_) { /* non-fatal */ }
  const local = (threadId) => state[threadId] || persisted[threadId];
  return unrecordedChats.filter((chat) => {
    const s = local(chat.threadId);
    if (s && s.logged && (s.inquiry || []).length && s.status) { resolveUnrecorded(chat.threadId, "Done"); return false; }
    // Ticked "Unknown player" in this browser: nothing is meant to be recorded for it, so it is written off.
    if (s && s.isUnknown) { resolveUnrecorded(chat.threadId, "Ignored"); return false; }
    // Its card was opened here and is now flagged incomplete: it is already in the other part of the list.
    if (s && s.chatOpen === false && !s.logged && s.autoRecordError && s.agentName === selectedAgent) return false;
    return !(s && s.attentionIgnored);
  });
}

async function fetchStaleRecords() {
  if (!selectedAgent) { staleRecords = []; renderNeedsAttentionPanel(); return; }
  // Do not briefly mix both accounts while the first chat is still being
  // identified. setCurrentLiveChatAccount triggers this again immediately.
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
    if (agentAtRequest !== selectedAgent) return; // agent switched mid-request
    if (!data.ok) {
      logDiagnostic("Unfinished-records check failed: " + (data.error || "unknown error"), "error");
      return; // keep the last good list rather than blanking it
    }
    staleRecords = data.records || [];
    markResolvedElsewhere(data.resolvedIds || []);
  } catch (err) {
    logDiagnostic("Unfinished-records check failed: " + err.message, "error");
    return;
  }
  renderNeedsAttentionPanel();
}

// Rows the local list already covers (or that are still being worked on in
// a chat this browser has open) are left out, so nothing shows twice and an
// in-progress case isn't flagged.
function getStaleLarkRecords() {
  if (IS_EMBEDDED_APP && !currentLiveChatAccount) return [];
  let persisted = {};
  try { persisted = loadPersistedState(); } catch (_) { /* non-fatal */ }
  const localByRecord = new Map();
  for (const s of [...Object.values(persisted), ...Object.values(state)]) {
    if (s && s.caRecordId) localByRecord.set(s.caRecordId, s);
  }
  const shownLocally = new Set(getIncompleteChats().map((c) => c.recordId).filter(Boolean));
  return staleRecords
    .filter((r) => {
      if (currentLiveChatAccount && r.accountKey && r.accountKey !== currentLiveChatAccount) return false;
      if (shownLocally.has(r.recordId)) return false;
      if (deletedRecordAgeMs(r.recordId) < DELETED_RECORD_HIDE_MS) return false; // just removed here; Lark's search may not know yet
      const local = localByRecord.get(r.recordId);
      if (!local) return true;
      // Lark says this row has no Inquiry/Status, and Lark is the truth. Only these keep it off the list:
      if (local.attentionIgnored) return false;                                   // the agent wrote it off
      if (local.logged && (local.inquiry || []).length && local.status) return false; // completed here a moment ago; the poll is older
      return local.chatOpen === false;                                            // a chat still open is being worked on
      // (A card marked "logged" WITHOUT inquiry and status -- Unknown, a ghost restore -- no longer hides an incomplete row.)
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
    fetchStaleRecords(); // e.g. it got filled in meanwhile -- refresh the list
  }
  if (btn) btn.disabled = false;
  renderNeedsAttentionPanel();
}

// Permanently drops one chat out of the Needs Attention list AND stops it
// from ever being recorded -- for a case an agent has decided to write off
// rather than ever complete (unlike Unknown player, which skips logging
// from the start, this is for a chat that already tried and failed to
// auto-record). Also sets logged so sweepPendingChats' own retry loop
// (gated on !saved.logged) stops targeting it -- attentionIgnored alone
// only hid it from this list; the chat was still being silently retried
// every 8s forever underneath, and could still end up recorded later if
// the retry ever happened to succeed. Written straight into the persisted
// blob rather than through state+saveState(), since this tab may not have
// that chatId in memory at all if another tab is the one that logged it --
// going through saveState() would rebuild the whole storage key from just
// this tab's own state and silently drop everyone else's entries.
function ignoreAttention(chatId) {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_STORAGE_KEY) || "{}");
    if (raw[chatId]) {
      raw[chatId].attentionIgnored = true;
      raw[chatId].logged = true;
      raw[chatId]._savedAt = Date.now();
      localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(raw));
    }
  } catch (_) { /* non-fatal — e.g. private browsing blocking storage */ }
  // Mirror onto this tab's own in-memory copy too, if it has one, so this
  // tab's own periodic saveState() doesn't overwrite the flag back off.
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
  // A long backlog is not poured into a narrow sidebar: the newest are listed, the rest counted.
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
    if (chatStatusPollTick) chatStatusPollTick(); // one immediate chat-status check on becoming visible
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

// Updates load on the next manual refresh or when LiveChat recreates the widget.

// A new release may refresh only after all queue work, including cleanup, ends.
// Called right before an automatic update reload: persist this tab's cards so nothing typed or looked up is lost.
window.prepareForDeploymentRefresh = () => { try { saveState(); } catch (_) { /* the 10 s autosave already covers it */ } };

window.canRefreshForDeployment = () => {
  if (blastRunInProgress || Object.values(state).some(s => s?.lookupInFlight || s?.unclaimInFlight)) return false;
  // A Lark write that is still going (recording a chat, saving its link) must finish; an unsent typed username counts as work in progress.
  if (recordSubmitInFlight.size || linkSaveInFlight.size) return false;
  if (Object.values(state).some((s) => s && !s.logged && String(s.usernameDraft || "").trim())) return false;
  // A ticket being created, a bonus claim being written, ticket attachments chosen but not sent (they live in memory only
  // and would be lost), or a ticket form with typed input that has not been raised.
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
