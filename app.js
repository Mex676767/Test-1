// Hidden from the UI (2026-09-02) while PYM builds their own ticketing
// system to link with — all the code (state, render, backend functions)
// stays intact underneath; flip this back to true to bring it back rather
// than rebuilding it.
const ESCALATION_TICKET_ENABLED = false;

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

// Brand's dropdown options — real Brand values from Customer Approaching's
// own field, not free text (see renderAutoFields). Fetched once at boot,
// same as agentOptions.
let brandOptions = [];
async function fetchBrandOptions() {
  try {
    const res = await fetch("/.netlify/functions/lark-brand-list");
    const data = await res.json();
    if (data.ok) brandOptions = data.brands || [];
  } catch (_) { /* non-fatal — falls back to just showing whatever's auto-detected */ }
}

// Escalation Ticket dropdown options (Brand/Queries/Payment Gateway/VIP
// Level) — from the C9MYR CS-PYM ESCALATION table's own fields, same
// fetch-once-at-boot pattern.
let escalationOptions = { brand: [], queries: [], paymentGateway: [], vipLevel: [] };
async function fetchEscalationOptions() {
  try {
    const res = await fetch("/.netlify/functions/lark-escalation-options");
    const data = await res.json();
    if (data.ok) {
      escalationOptions = {
        brand: data.brand || [], queries: data.queries || [],
        paymentGateway: data.paymentGateway || [], vipLevel: data.vipLevel || [],
      };
    }
  } catch (_) { /* non-fatal — Escalation Ticket dropdowns just show empty until retried */ }
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

// Each of these is its own bonus-program table in Lark (not columns on
// Customer Approaching) — lark-search.js already applies each table's own
// claim/hide rule and picks the single oldest still-claimable row, so by the
// time it gets here r[key] is either "" (nothing to show) or the one display
// value to render. Special Reload Event, Ang Pao, and Redeem Code aren't
// listed here — they're "special" (instant claim-writes-to-Lark) tickets,
// handled separately below.
const BONUS_PROGRAMS = [
  { key: "riskPlayer", label: "Risk Player" },
  { key: "topPnl", label: "Top 10 P&L" },
  { key: "gracePeriod", label: "Grace Period" },
  { key: "ltvTest", label: "LTV" },
  { key: "vipBooster", label: "12h VIP Deposit Booster" },
];
const NO_BONUS_PATTERN = /^\s*\d+D\s*No Bonus\s*$/i;

// Released Amount only ever applies to these — Risk Player, 12h VIP Booster,
// Ang Pao, Redeem Code, and Special Reload don't carry a claimable monetary
// amount. Grace Period is included here for documentation, but never
// reaches the generic claim flow that reads this set — it has its own
// separate handling (see the claim handler) since one field packs two very
// different states.
const AMOUNT_ELIGIBLE_PROGRAMS = new Set(["topPnl", "ltvTest", "gracePeriod"]);

// One-line summary shown on a collapsed card — lets an agent glance across
// several queued chats without expanding each one. Priority order matches
// what's most actionable: a card needing attention should never be masked
// by a "Logged" badge from a stale render, etc.
function hasAnyBonus(chatId) {
  const r = state[chatId].matchedRow;
  if (!r) return false;
  if (BONUS_PROGRAMS.some((p) => isClaimableValue(r[p.key]))) return true;
  if (r.angPao && !isHiddenStatus(r.angPao.status)) return true;
  if (r.redeemCode && !isHiddenStatus(r.redeemCode.status)) return true;
  if (r.specialReload) return true; // lark-search.js already filtered to only "Eligible Angpao"
  return false;
}

function getChatSummary(chatId) {
  const s = state[chatId];
  if (s.autoRecordError) return { text: "⚠︎ Needs attention", cls: "attention" };
  if (s.logged) return { text: "✓ Logged", cls: "done" };
  if (s.matchedRow === undefined) return { text: "Not looked up", cls: "neutral" };
  if (s.matchedRow === null) return { text: "No record found", cls: "neutral" };
  return hasAnyBonus(chatId) ? { text: "Bonuses ready", cls: "ready" } : { text: "No active bonuses", cls: "neutral" };
}

function isHiddenStatus(v) {
  const t = String(v || "").trim().toLowerCase();
  return t === "expired" || t === "claimed" || t === "failed";
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
async function fetchBonusRow(username, brand, link, telegram, picName, previousRecordId) {
  const res = await fetch("/.netlify/functions/lark-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, brand, link, telegram, picName, previousRecordId }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Lookup failed");
  return { row: data.row, otherBrands: data.otherBrands || [], caRecordId: data.caRecordId, justCreated: data.justCreated, notVip: data.notVip };
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
    // Full code (with digits) for the Escalation Ticket section's own Brand
    // field, which expects e.g. "VS96" not "VS" -- only fills in if blank,
    // same as Brand itself, so a manual pick there sticks too.
    if (!s.escalation.brand) s.escalation.brand = deriveFullBrandCode(data.groupName);
    logDiagnostic(`Auto-detected brand "${s.brand}" from group "${data.groupName}".`);
    if (activeChats[0]?.chatId === chatId) renderChats(activeChats);
    checkLastUsername(chatId); // brand is one of the two things this needs — try now that it's ready
  } catch (_) { /* non-fatal — Brand just stays a manual pick */ }
}

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
  const chatDef = activeChats.find((c) => c.chatId === chatId);
  const stableId = extractStableChatId(chatDef?.link);
  if (!stableId || !s.brand) return;
  s.lastUsernameStarted = true;
  s.lastUsernameLoading = true;
  updateLastUsernameUi(chatId);
  try {
    const res = await fetch("/.netlify/functions/lark-last-username", {
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
        checkLastUsername(chatId); // the chat link is the other thing this needs — try now that it's ready
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

// Same cleanup as deriveBrandFromGroup, but keeps the digits -- the
// escalation ticket's own Brand field expects the full brand+number code
// ("VS96", not "VS"; confirmed from the real table's Brand column values).
function deriveFullBrandCode(groupName) {
  if (!groupName) return "";
  return groupName
    .replace(/\s*priority support\s*/i, "")
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
  riskPlayer: "Bonus Checking", // fallback only — see resolveInquiryForProgram
  topPnl: "TOP P&L",
  gracePeriod: "Grace Period",
  ltvTest: "TOP LTV",
  vipBooster: "12hour VIP Deposit Boost",
  angPao: "Ang Pao",
  redeemCode: "Redeem Code",
  specialReload: "Reload - Ang Pao",
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
  return BONUS_INQUIRY_MAP[key];
}

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

// Brand, same custom-dropdown treatment as Status — a native <select>'s
// own dropdown chrome (including its scrollbar) can't be restyled via CSS
// in any browser, so this is the only way to actually theme it.
function renderBrandDisplay(chatId) {
  const s = state[chatId];
  const empty = !s.brand;
  return `<span class="status-value ${empty ? "placeholder" : ""}">${s.brand || "Select brand…"}</span><span class="status-caret">▾</span>`;
}

function renderBrandDropdown(chatId) {
  const s = state[chatId];
  // Auto-detection can produce a value that isn't (yet) in brandOptions —
  // keep it selectable rather than silently dropping it from the list.
  const options = s.brand && !brandOptions.includes(s.brand) ? [s.brand, ...brandOptions] : brandOptions;
  return options.map((b) => {
    const active = s.brand === b;
    return `
    <button type="button" class="inquiry-option ${active ? "active" : ""}" data-action="selectBrand" data-chat="${chatId}" data-value="${b}">
      <span class="inquiry-option-check">${active ? "✓" : ""}</span>${b}
    </button>`;
  }).join("");
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
      <button type="button" class="dob-cal-nav" data-action="dobNavYear" data-chat="${chatId}" data-dir="-1" title="Previous year">«</button>
      <button type="button" class="dob-cal-nav" data-action="dobNavMonth" data-chat="${chatId}" data-dir="-1" title="Previous month">‹</button>
      <span class="dob-cal-title">${DOB_MONTH_NAMES[month]} ${year}</span>
      <button type="button" class="dob-cal-nav" data-action="dobNavMonth" data-chat="${chatId}" data-dir="1" title="Next month">›</button>
      <button type="button" class="dob-cal-nav" data-action="dobNavYear" data-chat="${chatId}" data-dir="1" title="Next year">»</button>
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
    parts.push(`<span><span class="pi-label">Tier</span> ${s.matchedRow.tier || "—"}</span>`);
  }
  return parts.length ? `<div class="player-info">${parts.join("")}</div>` : "";
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
    if (!isClaimableValue(r[p.key])) return;
    const def = { key: p.key, kind: "regular", label: p.label, display: r[p.key] };
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
    }
    defs.push(def);
  });

  if (r.angPao && !isHiddenStatus(r.angPao.status)) {
    defs.push({ key: "angPao", kind: "special", label: "Ang Pao", display: r.angPao.status });
  }

  if (r.redeemCode && !isHiddenStatus(r.redeemCode.status)) {
    defs.push({ key: "redeemCode", kind: "special", label: "Redeem Code", display: r.redeemCode.status, isCode: true });
  }

  // Distinct from the standalone "Ang Pao" ticket above — this is the
  // Special Reload Event table's Ang Pao variant (its Free Spin variant is
  // retired). Already pre-filtered server-side to only "Eligible Angpao".
  if (r.specialReload) {
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
    const claimLabel = d.claimLabel || "Claim";
    const doneLabel = d.doneLabel || "✓ Claimed";
    return `
    <div class="ticket ${d.kind === "special" ? "ticket-special" : ""} ${locked ? "locked" : ""}">
      <div class="ticket-icon">◆</div>
      <div class="ticket-body">
        <div class="ticket-name">${d.label}</div>
        <div class="ticket-meta ${d.isCode ? "mono code" : ""}">${d.display}</div>
      </div>
      <button class="claim-btn ${d.kind === "special" ? "special" : ""} ${claimed ? "claimed" : ""}" data-action="claim" data-program="${d.key}" data-chat="${chatId}" ${claimed || locked ? "disabled" : ""}>
        ${claimed ? doneLabel : claimLabel}
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
          <div class="brand-dropdown hidden">${renderBrandDropdown(chatId)}</div>
        </div>
      </div>
      <div class="auto-field">
        <span class="field-label" style="margin:0">D.O.B</span>
        <div class="dob-picker">
          <button type="button" class="input status-display dob-display" data-action="toggleDobCalendar" data-chat="${chatId}">
            ${renderDobDisplay(chatId)}
          </button>
          <div class="dob-calendar hidden"></div>
        </div>
      </div>
      <div class="auto-field">
        <span class="field-label" style="margin:0">Amount <span class="auto-tag">auto</span></span>
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
        <button class="expand-btn expanded" data-action="toggleExpand" data-chat="${chat.chatId}" title="Collapse">▴</button>
      </div>
    </div>

    <label class="field-label">Username</label>
    <div class="username-row">
      <input type="text" class="input mono username-input" placeholder="${s.lastUsernameLoading ? "Checking for a previous record…" : "Player username / UID"}" value="${s.username}" />
      <button class="lookup-btn" data-action="lookup" data-chat="${chat.chatId}">Look up</button>
    </div>

    <div class="player-info-slot">${renderPlayerInfo(chat.chatId)}</div>
    <div class="ticket-slot">${renderTickets(chat.chatId)}</div>
    <div class="auto-fields-slot">${renderAutoFields(chat.chatId)}</div>

    <label class="field-label">Inquiry <span class="hint">(select up to 2 — search to filter)</span></label>
    <div class="inquiry-select">
      <div class="inquiry-box">
        <div class="inquiry-chips">${renderInquiryChips(chat.chatId)}</div>
        <input type="text" class="inquiry-search" placeholder="Search inquiry…" autocomplete="off" />
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
        <input type="checkbox" class="tg-check" data-chat="${chat.chatId}" ${s.telegram ? "checked" : ""} />
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

    ${ESCALATION_TICKET_ENABLED ? `<div class="escalation-slot">${renderEscalationSection(chat.chatId)}</div>` : ""}
  `;
}

// C9MYR CS-PYM Escalation Ticket — writes straight to that department's own
// Lark table (lark-escalation-submit.js), completely separate from the
// Record-to-Lark-Base flow above. Only the fields that exist on the real
// form are included; Attachment is deliberately left out for now (needs a
// separate Lark file-upload step this doesn't do yet), and Ticket No. is a
// formula field on their table we never touch. PIC Name isn't an input
// here at all — always mirrors the agent name chosen in Settings.
function renderEscalationSection(chatId) {
  const s = state[chatId];
  if (s.escalationSubmitted) {
    return `
      <label class="field-label">Escalation Ticket <span class="hint">(C9MYR CS-PYM)</span></label>
      <div class="logged-badge">✓ Escalation ticket submitted</div>`;
  }
  const e = s.escalation;
  const opt = (list, current) => {
    const all = current && !list.includes(current) ? [current, ...list] : list;
    return `<option value="" ${!current ? "selected" : ""}>Please select</option>`
      + all.map((v) => `<option value="${v}" ${v === current ? "selected" : ""}>${v}</option>`).join("");
  };
  return `
    <label class="field-label">Escalation Ticket <span class="hint">(C9MYR CS-PYM)</span></label>
    <div class="escalation-grid">
      <div class="escalation-field">
        <label class="field-label">Member/User ID *</label>
        <input type="text" class="input mono esc-input" data-chat="${chatId}" data-field="memberUserId" value="${e.memberUserId}" placeholder="Type here" />
      </div>
      <div class="escalation-field">
        <label class="field-label">Brand *</label>
        <select class="input esc-select" data-chat="${chatId}" data-field="brand">${opt(escalationOptions.brand, e.brand)}</select>
      </div>
      <div class="escalation-field">
        <label class="field-label">Queries *</label>
        <select class="input esc-select" data-chat="${chatId}" data-field="queries">${opt(escalationOptions.queries, e.queries)}</select>
      </div>
      <div class="escalation-field">
        <label class="field-label">Transaction ID</label>
        <input type="text" class="input mono esc-input" data-chat="${chatId}" data-field="transactionId" value="${e.transactionId}" placeholder="Type here" />
      </div>
      <div class="escalation-field">
        <label class="field-label">Payment Gateway</label>
        <select class="input esc-select" data-chat="${chatId}" data-field="paymentGateway">${opt(escalationOptions.paymentGateway, e.paymentGateway)}</select>
      </div>
      <div class="escalation-field">
        <label class="field-label">VIP Level</label>
        <select class="input esc-select" data-chat="${chatId}" data-field="vipLevel">${opt(escalationOptions.vipLevel, e.vipLevel)}</select>
      </div>
      <div class="escalation-field">
        <label class="field-label">Amount</label>
        <input type="number" step="0.01" class="input mono esc-input" data-chat="${chatId}" data-field="amount" value="${e.amount}" placeholder="Round to 2 decimal places" />
      </div>
      <div class="escalation-field escalation-field-wide">
        <label class="field-label">Remarks (CS - PYM)</label>
        <textarea class="input esc-input" data-chat="${chatId}" data-field="remarks" placeholder="Type here" rows="2">${e.remarks}</textarea>
      </div>
    </div>
    <div class="hint" style="margin:6px 0 10px">Attachment isn't supported here yet — attach it directly in Lark if needed.</div>
    ${s.escalationError ? `<div class="record-error-banner">⚠︎ ${s.escalationError}</div>` : ""}
    <button class="submit-btn escalation-submit-btn" data-action="submitEscalation" data-chat="${chatId}">Submit Escalation Ticket</button>
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
      transactionId: "", paymentGateway: "", remarks: "", vipLevel: "", amount: "",
    },
    escalationSubmitted: false, escalationError: "",
    // "Last username recorded" — see checkLastUsername. Runs once per chat,
    // as soon as both Brand and the resolved chat link are ready.
    // lastUsernameStarted guards against calling twice; lastUsernameLoading
    // is the visible "Checking…" state shown until it resolves.
    lastUsernameStarted: false, lastUsernameLoading: false,
    lastUsernameChecked: false, lastUsernameFound: false, lastUsernameValue: "",
    inquiry: [], status: "", telegram: chat.isTelegram, telegramManual: false, logged: false, dob: "", dobView: null,
    releasedBonusAmount: "", releasedAmountRaw: "", claimSecret: false,
    // chatOpen mirrors the LiveChat conversation's open/closed state.
    // Recording only happens once a chat closes — checkChatStatus flips
    // this and calls submitRecord automatically once LiveChat reports the
    // chat inactive; there's no manual close button anymore.
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
    if (!s.escalation.memberUserId) s.escalation.memberUserId = username;
    const chatDef = activeChats.find((c) => c.chatId === chatId);
    const telegramNow = card.querySelector(".tg-check").checked;
    btn.disabled = true;
    btn.textContent = "…";
    try {
      // lark-search.js resolves every bonus's own source table directly now
      // (no more Customer Approaching Lookup-column delay) — this response
      // is already final, nothing left to poll for.
      //
      // One Customer Approaching row per chat, not one per Look Up click —
      // a repeat lookup for this same chat passes back the record created
      // last time so the backend deletes it first. Only sent if that
      // record hasn't been logged (submitted) yet — a completed case is
      // never deleted by a stray re-lookup.
      const previousRecordId = (!s.logged && s.caRecordId) ? s.caRecordId : null;
      const { row, otherBrands, caRecordId, notVip } = await fetchBonusRow(username, brand, chatDef?.link || "", telegramNow, selectedAgent, previousRecordId);
      s.matchedRow = row;
      s.otherBrandMatches = otherBrands;
      s.caRecordId = caRecordId;
      s.claimedPrograms = {};
      s.gracePeriodActivated = false;
      s.releasedBonusAmount = "";
      s.releasedAmountRaw = "";
      s.claimSecret = false;
      if (notVip) {
        setStatus("Not VVIP", "error");
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
        s.claimSecret = true;
        s.releasedBonusAmount = `Grace Period: ${amount || display}`;
        s.releasedAmountRaw = amount || display;
        if (!s.escalation.amount && amount) s.escalation.amount = amount;
      }
      card.querySelector(".ticket-slot").innerHTML = renderTickets(chatId);
      card.querySelector(".auto-fields-slot").innerHTML = renderAutoFields(chatId);
      card.querySelector(".inquiry-chips").innerHTML = renderInquiryChips(chatId);
      card.querySelector(".inquiry-dropdown").innerHTML = renderInquiryDropdown(chatId, "");
      card.querySelector(".status-display").innerHTML = renderStatusDisplay(chatId);
      card.querySelector(".status-dropdown").innerHTML = renderStatusDropdown(chatId);
      return;
    }

    // Ang Pao / Redeem Code / Special Reload (Ang Pao) write live to Lark
    // the instant they're claimed — that's what fires the backoffice-
    // approval workflow. Regular (gold) tickets are read-only source-table
    // rows; they're only logged at submit.
    if (programKey === "angPao" || programKey === "redeemCode" || programKey === "specialReload") {
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
      { key: "angPao", label: "Ang Pao", display: r.angPao?.status },
      { key: "redeemCode", label: "Redeem Code", display: r.redeemCode?.status },
      { key: "specialReload", label: "Special Reload (Ang Pao)", display: r.specialReload?.status },
    ];
    // Released Amount only ever applies to Top 10 P&L / LTV (Grace Period
    // has its own separate handling above) — Risk Player, 12h VIP Booster,
    // Ang Pao, Redeem Code, and Special Reload don't carry a claimable
    // monetary amount, so claiming one of those must leave it blank rather
    // than stuffing its status text in there.
    const claimedSources = allSources.filter((src) => s.claimedPrograms[src.key] && AMOUNT_ELIGIBLE_PROGRAMS.has(src.key));
    s.releasedBonusAmount = claimedSources.map((src) => `${src.label}: ${src.display}`).join(" | ");
    // Raw display text only (no label prefix) for the backend to pull a
    // number out of — labels like "Top 10 P&L - Test" contain digits of
    // their own, so parsing the combined string above would grab the wrong
    // number. Only one bonus can be claimed per case, so this is just that
    // one entry's display value.
    s.releasedAmountRaw = claimedSources.map((src) => src.display).join(" | ");
    s.claimSecret = true;
    if (!s.escalation.amount && s.releasedAmountRaw) {
      const numMatch = s.releasedAmountRaw.match(/-?\d+(?:\.\d+)?/);
      if (numMatch) s.escalation.amount = numMatch[0];
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

  if (btn.dataset.action === "submitEscalation") {
    const e = s.escalation;
    if (!e.memberUserId || !e.brand || !e.queries) {
      s.escalationError = "Member/User ID, Brand, and Queries are required.";
      card.querySelector(".escalation-slot").innerHTML = renderEscalationSection(chatId);
      return;
    }
    btn.disabled = true;
    btn.textContent = "…";
    try {
      const res = await fetch("/.netlify/functions/lark-escalation-submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...e, picName: selectedAgent }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Submit failed");
      s.escalationSubmitted = true;
      s.escalationError = "";
      setStatus("Escalation ticket submitted.", "success");
    } catch (err) {
      s.escalationError = "Escalation submit failed: " + err.message;
    }
    card.querySelector(".escalation-slot").innerHTML = renderEscalationSection(chatId);
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
    document.querySelectorAll(".inquiry-dropdown, .status-dropdown, .brand-dropdown, .dob-calendar").forEach((d) => d.classList.add("hidden"));
    if (willOpen) dropdown.classList.remove("hidden");
  }

  if (btn.dataset.action === "selectStatus") {
    s.status = btn.dataset.value;
    card.querySelector(".status-display").innerHTML = renderStatusDisplay(chatId);
    card.querySelector(".status-dropdown").innerHTML = renderStatusDropdown(chatId);
    card.querySelector(".status-dropdown").classList.add("hidden");
  }

  if (btn.dataset.action === "toggleBrandDropdown") {
    const dropdown = card.querySelector(".brand-dropdown");
    const willOpen = dropdown.classList.contains("hidden");
    // Only one dropdown open at a time across the whole widget.
    document.querySelectorAll(".inquiry-dropdown, .status-dropdown, .brand-dropdown, .dob-calendar").forEach((d) => d.classList.add("hidden"));
    if (willOpen) dropdown.classList.remove("hidden");
  }

  if (btn.dataset.action === "selectBrand") {
    s.brand = btn.dataset.value;
    card.querySelector(".brand-display").innerHTML = renderBrandDisplay(chatId);
    card.querySelector(".brand-dropdown").innerHTML = renderBrandDropdown(chatId);
    card.querySelector(".brand-dropdown").classList.add("hidden");
  }

  if (btn.dataset.action === "toggleDobCalendar") {
    const cal = card.querySelector(".dob-calendar");
    const willOpen = cal.classList.contains("hidden");
    // Only one dropdown open at a time across the whole widget.
    document.querySelectorAll(".inquiry-dropdown, .status-dropdown, .brand-dropdown, .dob-calendar").forEach((d) => d.classList.add("hidden"));
    if (willOpen) {
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

  if (btn.dataset.action === "dobNavYear") {
    if (!s.dobView) renderDobCalendar(chatId);
    s.dobView = { year: s.dobView.year + Number(btn.dataset.dir), month: s.dobView.month };
    card.querySelector(".dob-calendar").innerHTML = renderDobCalendar(chatId);
  }

  if (btn.dataset.action === "selectDobDay") {
    s.dob = btn.dataset.value;
    const [y, m] = s.dob.split("-").map(Number);
    s.dobView = { year: y, month: m - 1 };
    card.querySelector(".dob-display").innerHTML = renderDobDisplay(chatId);
    card.querySelector(".dob-calendar").classList.add("hidden");
  }

  if (btn.dataset.action === "dobClear") {
    s.dob = "";
    card.querySelector(".dob-display").innerHTML = renderDobDisplay(chatId);
    card.querySelector(".dob-calendar").classList.add("hidden");
  }

  if (btn.dataset.action === "dobToday") {
    const t = new Date();
    s.dob = `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
    s.dobView = { year: t.getFullYear(), month: t.getMonth() };
    card.querySelector(".dob-display").innerHTML = renderDobDisplay(chatId);
    card.querySelector(".dob-calendar").classList.add("hidden");
  }
});

