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
let selectedAgent = localStorage.getItem(AGENT_KEY) || "";
let agentOptions = [];

async function fetchAgentOptions() {
  try {
    const res = await fetch("/.netlify/functions/lark-pic-list");
    const data = await res.json();
    if (data.ok) agentOptions = data.pics || [];
  } catch (_) { /* non-fatal — settings panel still shows text input fallback */ }
}

function saveAgent(name) {
  selectedAgent = name.trim();
  localStorage.setItem(AGENT_KEY, selectedAgent);
}

// Settings panel — overlaid on top of the widget, blocking interaction
// until an agent is chosen.
function openSettingsPanel() {
  document.getElementById("settingsOverlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "settingsOverlay";
  overlay.className = "settings-overlay";
  overlay.innerHTML = `
    <div class="settings-panel">
      <div class="settings-head">
        <span>⚙ Agent Settings</span>
        ${selectedAgent ? `<button class="settings-close" id="settingsClose">✕</button>` : ""}
      </div>
      <p class="settings-hint">Select your name before handling any case. This will be logged as the Agent Name for every record you submit.</p>
      ${agentOptions.length
        ? `<select class="input settings-select" id="agentSelect">
             <option value="">— choose your name —</option>
             ${agentOptions.map((a) => `<option value="${a}" ${a === selectedAgent ? "selected" : ""}>${a}</option>`).join("")}
           </select>`
        : `<input type="text" class="input settings-text" id="agentSelect" placeholder="Type your name (e.g. 96 Edwin)" value="${selectedAgent}" />`
      }
      <button class="submit-btn" id="settingsSave" style="margin-top:10px">Save &amp; Continue</button>

      <div class="settings-diagnostics">
        <div class="settings-diagnostics-head">Diagnostics</div>
        <div class="settings-diagnostics-list">${renderDiagnosticsLog()}</div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById("settingsSave").addEventListener("click", () => {
    const val = document.getElementById("agentSelect").value.trim();
    if (!val) { setStatus("Choose your name before continuing.", "error"); return; }
    saveAgent(val);
    overlay.remove();
    updateAgentBadge();
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

// Real bonus data lives as 5 columns on the same Customer Approaching base
// (not a separate table) — one per program. Each becomes its own ticket if
// it has a claimable value. Values like "1D No Bonus" render nothing.
const BONUS_PROGRAMS = [
  { key: "riskPlayer", label: "Risk Player" },
  { key: "topPnl", label: "Top 10 P&L - Test" },
  { key: "gracePeriod", label: "Grace Period 0.1" },
  { key: "ltvTest", label: "LTV - Test" },
  { key: "vipBooster", label: "12h VIP Deposit Booster" },
];
const NO_BONUS_PATTERN = /^\s*\d+D\s*No Bonus\s*$/i;

// One-line summary shown on a collapsed card — lets an agent glance across
// several queued chats without expanding each one. Priority order matches
// what's most actionable: a card needing attention should never be masked
// by a "Logged" badge from a stale render, etc.
function hasAnyBonus(chatId) {
  const r = state[chatId].matchedRow;
  if (!r) return false;
  if (BONUS_PROGRAMS.some((p) => isClaimableValue(r[p.key]))) return true;
  if (r.angPao && !isHiddenStatus(r.angPao.status)) return true;
  if (r.redeemCode && String(r.redeemCode.status || "").trim().toLowerCase() !== "claimed") return true;
  return false;
}

function getChatSummary(chatId) {
  const s = state[chatId];
  if (s.autoRecordError) return { text: "⚠︎ Needs attention", cls: "attention" };
  if (s.logged) return { text: "✓ Logged", cls: "done" };
  if (s.matchedRow === undefined) return { text: "Not looked up", cls: "neutral" };
  if (s.matchedRow === null) return { text: "No record found", cls: "neutral" };
  if (!s.matchedRow.nameCustomer) return { text: "Checking bonuses…", cls: "pending" };
  return hasAnyBonus(chatId) ? { text: "Bonuses ready", cls: "ready" } : { text: "No active bonuses", cls: "neutral" };
}

function isHiddenStatus(v) {
  const t = String(v || "").trim().toLowerCase();
  return t === "expired" || t === "claimed";
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
async function fetchBonusRow(username, brand, link, telegram, picName) {
  const res = await fetch("/.netlify/functions/lark-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, brand, link, telegram, picName }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Lookup failed");
  return { row: data.row, otherBrands: data.otherBrands || [], caRecordId: data.caRecordId, justCreated: data.justCreated };
}

// After lark-search.js creates the case row, Lark can take 15-30s on a big
// base to resolve its Lookup columns — well past what one Netlify function
// call can wait for. So we poll a lightweight status check every few seconds
// instead of blocking on a single long request. "Name customer" (itself a
// Lookup) becoming non-empty is the signal that this row's Lookups are done.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_INTERVAL_MS = 2500;
const POLL_MAX_ATTEMPTS = 20; // ~50s ceiling before giving up

async function pollForBonuses(chatId, recordId, card, onTick) {
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    await wait(POLL_INTERVAL_MS);
    let data;
    try {
      const res = await fetch("/.netlify/functions/lark-poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordId }),
      });
      data = await res.json();
    } catch (_) {
      continue; // transient network hiccup — keep polling
    }
    if (!data.ok) continue;

    const s = state[chatId];
    if (!s || s.caRecordId !== recordId) return; // chat moved on (new lookup started) — abandon this poll
    s.matchedRow = { ...s.matchedRow, ...data.row };
    onTick(attempt, data.ready);
    if (data.ready) return;
  }
}

const SAMPLE_CHATS = [
  { chatId: "c1", customerName: "VS96 VIP", link: "https://my.livechatinc.com/chats/c1", isTelegram: false, groupName: "VS96 Priority Support" },
  { chatId: "c2", customerName: "MAX39 Priority", link: "https://my.livechatinc.com/chats/c2", isTelegram: true, groupName: "MAX39 Priority Support" },
];

// Every LiveChat group is named "<BRAND><DIGITS> Priority Support".
// Lark's Brand lookup strips digits — "VS96 Priority Support" → "VS".
function deriveBrandFromGroup(groupName) {
  if (!groupName) return "";
  return groupName
    .replace(/\s*priority support\s*/i, "")
    .replace(/\d+/g, "")
    .trim();
}

// NOTE: this list is large and clearly still growing on the Lark side (the
// real table shows dozens of Inquiry tags). This is a snapshot for the demo —
// the real build should fetch these live from Lark's field metadata so new
// tags show up automatically without a redeploy.
const inquiryOptions = [
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
  "Maintenance", "Telegram Transition Message", "Unclear Inquiries", "Unsolved",
];

// Maps each bonus program to the closest Inquiry option — auto-selected
// the moment CS clicks Claim so they don't have to pick it manually.
const BONUS_INQUIRY_MAP = {
  riskPlayer: "Bonus Checking",
  topPnl: "TOP P&L",
  gracePeriod: "Grace Period",
  ltvTest: "TOP LTV",
  vipBooster: "12hour VIP Deposit Boost",
  angPao: "Ang Pao",
  redeemCode: "Redeem Code",
};

const statusOptions = ["Solved", "Unsolved", "Given", "Not given", "Activated"];

/* ============================================================
   RENDER
   ============================================================ */
const chatListEl = document.getElementById("chatList");
const statusEl = document.getElementById("statusBar");
const state = {}; // chatId -> { username, bonus, claimed, brand, inquiry, telegram, logged }
let hasAutoExpandedOnce = false; // see renderChats — only auto-expand a card on first load

// Shared by the initial render and every refresh so the "Select status…"
// placeholder always gets the same dim styling as Inquiry's real
// ::placeholder, instead of rendering at full text brightness.
function renderStatusDisplay(chatId) {
  const s = state[chatId];
  const empty = !s.status;
  return `<span class="status-value ${empty ? "placeholder" : ""}">${s.status || "Select status…"}</span><span class="status-caret">▾</span>`;
}

// Status is a custom dropdown (not a native <select>) so it matches
// Inquiry's look exactly — reuses the same .inquiry-option/-check styling,
// just single-select and with no search box (only 5 fixed options).
function renderStatusDropdown(chatId) {
  const s = state[chatId];
  return statusOptions.map((opt) => {
    const active = s.status === opt;
    return `
    <button type="button" class="inquiry-option ${active ? "active" : ""}" data-action="selectStatus" data-chat="${chatId}" data-value="${opt}">
      <span class="inquiry-option-check">${active ? "✓" : ""}</span>${opt}
    </button>`;
  }).join("");
}

function renderPlayerInfo(chatId) {
  const s = state[chatId];
  if (!s.matchedRow) return "";
  const r = s.matchedRow;
  // PIC shows the agent actually handling this case, not Lark's own PIC
  // field — that's a Person field defaulting to "Record Created By", which
  // is always the Retention Logger bot (every row is created by the app),
  // never the human agent, so showing it here was meaningless.
  return `
    <div class="player-info">
      <span><span class="pi-label">PIC</span> ${selectedAgent || "—"}</span>
      <span><span class="pi-label">Tier</span> ${r.tier}</span>
      <span><span class="pi-label">Name</span> ${r.nameCustomer}</span>
      <span><span class="pi-label">D.O.B</span> ${r.dob}</span>
    </div>`;
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

  BONUS_PROGRAMS.forEach((p) => {
    if (isClaimableValue(r[p.key])) {
      defs.push({ key: p.key, kind: "regular", label: p.label, display: r[p.key] });
    }
  });

  if (r.angPao && !isHiddenStatus(r.angPao.status)) {
    defs.push({ key: "angPao", kind: "special", label: "Ang Pao (Special Reload Event)", display: r.angPao.status });
  }

  if (r.redeemCode && String(r.redeemCode.status || "").trim().toLowerCase() !== "claimed") {
    defs.push({ key: "redeemCode", kind: "special", label: "Redeem Code", display: r.redeemCode.status, isCode: true });
  }

  if (!defs.length) {
    return `<div class="ticket empty">No active bonuses for this player right now</div>`;
  }

  // Only one bonus can be claimed per case — once any is claimed, the rest lock.
  const alreadyClaimedOne = Object.values(s.claimedPrograms).some(Boolean);
  return `<div class="ticket-stack">` + defs.map((d) => {
    const claimed = !!s.claimedPrograms[d.key];
    const locked = alreadyClaimedOne && !claimed;
    return `
    <div class="ticket ${d.kind === "special" ? "ticket-special" : ""} ${locked ? "locked" : ""}">
      <div class="ticket-icon">◆</div>
      <div class="ticket-body">
        <div class="ticket-name">${d.label}</div>
        <div class="ticket-meta ${d.isCode ? "mono code" : ""}">${d.display}</div>
      </div>
      <button class="claim-btn ${d.kind === "special" ? "special" : ""} ${claimed ? "claimed" : ""}" data-action="claim" data-program="${d.key}" data-chat="${chatId}" ${claimed || locked ? "disabled" : ""}>
        ${claimed ? "✓ Claimed" : "Claim"}
      </button>
    </div>`;
  }).join("") + `</div>` + (alreadyClaimedOne ? `<div class="ticket-note">Only 1 bonus can be claimed per case</div>` : "");
}

// Inquiry is a searchable dropdown + chip list instead of a big always-open
// tag grid — same 70+ option list, same max-2 / Feedback-pairing rule, just
// collapsed behind a search box so the card stays short until it's used.
function renderInquiryChips(chatId) {
  const s = state[chatId];
  if (!s.inquiry.length) return `<span class="inquiry-chips-empty">No inquiry selected</span>`;
  return s.inquiry.map((v) => `
    <span class="inquiry-chip">${v}<button type="button" class="inquiry-chip-remove" data-action="removeInquiry" data-chat="${chatId}" data-value="${v}" aria-label="Remove ${v}">✕</button></span>
  `).join("");
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
  // Read the Brand box's current DOM value (if it already exists) rather
  // than always falling back to state — renderAutoFields() re-renders this
  // slot on every lookup/claim, and state.brand is only synced from the
  // input at submit time, so blindly using state.brand here would silently
  // discard an in-progress manual correction the agent typed.
  const existingCard = chatListEl.querySelector(`.chat-card[data-chat-id="${chatId}"]`);
  const currentBrand = existingCard?.querySelector(".brand-input")?.value ?? s.brand;
  return `
    <div class="auto-grid">
      <div class="auto-field">
        <span class="field-label" style="margin:0">Brand <span class="auto-tag">auto</span></span>
        <input type="text" class="input mono brand-input" value="${currentBrand}" placeholder="Brand" />
      </div>
      <div class="auto-field">
        <span class="field-label" style="margin:0">Released Amount <span class="auto-tag">auto</span></span>
        <div class="auto-value mono">${s.releasedBonusAmount || "—"}</div>
      </div>
      <div class="auto-field">
        <span class="field-label" style="margin:0">Claim Secret <span class="auto-tag">auto</span></span>
        <div class="auto-value">${s.claimSecret ? "✓ Ticked" : "— Not ticked"}</div>
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
      <a class="chat-link" href="${chat.link}" target="_blank">Open ↗</a>
      ${!s.logged ? `
      <button class="chat-close-btn" data-action="closeChat" data-chat="${chat.chatId}" ${!s.chatOpen ? "disabled" : ""}
        title="Simulates the LiveChat 'chat closed' event, until the real widget SDK is wired up">
        ${s.chatOpen ? "Close chat (sim)" : "Closed"}
      </button>` : ""}
      <button class="expand-btn" data-action="toggleExpand" data-chat="${chat.chatId}" title="Expand">▾</button>
    </div>
  `;
}

function renderExpandedCard(chat) {
  const s = state[chat.chatId];
  return `
    <div class="chat-card-head">
      <span class="chat-name">${chat.customerName}</span>
      <div class="chat-card-head-actions">
        <a class="chat-link" href="${chat.link}" target="_blank">Open ↗</a>
        ${!s.logged ? `
        <button class="chat-close-btn" data-action="closeChat" data-chat="${chat.chatId}" ${!s.chatOpen ? "disabled" : ""}
          title="Simulates the LiveChat 'chat closed' event, until the real widget SDK is wired up">
          ${s.chatOpen ? "Close chat (sim)" : "Closed"}
        </button>` : ""}
        <button class="expand-btn expanded" data-action="toggleExpand" data-chat="${chat.chatId}" title="Collapse">▴</button>
      </div>
    </div>

    <label class="field-label">Username</label>
    <div class="username-row">
      <input type="text" class="input mono username-input" placeholder="Player username / UID" value="${s.username}" />
      <button class="lookup-btn" data-action="lookup" data-chat="${chat.chatId}">Look up</button>
    </div>

    <div class="player-info-slot">${renderPlayerInfo(chat.chatId)}</div>
    <div class="ticket-slot">${renderTickets(chat.chatId)}</div>
    <div class="auto-fields-slot">${renderAutoFields(chat.chatId)}</div>

    <label class="field-label">Inquiry <span class="hint">(select up to 2 — search to filter)</span></label>
    <div class="inquiry-select">
      <div class="inquiry-chips">${renderInquiryChips(chat.chatId)}</div>
      <input type="text" class="input inquiry-search" placeholder="Search inquiry…" autocomplete="off" />
      <div class="inquiry-dropdown hidden">${renderInquiryDropdown(chat.chatId, "")}</div>
    </div>

    <label class="field-label">Status</label>
    <div class="status-picker">
      <button type="button" class="input status-display" data-action="toggleStatusDropdown" data-chat="${chat.chatId}">
        ${renderStatusDisplay(chat.chatId)}
      </button>
      <div class="status-dropdown hidden">${renderStatusDropdown(chat.chatId)}</div>
    </div>

    <div class="toggle-row">
      <label class="field-label">Telegram chat <span class="auto-tag">auto</span></label>
      <label class="switch">
        <input type="checkbox" class="tg-check" ${s.telegram ? "checked" : ""} disabled />
        <span class="slider"></span>
      </label>
    </div>

    ${s.autoRecordError ? `<div class="record-error-banner">⚠︎ ${s.autoRecordError}</div>` : ""}

    ${
      s.logged
        ? `<div class="logged-badge">✓ Logged to Lark Base</div>`
        : s.chatOpen
          ? `<div class="record-pending-hint">Recording happens automatically once this chat closes</div>`
          : `<button class="submit-btn" data-action="submit" data-chat="${chat.chatId}">Record to Lark Base</button>`
    }
  `;
}

function renderChats(chats) {
  chatListEl.innerHTML = "";

  if (!chats.length) {
    chatListEl.innerHTML = `<div class="empty-state">No active chats detected right now. Open a chat and hit refresh.</div>`;
    return;
  }

  // Pass 1: make sure every chat has state before deciding defaults below —
  // the "expand the first chat" default needs to see the whole list.
  for (const chat of chats) {
    if (!state[chat.chatId]) {
      state[chat.chatId] = {
        username: "", matchedRow: undefined, otherBrandMatches: [], caRecordId: null, claimedPrograms: {},
        brand: deriveBrandFromGroup(chat.groupName),
        inquiry: [], status: "", telegram: chat.isTelegram, logged: false,
        releasedBonusAmount: "", releasedAmountRaw: "", claimSecret: false,
        // chatOpen mirrors the LiveChat conversation's open/closed state.
        // Recording only happens once a chat closes (auto if everything's
        // filled in, or a manual nudge if not) — see closeChat/submitRecord.
        chatOpen: true, autoRecordError: "",
        // Collapsed by default — a card only expands to full detail when the
        // agent clicks it (see toggleExpand). Keeps up to 6 concurrent chats
        // glanceable instead of only ~2 fitting on screen at once.
        expanded: false,
      };
    }
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

    const card = document.createElement("div");
    // Whole-card red highlight when a chat closed incomplete — meant to be
    // impossible to miss even at a glance across 6 concurrent chats, not
    // just a small line of text at the bottom.
    card.className = "chat-card"
      + (s.autoRecordError ? " needs-attention" : "")
      + (s.expanded ? "" : " collapsed");
    card.dataset.chatId = chat.chatId;
    card.innerHTML = s.expanded ? renderExpandedCard(chat) : renderCollapsedCard(chat);

    chatListEl.appendChild(card);
  }
}

/* ============================================================
   EVENTS (delegated — cards re-render often)
   ============================================================ */
chatListEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const chatId = btn.dataset.chat;
  const card = btn.closest(".chat-card");
  const s = state[chatId];

  if (btn.dataset.action === "lookup") {
    if (!selectedAgent) { openSettingsPanel(); return; }
    const username = card.querySelector(".username-input").value.trim();
    if (!username) { setStatus("Enter a username before looking up.", "error"); return; }
    const brand = card.querySelector(".brand-input").value.trim();
    if (!brand) { setStatus("Brand couldn't be detected — check it before looking up.", "error"); return; }
    s.username = username;
    const chatDef = SAMPLE_CHATS.find((c) => c.chatId === chatId);
    const telegramNow = card.querySelector(".tg-check").checked;
    btn.disabled = true;
    btn.textContent = "…";
    try {
      const { row, otherBrands, caRecordId, justCreated } = await fetchBonusRow(username, brand, chatDef?.link || "", telegramNow, selectedAgent);
      s.matchedRow = row;
      s.otherBrandMatches = otherBrands;
      s.caRecordId = caRecordId;
      s.claimedPrograms = {};
      s.releasedBonusAmount = "";
      s.releasedAmountRaw = "";
      s.claimSecret = false;
      card.querySelector(".ticket-slot").innerHTML = `<div class="ticket empty">Checking bonuses — can take up to ~50s on a big base…</div>`;
      card.querySelector(".auto-fields-slot").innerHTML = renderAutoFields(chatId);

      if (justCreated) {
        // Keep the button disabled for the whole poll — this is what stops a
        // second click from creating a duplicate case row while Lark is
        // still resolving the first one.
        btn.textContent = "Checking…";
        setStatus(`Logged ${username} under ${brand} — checking bonuses…`);
        await pollForBonuses(chatId, caRecordId, card, (attempt, ready) => {
          card.querySelector(".player-info-slot").innerHTML = renderPlayerInfo(chatId);
          if (ready) {
            card.querySelector(".ticket-slot").innerHTML = renderTickets(chatId);
          } else {
            setStatus(`Logged ${username} under ${brand} — still checking bonuses (${attempt * (POLL_INTERVAL_MS / 1000)}s)…`);
          }
        });
        setStatus(
          state[chatId].matchedRow.nameCustomer
            ? `Bonuses ready for ${username} under ${brand}.`
            : `Still resolving after ~${POLL_MAX_ATTEMPTS * (POLL_INTERVAL_MS / 1000)}s — hit Look up again if it doesn't settle, or check the row directly in Lark.`,
          state[chatId].matchedRow.nameCustomer ? "success" : "error"
        );
      } else {
        setStatus(row ? `Found ${username} under ${brand}.` : "No record found.");
      }
    } catch (err) {
      setStatus("Lookup failed: " + err.message, "error");
    }
    btn.disabled = false;
    btn.textContent = "Look up";
    card.querySelector(".player-info-slot").innerHTML = renderPlayerInfo(chatId);
    card.querySelector(".ticket-slot").innerHTML = renderTickets(chatId);
    card.querySelector(".auto-fields-slot").innerHTML = renderAutoFields(chatId);
  }

  if (btn.dataset.action === "claim") {
    const programKey = btn.dataset.program;
    const r = s.matchedRow;

    // Ang Pao / Redeem Code write live to Lark the instant they're claimed —
    // that's what fires the backoffice-approval workflow. Regular (gold)
    // tickets are read-only lookup columns; they're only logged at submit.
    if (programKey === "angPao" || programKey === "redeemCode") {
      const source = r[programKey];
      const chatDef = SAMPLE_CHATS.find((c) => c.chatId === chatId);
      btn.disabled = true;
      btn.textContent = "…";
      try {
        const res = await fetch("/.netlify/functions/lark-claim", {
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
      }
    }

    s.claimedPrograms[programKey] = true;
    const allSources = [
      ...BONUS_PROGRAMS.map((p) => ({ key: p.key, label: p.label, display: r[p.key] })),
      { key: "angPao", label: "Ang Pao (Special Reload Event)", display: r.angPao?.status },
      { key: "redeemCode", label: "Redeem Code", display: r.redeemCode?.status },
    ];
    const claimedSources = allSources.filter((src) => s.claimedPrograms[src.key]);
    s.releasedBonusAmount = claimedSources.map((src) => `${src.label}: ${src.display}`).join(" | ");
    // Raw display text only (no label prefix) for the backend to pull a
    // number out of — labels like "Top 10 P&L - Test" contain digits of
    // their own, so parsing the combined string above would grab the wrong
    // number. Only one bonus can be claimed per case, so this is just that
    // one entry's display value.
    s.releasedAmountRaw = claimedSources.map((src) => src.display).join(" | ");
    s.claimSecret = true;

    // Auto-set inquiry from the bonus type — only the matching inquiry tag,
    // NOT "Feedback". CS adds Feedback manually if applicable.
    const mappedInquiry = BONUS_INQUIRY_MAP[programKey];
    if (mappedInquiry) {
      s.inquiry = [mappedInquiry];
    }

    // Status auto-sets to "Given" the moment any bonus is claimed.
    s.status = "Given";

    card.querySelector(".ticket-slot").innerHTML = renderTickets(chatId);
    card.querySelector(".auto-fields-slot").innerHTML = renderAutoFields(chatId);
    card.querySelector(".inquiry-chips").innerHTML = renderInquiryChips(chatId);
    card.querySelector(".inquiry-dropdown").innerHTML = renderInquiryDropdown(chatId, "");
    card.querySelector(".status-display").innerHTML = renderStatusDisplay(chatId);
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
    const searchInput = card.querySelector(".inquiry-search");
    card.querySelector(".inquiry-chips").innerHTML = renderInquiryChips(chatId);
    card.querySelector(".inquiry-dropdown").innerHTML = renderInquiryDropdown(chatId, searchInput ? searchInput.value : "");
    // Auto-close once maxed out — nothing left to add without removing a
    // chip first, and removing happens via the chips row, not the dropdown.
    if (s.inquiry.length >= 2) card.querySelector(".inquiry-dropdown").classList.add("hidden");
  }

  if (btn.dataset.action === "submit") {
    await submitRecord(chatId, { auto: false });
  }

  if (btn.dataset.action === "closeChat") {
    // TODO: once the LiveChat Agent App SDK is wired up (currently blocked —
    // see project notes), replace this manual button with the real
    // "chat closed" event listener and run these same three lines from
    // there instead of a click.
    s.chatOpen = false;
    renderChats(SAMPLE_CHATS);
    await submitRecord(chatId, { auto: true });
  }

  if (btn.dataset.action === "toggleExpand") {
    const wasExpanded = s.expanded;
    // Accordion — only one full card open at a time, so the rest stay
    // collapsed and glanceable instead of the list growing unbounded.
    Object.values(state).forEach((st) => { st.expanded = false; });
    s.expanded = !wasExpanded;
    renderChats(SAMPLE_CHATS);
  }

  if (btn.dataset.action === "toggleStatusDropdown") {
    const dropdown = card.querySelector(".status-dropdown");
    const willOpen = dropdown.classList.contains("hidden");
    // Only one dropdown open at a time across the whole widget.
    document.querySelectorAll(".inquiry-dropdown, .status-dropdown").forEach((d) => d.classList.add("hidden"));
    if (willOpen) dropdown.classList.remove("hidden");
  }

  if (btn.dataset.action === "selectStatus") {
    s.status = btn.dataset.value;
    card.querySelector(".status-display").innerHTML = renderStatusDisplay(chatId);
    card.querySelector(".status-dropdown").innerHTML = renderStatusDropdown(chatId);
    card.querySelector(".status-dropdown").classList.add("hidden");
  }
});

