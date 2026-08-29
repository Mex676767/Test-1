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

// Fallback only — used until (or unless) the real LiveChat Agent App SDK
// connects. See initLiveChatSdk() below.
const SAMPLE_CHATS = [
  { chatId: "c1", customerName: "VS96 VIP", link: "https://my.livechatinc.com/chats/c1", isTelegram: false, groupName: "VS96 Priority Support" },
  { chatId: "c2", customerName: "MAX39 Priority", link: "https://my.livechatinc.com/chats/c2", isTelegram: true, groupName: "MAX39 Priority Support" },
];

// The list renderChats() actually draws from. Starts as the demo data;
// initLiveChatSdk() replaces it with the one real active chat once (if) the
// SDK connects. Kept as a list (not a single object) so renderChats/state
// keying by chatId didn't need to change shape for this swap.
let activeChats = SAMPLE_CHATS;

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

// Set once the SDK actually connects — lets the Refresh button re-sync
// against the real widget on demand instead of always claiming "preview
// mode", which stopped being accurate the moment live mode existed.
let liveWidget = null;

// Top-level (not nested in initLiveChatSdk's closure) so the Refresh button
// can also call this directly for a manual re-sync.
function applyProfile(profile) {
  if (!profile || !profile.chat || !profile.chat.id) {
    stopChatStatusPolling();
    activeChats = [];
    renderChats(activeChats);
    return;
  }
  const chat = chatFromProfile(profile);
  activeChats = [chat];
  // In live mode there's only ever one chat shown at a time, so a newly-
  // active chat should always render expanded — collapsing exists to save
  // space among several chats, which doesn't apply here.
  ensureChatState(chat);
  state[chat.chatId].expanded = true;
  renderChats(activeChats);
  resolveBrandFromGroupId(chat.chatId, profile.chat.groupID);
  startChatStatusPolling(chat.chatId);
}

// The SDK only gives us an opaque groupID (chatFromProfile leaves groupName
// blank), so this resolves it server-side via LiveChat's own Groups API
// (see livechat-group-name.js — no LiveChat PAT configured just means this
// quietly does nothing) and runs the real name through the same
// deriveBrandFromGroup() the old demo data used.
async function resolveBrandFromGroupId(chatId, groupID) {
  if (!groupID) return;
  try {
    const res = await fetch("/.netlify/functions/livechat-group-name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupID }),
    });
    const data = await res.json();
    if (!data.ok || !data.groupName) return;
    const s = state[chatId];
    // Bail if the agent already picked a brand manually, or the chat moved
    // on before this (network-latency) response arrived.
    if (!s || s.brand) return;
    s.brand = deriveBrandFromGroup(data.groupName);
    logDiagnostic(`Auto-detected brand "${s.brand}" from group "${data.groupName}".`);
    if (activeChats[0]?.chatId === chatId) renderChats(activeChats);
  } catch (_) { /* non-fatal — Brand just stays a manual pick */ }
}

// Polls LiveChat's Agent Chat API (via livechat-chat-status.js) for the
// currently active chat's Telegram/open-closed status — there's no push
// event for either (confirmed for Telegram from the SDK's own types;
// confirmed for chat-closed from the SDK having no such event at all), so
// this is the only way to detect them short of a full webhook integration.
// Manual fallbacks (the Telegram toggle, the Close chat button) stay fully
// functional alongside this — the field paths this reads are best-effort
// from docs, not yet verified against a real response.
let chatStatusPollTimer = null;
const CHAT_STATUS_POLL_MS = 2_000; // worst-case detection latency = this value; avg = half of it
const rawStatusDebugLoggedFor = new Set(); // avoid re-logging the same raw payload every tick
const firstCheckLoggedFor = new Set(); // one confirmation per chat that get_chat succeeded at all
const errorLoggedFor = new Set(); // avoid spamming the same persistent error every 20s

function stopChatStatusPolling() {
  if (chatStatusPollTimer) {
    clearInterval(chatStatusPollTimer);
    chatStatusPollTimer = null;
  }
}

function startChatStatusPolling(chatId) {
  stopChatStatusPolling();
  checkChatStatus(chatId); // don't wait for the first interval tick
  chatStatusPollTimer = setInterval(() => checkChatStatus(chatId), CHAT_STATUS_POLL_MS);
}