// Inquiry search box: filter as the agent types.
chatListEl.addEventListener("input", (e) => {
  const inquiryInput = e.target.closest(".inquiry-search");
  if (inquiryInput) {
    const card = inquiryInput.closest(".chat-card");
    card.querySelector(".inquiry-dropdown").innerHTML = renderInquiryDropdown(card.dataset.chatId, inquiryInput.value);
    return;
  }
  // Escalation Ticket text/number/textarea fields — same no-re-render,
  // just-sync-state pattern as D.O.B.
  const escInput = e.target.closest(".esc-input");
  if (escInput) {
    const s = state[escInput.dataset.chat];
    if (s) s.escalation[escInput.dataset.field] = escInput.value;
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
  }
});

// Inquiry dropdown opens on focus (it has no explicit toggle button, unlike
// Status); closes whatever else is open first so only one shows at a time
// across the whole widget.
chatListEl.addEventListener("focusin", (e) => {
  const input = e.target.closest(".inquiry-search");
  if (!input) return;
  document.querySelectorAll(".status-dropdown, .brand-dropdown, .dob-calendar").forEach((d) => d.classList.add("hidden"));
  input.closest(".inquiry-select")?.querySelector(".inquiry-dropdown")?.classList.remove("hidden");
});

// Clicking anywhere in the merged box (not just the thin search input
// itself) focuses it — makes the whole box feel like one clickable control,
// matching how the whole Status box responds to a click.
chatListEl.addEventListener("click", (e) => {
  if (e.target.closest(".inquiry-chip-remove")) return; // don't steal focus from a chip removal click
  const box = e.target.closest(".inquiry-box");
  if (box && e.target !== box.querySelector(".inquiry-search")) box.querySelector(".inquiry-search")?.focus();
});