// Inquiry dropdown: open on focus, filter as the agent types, close when
// they click anywhere outside the widget (so a click on a dropdown option,
// which lives inside .inquiry-select, never closes it prematurely).
chatListEl.addEventListener("focusin", (e) => {
  const input = e.target.closest(".inquiry-search");
  if (!input) return;
  document.querySelectorAll(".status-dropdown").forEach((d) => d.classList.add("hidden"));
  input.closest(".inquiry-select")?.querySelector(".inquiry-dropdown")?.classList.remove("hidden");
});

chatListEl.addEventListener("input", (e) => {
  const input = e.target.closest(".inquiry-search");
  if (!input) return;
  const card = input.closest(".chat-card");
  const chatId = card.dataset.chatId;
  card.querySelector(".inquiry-dropdown").innerHTML = renderInquiryDropdown(chatId, input.value);
});

document.addEventListener("click", (e) => {
  document.querySelectorAll(".inquiry-select, .status-picker").forEach((wrap) => {
    if (!wrap.contains(e.target)) wrap.querySelector(".inquiry-dropdown, .status-dropdown")?.classList.add("hidden");
  });
});

// Shared by the manual "Record to Lark Base" button and the auto-record
// triggered when a chat closes. Pulls Brand/Status straight from the DOM
// since the agent may have edited them after the card was last rendered.
// Always re-queries the card by chatId rather than taking a DOM reference,
// since renderChats() can have rebuilt the card (e.g. right before an
// auto-record call) and made any earlier reference stale.
async function submitRecord(chatId, { auto } = {}) {
  const s = state[chatId];
  if (!s || s.logged) return;
  const card = chatListEl.querySelector(`.chat-card[data-chat-id="${chatId}"]`);

  if (!selectedAgent) {
    if (auto) {
      s.autoRecordError = "Chat closed, but no agent name is set — open Settings (⚙), then fill in and record manually.";
      logDiagnostic(s.autoRecordError, "error");
      renderChats(SAMPLE_CHATS);
    } else {
      setStatus("Set your agent name in Settings (⚙) before recording.", "error");
      openSettingsPanel();
    }
    return;
  }

  const brand = (card?.querySelector(".brand-input")?.value ?? s.brand ?? "").trim();
  // Unlike Brand (free text, only synced to state at submit time), Status is
  // a discrete pick that's written to state the instant it's clicked in the
  // custom dropdown, so state is always the source of truth here already.
  const status = s.status || "";
  s.brand = brand;

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
      s.autoRecordError = `Chat closed but not fully filled in (missing: ${missing.join(", ")}) — complete it and click Record to Lark Base.`;
      logDiagnostic(s.autoRecordError, "error");
      renderChats(SAMPLE_CHATS);
    } else {
      setStatus(`Missing before recording: ${missing.join(", ")}.`, "error");
    }
    return;
  }

  s.autoRecordError = "";
  const submitBtn = card?.querySelector('button[data-action="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Recording…"; }

  try {
    const res = await fetch("/.netlify/functions/lark-record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recordId: s.caRecordId,
        agentName: selectedAgent,
        brand: s.brand,
        inquiry: s.inquiry,
        status: s.status,
        releasedAmount: s.releasedBonusAmount,
        releasedAmountRaw: s.releasedAmountRaw,
        claimSecret: s.claimSecret,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Record failed");
    s.logged = true;
    setStatus(`Logged ${s.username} to Lark Base${auto ? " (auto, on chat close)" : ""}.`, "success");
    renderChats(SAMPLE_CHATS);
  } catch (err) {
    if (auto) {
      s.autoRecordError = `Auto-record failed (${err.message}) — fill in and click Record to Lark Base manually.`;
      logDiagnostic(s.autoRecordError, "error");
      renderChats(SAMPLE_CHATS);
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

document.getElementById("refreshBtn").addEventListener("click", () => {
  setStatus("Preview mode — showing sample chats until connected to LiveChat.");
  renderChats(SAMPLE_CHATS);
});
document.getElementById("settingsBtn").addEventListener("click", () => openSettingsPanel());

// Boot sequence: fetch agent list, update badge, auto-open settings if no
// agent saved yet (first time / cleared cache).
(async () => {
  logDiagnostic("Preview mode — showing sample chats until connected to LiveChat.");
  await fetchAgentOptions();
  updateAgentBadge();
  if (!selectedAgent) openSettingsPanel();
  renderChats(SAMPLE_CHATS);
})();
