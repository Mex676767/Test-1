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

// Global "don't log chats" toggle — for chats deliberately not wanted in
// Lark data at all (unlike Unknown player, which is per-chat and permanent
// once a case closes, this is a temporary gate any chat can pass through
// once it's unticked again — see submitRecord). Persisted so it survives
// this widget's iframe reloading (same reason chat state itself does).
const LOGGING_PAUSED_KEY = "rc-logging-paused";
let loggingPaused = localStorage.getItem(LOGGING_PAUSED_KEY) === "true";

async function fetchAgentOptions() {
  try {
    const res = await fetch("/lark-pic-list");
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
    const res = await fetch("/lark-brand-list");
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
    const res = await fetch("/lark-escalation-options");
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
];
const NO_BONUS_PATTERN = /^\s*\d+D\s*No Bonus\s*$/i;

// Released Amount only ever applies to these — Risk Player, 12h VIP Booster,
// Redeem Code, and Special Reload don't carry a claimable monetary amount.
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

// One-line summary shown on a collapsed card — lets an agent glance across
// several queued chats without expanding each one. Priority order matches
// what's most actionable: a card needing attention should never be masked
// by a "Logged" badge from a stale render, etc.
function hasAnyBonus(chatId) {
  const r = state[chatId].matchedRow;
  if (!r) return false;
  if (BONUS_PROGRAMS.some((p) => isClaimableValue(r[p.key]))) return true;
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
async function fetchBonusRow(username, brand, link, telegram, picName, previousRecordId) {
  const res = await fetch("/lark-search", {
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
  const hadUnsaved = !!(prev && (prev.usernameDraft || prev.lookupInFlight));
  const nextLabel = nextChat.customerName || nextChat.chatId;
  if (hadUnsaved) {
    showChatToast(`⚠ Switched chats before "${prev.usernameDraft || "a lookup"}" was submitted — now viewing ${nextLabel}. Come back to the other chat to finish it.`, "warn");
  } else if (prevChatId && prevChatId !== nextChat.chatId) {
    showChatToast(`Now viewing ${nextLabel}`, "info");
  }
}

function applyProfile(profile) {
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
    restoreCardFromLark(threadId, { archived: true, customerName: profile.name || "" }).then((restored) => {
      if (restored && state[threadId]) showTrackedArchivedChat(threadId, profile);
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
async function resolveBrandFromGroupId(chatId, groupID) {
  if (!groupID) {
    // Silent before this — if the SDK profile ever lacks a groupID at all,
    // there'd be zero trace of why Brand never auto-filled. Logged once
    // instead of every call so a genuinely groupID-less setup doesn't spam.
    if (!rawGroupIdMissingLoggedFor.has(chatId)) {
      rawGroupIdMissingLoggedFor.add(chatId);
      logDiagnostic(`Brand auto-detect skipped for this chat — LiveChat's SDK profile had no groupID.`, "warn");
    }
    return;
  }
  try {
    const res = await fetch("/livechat-group-name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // chatId here is the thread id (see chatFromProfile) -- lets the server
      // find which LiveChat account owns the chat, since a group ID alone is
      // only unique within one account.
      body: JSON.stringify({ groupID, threadId: chatId }),
    });
    const data = await res.json();
    if (!data.ok || !data.groupName) {
      // Same deal — this used to fail completely silently, which is exactly
      // how the JUS-brand-never-detected report went untraceable. data.error
      // (from livechat-group-name.js's own catch) says why when there is one.
      logDiagnostic(
        `Brand auto-detect failed for group ID "${groupID}"${data.error ? `: ${data.error}` : " — group not found in LiveChat's group list."}`,
        "warn"
      );
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
      if (derived) {
        logDiagnostic(
          `Brand auto-detect found "${derived}" from group "${data.groupName}", but that's not an existing Brand option — left blank for manual pick.`,
          "warn"
        );
      }
      return;
    }
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
const rawStatusDebugLoggedFor = new Set(); // avoid re-logging the same raw payload every tick
const firstCheckLoggedFor = new Set(); // one confirmation per chat that get_chat succeeded at all
const errorLoggedFor = new Set(); // avoid spamming the same persistent error every 20s
const autoMissingLoggedFor = new Map(); // chatId -> last "missing" list logged by submitRecord's auto path, so sweepPendingChats retrying a permanently-incomplete chat doesn't spam the identical message every 8s forever

function stopChatStatusPolling() {
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
    checkChatStatus(chatId);
  };
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
      body: JSON.stringify({ chatId, realChatId }),
    });
    const data = await res.json();
    if (!data.ok) return;

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

    if (data.isActive === false && s.chatOpen) {
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
  "Maintenance", "Telegram Transition Message", "Unclear Inquiries",
];

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
function stateSnapshot(s) {
  const { _savedAt, ...rest } = s || {};
  return JSON.stringify(rest);
}
function markStateSynced(chatId) {
  lastSyncedJson.set(chatId, stateSnapshot(state[chatId]));
}

function saveState() {
  try {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(STATE_STORAGE_KEY) || "{}") || {}; } catch (_) { raw = {}; }
    const now = Date.now();
    let dirty = false;
    let adopted = false;
    for (const [chatId, s] of Object.entries(state)) {
      const cur = stateSnapshot(s);
      const synced = lastSyncedJson.get(chatId);
      if (synced !== undefined && cur === synced) {
        // Nothing changed in THIS tab -- another tab may have updated it.
        const theirs = raw[chatId];
        if (theirs) {
          const { _savedAt, ...rest } = theirs;
          const theirsJson = JSON.stringify(rest);
          if (theirsJson !== cur) {
            // Mutate in place so existing references to state[chatId] stay valid.
            for (const k of Object.keys(s)) delete s[k];
            Object.assign(s, rest);
            lastSyncedJson.set(chatId, stateSnapshot(s));
            adopted = true;
          }
        }
        continue;
      }
      raw[chatId] = { ...s, _savedAt: now };
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
      parts.push(`<span><span class="pi-label">Name</span> ${s.matchedRow.customerName}</span>`);
    }
    parts.push(`<span><span class="pi-label">Tier</span> ${s.matchedRow.tier || "—"}</span>`);
    if (s.forcedVipFor && !s.matchedRow.tier) {
      parts.push(`<span><span class="pi-label">Note</span> Not on the VIP list yet — force looked up</span>`);
    }
  }
  return parts.length ? `<div class="player-info">${parts.join("")}</div>` : "";
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
  for (const k of CASE_KEYS) if (snap[k] !== undefined) s[k] = JSON.parse(JSON.stringify(snap[k]));
}
function usedProgramsInOtherCases(s) {
  const used = new Set();
  for (const c of (s.logs || [])) {
    for (const [k, v] of Object.entries(c.claimedPrograms || {})) if (v) used.add(k);
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

  BONUS_PROGRAMS.forEach((p) => {
    if (usedElsewhere.has(p.key)) return;
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
    const claimLabel = d.claimLabel || "Claim";
    const doneLabel = d.doneLabel || "✓ Claimed";
    return `
    <div class="ticket ${d.kind === "special" ? "ticket-special" : ""} ${locked ? "locked" : ""} ${d.reactivatable ? "ticket-has-reactivate" : ""}">
      <div class="ticket-main">
        <div class="ticket-icon">◆</div>
        <div class="ticket-body">
          <div class="ticket-name">${d.label}</div>
          <div class="ticket-meta ${d.isCode ? "mono code" : ""}">${d.key === "gracePeriod" ? highlightDates(d.display) : d.display}</div>
        </div>
      </div>
      <div class="ticket-btns">
        <button class="claim-btn ${d.kind === "special" ? "special" : ""} ${claimed ? "claimed" : ""}" data-action="${claimed ? "unclaim" : "claim"}" data-program="${d.key}" data-chat="${chatId}" ${claimed ? 'title="Click again to unclaim"' : ""} ${!claimed && locked ? "disabled" : ""}>
          ${claimed ? doneLabel : claimLabel}
        </button>
        ${
          d.reactivatable
            ? `<button class="claim-btn reactivate-btn" data-action="reactivateGracePeriod" data-chat="${chatId}" ${locked ? "disabled" : ""} title="Customer didn't complete the challenge — give them another attempt today">Reactivate</button>`
            : ""
        }
      </div>
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

function highlightDates(text) {
  return escapeHtml(text).replace(DATE_PATTERN, (m) => `<span class="ticket-date">${m}</span>`);
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
    <div class="chat-card-head">
      <span class="chat-name">${chat.customerName}</span>
      <div class="chat-card-head-actions">
        ${chat.link ? `<a class="chat-link" href="${chat.link}" target="_blank">Open ↗</a>` : ""}
        <button class="expand-btn expanded" data-action="toggleExpand" data-chat="${chat.chatId}" title="Collapse">▴</button>
      </div>
    </div>

    <label class="field-label">Username</label>
    <div class="username-row">
      <input type="text" class="input mono username-input" placeholder="${s.lastUsernameLoading ? "Checking for a previous record…" : "Player username / UID"}" value="${s.usernameDraft || s.username}" ${s.isUnknown && !s.notVipResult ? "disabled" : ""} />
      <button class="lookup-btn ${s.notVipResult ? "force" : ""}" data-action="lookup" data-chat="${chat.chatId}" ${(s.isUnknown && !s.notVipResult) || s.lookupInFlight ? "disabled" : ""} ${s.notVipResult ? 'title="Not on the VIP list — look up again anyway and keep them as a VIP"' : ""}>${s.lookupInFlight ? "…" : (s.notVipResult ? "Force lookup" : "Look up")}</button>
    </div>
    <label class="unknown-toggle">
      <input type="checkbox" class="unknown-check" data-chat="${chat.chatId}" ${s.isUnknown ? "checked" : ""} />
      <span>Unknown player</span>
    </label>

    <div class="player-info-slot">${renderPlayerInfo(chat.chatId)}</div>
    <div class="ticket-slot">${renderTickets(chat.chatId)}</div>
    <div class="auto-fields-slot">${renderAutoFields(chat.chatId)}</div>

    <label class="field-label">Inquiry <span class="hint">(select up to 2 — search to filter)</span></label>
    <div class="inquiry-select">
      <div class="inquiry-box">
        <div class="inquiry-chips">${renderInquiryChips(chat.chatId)}</div>
        <input type="text" class="inquiry-search" placeholder="${s.inquiry.length ? "" : "Search inquiry…"}" autocomplete="off" />
        <span class="inquiry-caret">▾</span>
      </div>
      <div class="inquiry-dropdown ${s.inquiryDropdownOpen ? "" : "hidden"}">${renderInquiryDropdown(chat.chatId, "")}</div>
    </div>

    <label class="field-label">Status</label>
    <div class="status-picker">
      <div class="status-box">
        <div class="status-chip-slot">${renderStatusChip(chat.chatId)}</div>
        <input type="text" class="status-search" placeholder="${s.status ? "" : "Select status…"}" autocomplete="off" />
        <span class="inquiry-caret">▾</span>
      </div>
      <div class="status-dropdown ${s.statusDropdownOpen ? "" : "hidden"}">${renderStatusDropdown(chat.chatId, "")}</div>
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
      loggingPaused && !s.logged
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

chatListEl.addEventListener("input", (e) => {
  const input = e.target.closest(".username-input");
  if (!input) return;
  const id = input.closest(".chat-card")?.dataset.chatId;
  if (id && state[id]) state[id].usernameDraft = input.value;
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

  if (btn.dataset.action === "lookup") {
    if (!selectedAgent) { openSettingsPanel(); return; }
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
    const brand = s.brand;
    if (!brand) { setStatus("Brand hasn't been auto-detected yet for this chat — try again in a moment.", "error"); return; }
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
    let needFullRender = forcing;
    s.lookupInFlight = true;
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
      const previousRecordId = (!s.logged && s.caRecordId && ownsCaseRecord(s)) ? s.caRecordId : null;
      const { row, otherBrands, caRecordId, notVip } = await fetchBonusRow(username, brand, s.chatUrl || chatDef?.link || "", telegramNow, selectedAgent, previousRecordId);
      s.caLinkSaved = !!(s.chatUrl || chatDef?.link);
      s.matchedRow = row;
      s.otherBrandMatches = otherBrands;
      s.caRecordId = caRecordId;
      s.caOwner = selectedAgent;
      s.claimedPrograms = {};
      s.gracePeriodActivated = false;
      s.releasedBonusAmount = "";
      s.releasedAmountRaw = "";
      s.claimSecret = false;
      s.claimSecretManual = false;
      const sameForced = !!s.forcedVipFor && s.forcedVipFor.toLowerCase() === username.toLowerCase();
      showChatToast(`✓ Looked up "${username}" — ${brand}`, "info");
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
        setStatus('Not VVIP — marked Unknown player. Use "Force lookup" if they are VIP but not on the list yet.', "error");
      } else if (notVip) {
        s.notVipResult = false;
        s.forcedVipFor = username;
        setStatus(`Force lookup: ${username} isn't on the VIP list yet — kept as a VIP.`);
      } else {
        s.notVipResult = false;
        s.forcedVipFor = "";
        setStatus(row ? `Found ${username} under ${brand}.` : "No record found.");
      }
    } catch (err) {
      if (forcing) s.isUnknown = true; // failed force lookup -- back to how it was
      setStatus("Lookup failed: " + err.message, "error");
    }
    s.lookupInFlight = false;
    btn.disabled = false;
    btn.textContent = s.notVipResult ? "Force lookup" : "Look up";
    if (needFullRender) renderChats(activeChats);
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
      if (s.claimedPrograms.gracePeriod) {
        await submitRecord(chatId, { auto: true, reason: "Grace Period claimed" });
      }
      return;
    }

    // Telegram RM28 / Redeem Code / Special Reload (Ang Pao) write live to
    // Lark the instant they're claimed — that's what fires the backoffice-
    // approval workflow. Regular (gold) tickets are read-only source-table
    // rows; they're only logged at submit.
    if (programKey === "telegram28" || programKey === "redeemCode" || programKey === "specialReload") {
      const source = r[programKey];
      const chatDef = activeChats.find((c) => c.chatId === chatId);
      btn.disabled = true;
      btn.textContent = "…";
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
      }
    }

    s.claimedPrograms[programKey] = true;
    const allSources = [
      ...BONUS_PROGRAMS.map((p) => ({ key: p.key, label: p.label, display: r[p.key] })),
      { key: "telegram28", label: "Telegram RM28", display: r.telegram28?.status },
      { key: "redeemCode", label: "Redeem Code", display: r.redeemCode?.status },
      { key: "specialReload", label: "Special Reload (Ang Pao)", display: r.specialReload?.status },
    ];
    // Released Amount only ever applies to Top 10 P&L / LTV / Telegram RM28
    // (Grace Period has its own separate handling above) — Risk Player, 12h
    // VIP Booster, Redeem Code, and Special Reload don't carry a claimable
    // monetary amount, so claiming one of those must leave it blank rather
    // than stuffing its status text in there.
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
    const claimedSources = allSources.filter((src) => s.claimedPrograms[src.key] && AMOUNT_ELIGIBLE_PROGRAMS.has(src.key));
    const claimedAmount = claimedSources.map((src) => extractAmountNumber(src.display)).filter(Boolean).join(" | ");
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
    await submitRecord(chatId, { auto: true, reason: `${allSources.find((src) => src.key === programKey)?.label || "Bonus"} claimed` });
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
      if (s.logged && s.caRecordId && !s.isUnknown) {
        const res = await fetch("/lark-record", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recordId: s.caRecordId, unclaim: true, agentName: selectedAgent }),
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
    if (!e.memberUserId || !e.brand || !e.queries) {
      s.escalationError = "Member/User ID, Brand, and Queries are required.";
      card.querySelector(".escalation-slot").innerHTML = renderEscalationSection(chatId);
      return;
    }
    btn.disabled = true;
    btn.textContent = "…";
    try {
      const res = await fetch("/lark-escalation-submit", {
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

  } finally {
    saveState();
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
  const escInput = e.target.closest(".esc-input");
  if (escInput) {
    const s = state[escInput.dataset.chat];
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
  if (!s.isUnknown || !s.caRecordId) return;

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
  const restore = () => { if (!s.caRecordId) s.caRecordId = staleRecordId; }; // lets a re-tick retry
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

// Re-sends an already-logged chat's record with its current values -- used
// when something is edited AFTER the instant claim auto-submit (submitRecord
// returns early once s.logged is set, so it can't do this itself).
async function resyncLoggedRecord(chatId) {
  const s = state[chatId];
  if (!s || !s.logged || !s.caRecordId || s.isUnknown) return false;
  if (!s.inquiry.length || !s.status) {
    setStatus("Add an inquiry and a status before saving.", "error");
    return false;
  }
  try {
    const res = await fetch("/lark-record", {
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
        chatLink: s.chatUrl || activeChats.find((c) => c.chatId === chatId)?.link || "",
        dob: s.dob || "",
        telegram: !!s.telegram,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Update failed");
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
async function submitRecord(chatId, { auto, reason } = {}) {
  const s = state[chatId];
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
    return;
  }

  // Global "Don't log chats" toggle (top bar) — unlike isUnknown, this
  // deliberately does NOT set s.logged: it's a temporary gate any chat
  // passes back through once unticked, not a permanent per-chat skip, so
  // the next attempt (a manual click, the next auto-close, or the next
  // background sweep retry) records normally once logging resumes. Never
  // flagged as an error either — nothing's actually wrong.
  if (loggingPaused) {
    if (!auto) setStatus('Logging is paused — not recorded. Untick "Don\'t log chats" at the top to resume.', "error");
    return;
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
    const res = await fetch("/lark-record", {
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
        // s.chatUrl first — survives once this chat isn't the focused one
        // anymore (see checkChatStatus); activeChats[].link as a fallback
        // for anything relying on the older path.
        chatLink: s.chatUrl || activeChats.find((c) => c.chatId === chatId)?.link || "",
        dob: s.dob || "",
        telegram: !!s.telegram,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Record failed");
    s.logged = true;
    markCaseRecorded(s);
    setStatus(`Logged ${s.username} to Lark Base${auto ? ` (auto — ${reasonText.toLowerCase()})` : ""}.`, "success");
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

const loggingPauseCheck = document.getElementById("loggingPauseCheck");
loggingPauseCheck.addEventListener("change", () => {
  loggingPaused = loggingPauseCheck.checked;
  localStorage.setItem(LOGGING_PAUSED_KEY, String(loggingPaused));
  document.getElementById("loggingPauseToggle").classList.toggle("active", loggingPaused);
  logDiagnostic(loggingPaused ? "Logging paused — no chat will be recorded until this is unticked." : "Logging resumed.", loggingPaused ? "warn" : "success");
  renderChats(activeChats); // every card's bottom banner depends on this
});

// Boot sequence: fetch agent list, update badge, auto-open settings if no
// agent saved yet (first time / cleared cache).
(async () => {
  // Restore any chat state saved before this widget last reloaded — must
  // happen before the first renderChats/ensureChatState call, since
  // ensureChatState only fills in defaults for a chatId it hasn't seen yet.
  Object.assign(state, loadPersistedState());
  for (const chatId of Object.keys(state)) markStateSynced(chatId);
  loggingPauseCheck.checked = loggingPaused;
  document.getElementById("loggingPauseToggle").classList.toggle("active", loggingPaused);
  logDiagnostic("Preview mode — showing sample chats until connected to LiveChat.");
  await Promise.all([fetchAgentOptions(), fetchBrandOptions(), fetchEscalationOptions()]);
  updateAgentBadge();
  if (!selectedAgent) openSettingsPanel();
  renderChats(activeChats);
  renderNeedsAttentionPanel();
  fetchStaleRecords();
  initLiveChatSdk();
})();

// Autosave safety nets beyond the explicit saveState() calls in the click/
// input/change handlers below — covers state mutated outside those (e.g.
// applyProfile's auto brand/telegram detection, checkLastUsername,
// checkChatStatus) and the moment this iframe actually goes away.
setInterval(saveState, 3000);
// Another tab just wrote state (e.g. finished recording a chat from a Needs
// Attention "Open" tab) -- pick it up and refresh the panel right away
// instead of waiting for the next sweep. saveState() only adopts/writes
// what actually differs, so this can't ping-pong between tabs.
window.addEventListener("storage", (e) => {
  if (e.key !== STATE_STORAGE_KEY) return;
  saveState();
  renderNeedsAttentionPanel();
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

async function sweepPendingChats() {
  let persisted;
  try {
    persisted = loadPersistedState();
  } catch (_) {
    return;
  }
  const currentChatId = activeChats[0]?.chatId;
  for (const [chatId, saved] of Object.entries(persisted)) {
    if (chatId === currentChatId) continue; // already covered by its own tight poll
    if (!saved || saved.logged) continue;
    // Another agent's case (shared browser) -- theirs to record, not ours.
    if (saved.caOwner && saved.caOwner !== selectedAgent) continue;
    // Adopt the persisted copy only if this tab has no live copy of its own
    // — never clobber an in-memory one that might be ahead of what was last
    // saved.
    if (!state[chatId]) { state[chatId] = saved; markStateSynced(chatId); }
    if (saved.chatOpen === false) {
      // While logging is paused, submitRecord would just no-op anyway (see
      // its own loggingPaused check) -- skip calling it at all so a chat
      // that's permanently missing fields (or anything else that'll never
      // resolve on its own) doesn't keep re-attempting and re-logging every
      // sweep tick while the agent has deliberately paused recording.
      // Resumes retrying normally the moment logging is unticked again.
      if (loggingPaused) continue;
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
      await submitRecord(chatId, { auto: true, reason: "Retrying an earlier failed auto-record" });
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
  let persisted;
  try {
    persisted = loadPersistedState();
  } catch (_) {
    return [];
  }
  return Object.entries(persisted)
    .filter(([, s]) => s && s.chatOpen === false && !s.logged && !s.isUnknown && !s.attentionIgnored && s.autoRecordError
      && s.agentName === selectedAgent)
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
  linkSaveInFlight.add(chatId);
  try {
    const res = await fetch("/lark-record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordId, linkOnly: true, chatLink: s.chatUrl, agentName: selectedAgent }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "link save failed");
    if (s.caRecordId === recordId) s.caLinkSaved = true;
  } catch (err) {
    logDiagnostic("Couldn't save chat link to Lark yet: " + err.message, "warn");
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
    claimedPrograms: {},
    gracePeriodActivated: false,
    logged: !!((r.inquiry || []).length && r.status),
    autoRecordError: "",
    loggedSnapshot: "",
    caLinkSaved: !!r.link,
    caOwner: selectedAgent, // lark-chat-records only returns this agent's own rows
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
    records = data.records || [];
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
const STALE_POLL_MS = 60_000;
let staleRecords = [];

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

async function fetchStaleRecords() {
  if (!selectedAgent) { staleRecords = []; renderNeedsAttentionPanel(); return; }
  const agentAtRequest = selectedAgent;
  try {
    const res = await fetch("/lark-stale-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentName: agentAtRequest,
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
  let persisted = {};
  try { persisted = loadPersistedState(); } catch (_) { /* non-fatal */ }
  const localByRecord = new Map();
  for (const s of [...Object.values(persisted), ...Object.values(state)]) {
    if (s && s.caRecordId) localByRecord.set(s.caRecordId, s);
  }
  const shownLocally = new Set(getIncompleteChats().map((c) => c.recordId).filter(Boolean));
  return staleRecords
    .filter((r) => {
      if (shownLocally.has(r.recordId)) return false;
      const local = localByRecord.get(r.recordId);
      if (!local) return true;
      // Recorded since the last poll (a logged row is never blank in Lark), or still being worked on.
      return !local.logged && local.chatOpen === false;
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
  const total = incomplete.length + stale.length;
  if (!total) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  countEl.textContent = total === 1
    ? "⚠ 1 chat needs attention"
    : `⚠ ${total} chats need attention`;
  const now = Date.now();
  listEl.innerHTML = incomplete.map((c) => `
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
      <div class="na-item-reason">${r.chatEnded ? "Chat ended" : "Not finished"} — no Inquiry/Status in Lark (looked up ${formatAge(now - r.createdAt)})</div>
      <div class="na-item-actions">
        ${r.chatUrl ? `<a class="na-item-link" href="${escapeHtml(r.chatUrl)}" target="_blank">Open ↗</a>` : ""}
        <button type="button" class="na-item-ignore" data-action="removeStale" data-record="${escapeHtml(r.recordId)}" title="Delete this empty row from Lark">Remove</button>
      </div>
    </div>
  `).join("");
}

document.getElementById("needsAttentionList").addEventListener("click", (e) => {
  const staleBtn = e.target.closest("button[data-action='removeStale']");
  if (staleBtn) { removeStaleRecord(staleBtn.dataset.record, staleBtn); return; }
  const btn = e.target.closest("button[data-action='ignoreAttention']");
  if (!btn) return;
  ignoreAttention(btn.dataset.chat);
});
setInterval(fetchStaleRecords, STALE_POLL_MS);

document.getElementById("needsAttentionToggle").addEventListener("click", () => {
  const listEl = document.getElementById("needsAttentionList");
  const toggleBtn = document.getElementById("needsAttentionToggle");
  const willOpen = listEl.classList.contains("hidden");
  if (willOpen) renderNeedsAttentionPanel(); // refresh contents right before showing, not just the count badge
  listEl.classList.toggle("hidden", !willOpen);
  toggleBtn.classList.toggle("open", willOpen);
});

/* ============================================================
   AUTO-UPDATE
   Agents keep this widget open all day inside LiveChat, so a new deploy
   never reaches them until they reload. This checks the deployed files
   (app.js / style.css / index.html) for a change and reloads ONLY this
   widget's iframe -- LiveChat itself is untouched.
   - Compares each file's ETag (falls back to Last-Modified / length) from a
     no-store HEAD request; nothing needs bumping by hand.
   - Needs the same new signature on two checks in a row before acting, so a
     one-off odd response can't trigger a reload.
   - Waits until it's safe: not while the agent is typing in a box, or while
     a Look up / unclaim request is in flight.
   - saveState() runs first, so open chats and their claims survive.
   - Never reloads more than once every 2 minutes (loop guard).
   ============================================================ */
const UPDATE_CHECK_MS = 60 * 1000;
const UPDATE_RETRY_MS = 5 * 1000;
const UPDATE_FILES = ["app.js", "style.css", "index.html"];
const UPDATE_GUARD_KEY = "rc-last-auto-reload";
let updateBaseline = null;
let updateCandidate = null;
let updateReloadScheduled = false;

// version.json is written by Cloudflare at build time (see the build command
// in the setup notes) and changes on EVERY deploy, including ones that only
// touch functions/. If it isn't there, this quietly falls back to comparing
// the static files alone. Pages serves index.html for unknown paths, so the
// response must actually parse as JSON with a "version" to count.
async function fetchDeployVersion() {
  try {
    const res = await fetch("version.json", { cache: "no-store" });
    if (!res.ok) return "";
    const data = await res.json();
    return typeof data.version === "string" && data.version ? "version=" + data.version : "";
  } catch (e) {
    return "";
  }
}

async function fetchDeploySignature() {
  const [deployVersion, ...fileParts] = await Promise.all([
    fetchDeployVersion(),
    ...UPDATE_FILES.map(async (f) => {
      const res = await fetch(f, { method: "HEAD", cache: "no-store" });
      if (!res.ok) throw new Error(f + " " + res.status);
      return f + "=" + (res.headers.get("etag") || res.headers.get("last-modified") || res.headers.get("content-length") || "");
    }),
  ]);
  return [deployVersion, ...fileParts].filter(Boolean).join("|");
}

function isSafeToAutoReload() {
  const a = document.activeElement;
  const typing = !!a && (a.tagName === "TEXTAREA" || a.tagName === "SELECT" ||
    (a.tagName === "INPUT" && !["checkbox", "radio", "button"].includes(a.type)));
  const busy = Object.values(state).some((s) => s && (s.lookupInFlight || s.unclaimInFlight));
  return !typing && !busy;
}

function reloadWhenSafe() {
  if (updateReloadScheduled) return;
  updateReloadScheduled = true;
  const attempt = () => {
    if (!isSafeToAutoReload()) { setTimeout(attempt, UPDATE_RETRY_MS); return; }
    const last = Number(sessionStorage.getItem(UPDATE_GUARD_KEY) || 0);
    if (Date.now() - last < 2 * 60 * 1000) { updateReloadScheduled = false; return; }
    sessionStorage.setItem(UPDATE_GUARD_KEY, String(Date.now()));
    try { saveState(); } catch (e) { /* state is also saved every 3s */ }
    location.reload();
  };
  attempt();
}

async function checkForUpdate() {
  try {
    const sig = await fetchDeploySignature();
    if (updateBaseline === null) { updateBaseline = sig; return; }
    if (sig === updateBaseline) { updateCandidate = null; return; }
    if (sig === updateCandidate) { reloadWhenSafe(); return; }
    updateCandidate = sig; // changed once -- confirm on the next check
    setTimeout(checkForUpdate, UPDATE_RETRY_MS);
  } catch (e) {
    /* offline / blip -- try again next tick */
  }
}

checkForUpdate();
setInterval(checkForUpdate, UPDATE_CHECK_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdate(); });