// Click anywhere outside a given dropdown's own wrapper closes it — so a
// click on one of its own options, which lives inside that same wrapper,
// never closes it prematurely.
//
// Uses composedPath(), not wrap.contains(e.target): chatListEl's own click
// handler runs first (closer ancestor, fires earlier in bubbling) and some
// actions (dobNavMonth/dobNavYear) replace their container's innerHTML to
// reflect the new month/year — which detaches the very button that was
// clicked from the document. By the time this handler runs, e.target is a
// detached node, and wrap.contains(detachedNode) is always false — every
// wrapper reads as "clicked outside," closing the calendar right as it
// tries to update instead of navigate. composedPath() is captured at
// dispatch time, before any handler can mutate the DOM, so it still lists
// the original ancestors regardless of what ran before this.
document.addEventListener("click", (e) => {
  const path = e.composedPath();
  document.querySelectorAll(".inquiry-select, .status-picker, .brand-picker, .dob-picker").forEach((wrap) => {
    if (!path.includes(wrap)) wrap.querySelector(".inquiry-dropdown, .status-dropdown, .brand-dropdown, .dob-calendar")?.classList.add("hidden");
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
        dob: s.dob || "",
        telegram: !!s.telegram,
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
  await Promise.all([fetchAgentOptions(), fetchBrandOptions(), fetchEscalationOptions()]);
  updateAgentBadge();
  if (!selectedAgent) openSettingsPanel();
  renderChats(activeChats);
  initLiveChatSdk();
})();