async function checkChatStatus(chatId) {
  const s = state[chatId];
  // Stop polling once this chat isn't the active one anymore, or it's
  // already closed/recorded — nothing left to detect.
  if (!s || activeChats[0]?.chatId !== chatId || !s.chatOpen || s.logged) {
    stopChatStatusPolling();
    return;
  }
  try {
    const res = await fetch("/.netlify/functions/livechat-chat-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId }),
    });
    const data = await res.json();
    if (!data.ok) return;

    // chatId here is actually the thread id (see livechat-chat-status.js
    // header note) — the backend resolves the real chat id via list_chats
    // and hands back a ready-to-click chatUrl once it does. Logged wherever
    // available so the agent can cross-check against LiveChat's own UI.
    const linkSuffix = data.chatUrl ? ` (${data.chatUrl})` : ` (thread ${chatId}, chat id not yet resolved)`;

    // Feeds back into activeChats[].link — the same field the "Open ↗"
    // button reads and that gets sent as "Live Chat Link" to Lark on claim
    // (lark-claim.js). Previously always "" (chatFromProfile has no way to
    // get a permalink from the SDK alone), so that Lark field and the Open
    // button were both silently blank for every real chat until now.
    if (data.chatUrl) {
      const chatEntry = activeChats.find((c) => c.chatId === chatId);
      if (chatEntry && chatEntry.link !== data.chatUrl) {
        chatEntry.link = data.chatUrl;
        if (activeChats[0]?.chatId === chatId) renderChats(activeChats);
      }
    }

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
      // likely misconfiguration (LIVECHAT_PAT missing on this Netlify site).
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

    if (typeof data.isTelegram === "boolean" && data.isTelegram !== s.telegram) {
      s.telegram = data.isTelegram;
      logDiagnostic(`Auto-detected Telegram chat = ${data.isTelegram}.${linkSuffix}`);
      if (activeChats[0]?.chatId === chatId) renderChats(activeChats);
    } else if (data.isActive === null && !rawStatusDebugLoggedFor.has(chatId)) {
      // Expected fields weren't found — surface the raw response once so
      // the field paths can be corrected against real data.
      rawStatusDebugLoggedFor.add(chatId);
      logDiagnostic("Chat status fields not recognized — raw: " + JSON.stringify(data.raw ?? null).slice(0, 500), "warn");
    }

    if (data.isActive === false && s.chatOpen) {
      logDiagnostic(`Auto-detected chat closed — auto-recording.${linkSuffix}`, "success");
      stopChatStatusPolling();
      s.chatOpen = false;
      renderChats(activeChats);
      await submitRecord(chatId, { auto: true });
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

// Every LiveChat group is named "<BRAND><DIGITS> Priority Support".
// Lark's Brand lookup strips digits — "VS96 Priority Support" → "VS".
function deriveBrandFromGroup(groupName) {
  if (!groupName) return "";
  return groupName
    .replace(/\s*priority support\s*/i, "")
    .replace(/\d+/g, "")
    // Strips emoji (e.g. the flag LiveChat group names wrap the brand code
    // in) — Extended_Pictographic covers most emoji, Regional_Indicator
    // covers flag pairs specifically (flags aren't pictographic symbols),
    // ️/‍ are the variation selector/ZWJ used to combine glyphs.
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D]/gu, "")
    .replace(/\s+/g, " ")
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

// Brand is fully auto-detected now (resolveBrandFromGroupId, via LiveChat's
// Groups API) — back to a plain read-only box like Released Amount/Claim
// Secret, no manual picker. If detection ever fails (PAT not configured,
// API error, unrecognized group), this just shows "—" with no way to set
// it from the UI — see submitRecord's validation, which still requires it.
function renderAutoFields(chatId) {
  const s = state[chatId];
  return `
    <div class="auto-grid">
      <div class="auto-field">
        <span class="field-label" style="margin:0">Brand <span class="auto-tag">auto</span></span>
        <div class="auto-value mono">${s.brand || "—"}</div>
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
      ${chat.link ? `<a class="chat-link" href="${chat.link}" target="_blank">Open ↗</a>` : ""}
      ${!s.logged ? `
      <button class="chat-close-btn" data-action="closeChat" data-chat="${chat.chatId}" ${!s.chatOpen ? "disabled" : ""}
        title="Marks this case done — records it if everything's filled in, or flags what's missing">
        ${s.chatOpen ? "Close chat" : "Closed"}
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
        ${chat.link ? `<a class="chat-link" href="${chat.link}" target="_blank">Open ↗</a>` : ""}
        ${!s.logged ? `
        <button class="chat-close-btn" data-action="closeChat" data-chat="${chat.chatId}" ${!s.chatOpen ? "disabled" : ""}
          title="Marks this case done — records it if everything's filled in, or flags what's missing">
          ${s.chatOpen ? "Close chat" : "Closed"}
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
      <div class="inquiry-search-wrap">
        <input type="text" class="input inquiry-search" placeholder="Search inquiry…" autocomplete="off" />
        <span class="inquiry-caret">▾</span>
      </div>
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
        <input type="checkbox" class="tg-check" data-chat="${chat.chatId}" ${s.telegram ? "checked" : ""} disabled />
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

// Full default state shape for a chat we haven't seen before. Factored out
// so applyProfile() (live SDK mode) can ensure a new chat's state exists
// with every required field before forcing it expanded, rather than
// renderChats()'s own init pass silently skipping a partially-built object.
function ensureChatState(chat) {
  if (state[chat.chatId]) return;
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

function renderChats(chats) {
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
    const brand = s.brand;
    if (!brand) { setStatus("Brand hasn't been auto-detected yet for this chat — try again in a moment.", "error"); return; }
    s.username = username;
    const chatDef = activeChats.find((c) => c.chatId === chatId);
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
      const chatDef = activeChats.find((c) => c.chatId === chatId);
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
    // TODO: the Agent App SDK has no "chat closed" event (confirmed from its
    // own type definitions) — this manual click is the real trigger for now.
    // A future companion content script (bridging richer page data into this
    // widget — see project notes) could detect the "This chat has been
    // archived" banner and call these same three lines automatically.
    s.chatOpen = false;
    renderChats(activeChats);
    await submitRecord(chatId, { auto: true });
  }

  if (btn.dataset.action === "toggleExpand") {
    const wasExpanded = s.expanded;
    // Accordion — only one full card open at a time, so the rest stay
    // collapsed and glanceable instead of the list growing unbounded.
    Object.values(state).forEach((st) => { st.expanded = false; });
    s.expanded = !wasExpanded;
    renderChats(activeChats);
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

// Inquiry search box: filter as the agent types.
chatListEl.addEventListener("input", (e) => {
  const inquiryInput = e.target.closest(".inquiry-search");
  if (!inquiryInput) return;
  const card = inquiryInput.closest(".chat-card");
  card.querySelector(".inquiry-dropdown").innerHTML = renderInquiryDropdown(card.dataset.chatId, inquiryInput.value);
});

// Inquiry dropdown opens on focus (it has no explicit toggle button, unlike
// Status); closes whatever else is open first so only one shows at a time
// across the whole widget.
chatListEl.addEventListener("focusin", (e) => {
  const input = e.target.closest(".inquiry-search");
  if (!input) return;
  document.querySelectorAll(".status-dropdown").forEach((d) => d.classList.add("hidden"));
  input.closest(".inquiry-select")?.querySelector(".inquiry-dropdown")?.classList.remove("hidden");
});

// Click anywhere outside a given dropdown's own wrapper closes it — so a
// click on one of its own options, which lives inside that same wrapper,
// never closes it prematurely.
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
      renderChats(activeChats);
    } else {
      setStatus("Set your agent name in Settings (⚙) before recording.", "error");
      openSettingsPanel();
    }
    return;
  }

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
      s.autoRecordError = `Chat closed but not fully filled in (missing: ${missing.join(", ")}) — complete it and click Record to Lark Base.`;
      logDiagnostic(s.autoRecordError, "error");
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
        chatLink: activeChats.find((c) => c.chatId === chatId)?.link || "",
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Record failed");
    s.logged = true;
    setStatus(`Logged ${s.username} to Lark Base${auto ? " (auto, on chat close)" : ""}.`, "success");
    renderChats(activeChats);
  } catch (err) {
    if (auto) {
      s.autoRecordError = `Auto-record failed (${err.message}) — fill in and click Record to Lark Base manually.`;
      logDiagnostic(s.autoRecordError, "error");
      renderChats(activeChats);
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
  if (liveWidget) {
    // Live mode — re-sync against the SDK on demand rather than just
    // re-rendering whatever we already had (which could be stale if a
    // customer_profile event was somehow missed).
    applyProfile(liveWidget.getCustomerProfile());
    setStatus("Refreshed from LiveChat.", "success");
  } else {
    setStatus("Preview mode — showing sample chats until connected to LiveChat.");
    renderChats(activeChats);
  }
});
document.getElementById("settingsBtn").addEventListener("click", () => openSettingsPanel());

// Boot sequence: fetch agent list, update badge, auto-open settings if no
// agent saved yet (first time / cleared cache).
(async () => {
  logDiagnostic("Preview mode — showing sample chats until connected to LiveChat.");
  await fetchAgentOptions();
  updateAgentBadge();
  if (!selectedAgent) openSettingsPanel();
  renderChats(activeChats);
  initLiveChatSdk();
})();
