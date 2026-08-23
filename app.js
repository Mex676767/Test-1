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
function isClaimableValue(v) {
  return !!(v && v.trim() && !NO_BONUS_PATTERN.test(v));
}

// Ang Pao (Special Reload Event) and Redeem Code live in their own tables
// (tblxxz5EUdRbR4qk / tbl6cMG2f036Bn5E), matched by Username + Brand — not
// columns on the Customer Approaching row. Both hide on Expired/Claimed;
// Redeem Code's "Status" column holds the literal code when available, or
// the word "Claimed" when it's used up.
function isHiddenStatus(v) {
  const t = (v || "").trim().toLowerCase();
  return t === "expired" || t === "claimed";
}

// Simulates the real Lark base: same username can exist under multiple
// brands with completely different bonus states — matching must require
// BOTH Username AND Brand, never username alone. Now live — this calls the
// real Netlify Function, which searches Lark filtered on both fields.
async function fetchBonusRow(username, brand) {
  const res = await fetch("/.netlify/functions/lark-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, brand }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Lookup failed");
  return { row: data.row, otherBrands: data.otherBrands || [] };
}

const SAMPLE_CHATS = [
  { chatId: "c1", customerName: "VS96 VIP", link: "https://my.livechatinc.com/chats/c1", isTelegram: false, groupName: "VS96 Priority Support" },
  { chatId: "c2", customerName: "MAX39 Priority", link: "https://my.livechatinc.com/chats/c2", isTelegram: true, groupName: "MAX39 Priority Support" },
];

// Every LiveChat group is named "<BRAND><NUMBERS> Priority Support" — the
// Brand field in Lark stores just the letters (e.g. "VS96 Priority Support"
// -> "VS", "ACE33 Priority Support" -> "ACE"). Strip trailing digits AND the
// "Priority Support" suffix. Real version reads group_id from the LiveChat
// API and checks a Lark override table first, falling back to this parser.
function deriveBrandFromGroup(groupName) {
  if (!groupName) return "";
  return groupName
    .replace(/priority support/i, "")
    .replace(/\d+/g, "")
    .trim();
}

// NOTE: this list is large and clearly still growing on the Lark side (the
// real table shows dozens of Inquiry tags). This is a snapshot for the demo —
// the real build should fetch these live from Lark's field metadata so new
// tags show up automatically without a redeploy.
const inquiryOptions = [
  "Free Spin", "Ang Pao", "Deposit Challenge", "Feedback", "Complain",
  "Ask free credit", "WD/DP problem", "Angpao request", "Game Tips",
  "System problem", "Promotion", "Referral Bonus", "Bank problem",
  "Technical Issue", "Betting inquiries", "Others", "Unknown",
  "Account Inquiries", "Rebate", "Game Bonus", "Pg Maintenance",
  "VIP Salary", "Unable to Access Game", "Bonus Checking", "Unrelated",
  "Unable Log In", "RAYA PROMOTION", "No Inquiry", "Sportsbook",
  "Unable To Access Website", "Reload - Free Spin", "Reload - Ang Pao",
  "Free Spin Request", "Website Inquiries", "Lucky Wheel", "Plinko",
  "VIP Upgrade SMS", "Apps Download", "Cashback", "VIP SMS", "Redeem Code",
  "VVIP COMPLAINT", "KYC", "OTP Failure", "Forgot Username", "Forgot Password",
  "Missing Fund", "Sms Promo", "Telegram", "Birthday", "LuckyDraw",
];

const statusOptions = ["Solved", "Unsolved", "Given", "Not given", "Activated"];

/* ============================================================
   RENDER
   ============================================================ */
const chatListEl = document.getElementById("chatList");
const statusEl = document.getElementById("statusBar");
const state = {}; // chatId -> { username, bonus, claimed, brand, inquiry, telegram, logged }

function optionTags(list, placeholder) {
  return `<option value="">${placeholder}</option>` + list.map((v) => `<option value="${v}">${v}</option>`).join("");
}

function renderPlayerInfo(chatId) {
  const s = state[chatId];
  if (!s.matchedRow) return "";
  const r = s.matchedRow;
  return `
    <div class="player-info">
      <span><span class="pi-label">PIC</span> ${r.pic}</span>
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

  if (r.redeemCode && r.redeemCode.status.trim().toLowerCase() !== "claimed") {
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

function renderInquiryPicker(chatId) {
  const s = state[chatId];
  const maxed = s.inquiry.length >= 2;
  return inquiryOptions.map((opt) => {
    const active = s.inquiry.includes(opt);
    const disable = maxed && !active;
    return `
    <label class="tag-check ${active ? "active" : ""} ${disable ? "disabled" : ""}">
      <input type="checkbox" value="${opt}" ${active ? "checked" : ""} ${disable ? "disabled" : ""} />
      <span>${opt}</span>
    </label>`;
  }).join("");
}

function renderAutoFields(chatId) {
  const s = state[chatId];
  return `
    <div class="auto-grid">
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

function renderChats(chats) {
  chatListEl.innerHTML = "";

  if (!chats.length) {
    chatListEl.innerHTML = `<div class="empty-state">No active chats detected right now. Open a chat and hit refresh.</div>`;
    return;
  }

  for (const chat of chats) {
    if (!state[chat.chatId]) {
      state[chat.chatId] = {
        username: "", matchedRow: undefined, otherBrandMatches: [], claimedPrograms: {},
        brand: deriveBrandFromGroup(chat.groupName),
        inquiry: [], status: "", telegram: chat.isTelegram, logged: false,
        releasedBonusAmount: "", claimSecret: false,
      };
    }
    const s = state[chat.chatId];

    const card = document.createElement("div");
    card.className = "chat-card";
    card.dataset.chatId = chat.chatId;

    card.innerHTML = `
      <div class="chat-card-head">
        <span class="chat-name">${chat.customerName}</span>
        <a class="chat-link" href="${chat.link}" target="_blank">Open ↗</a>
      </div>

      <label class="field-label">Username</label>
      <div class="username-row">
        <input type="text" class="input mono username-input" placeholder="Player username / UID" value="${s.username}" />
        <button class="lookup-btn" data-action="lookup" data-chat="${chat.chatId}">Look up</button>
      </div>

      <div class="player-info-slot">${renderPlayerInfo(chat.chatId)}</div>
      <div class="ticket-slot">${renderTickets(chat.chatId)}</div>
      <div class="auto-fields-slot">${renderAutoFields(chat.chatId)}</div>

      <label class="field-label">Brand <span class="auto-tag">auto-detected</span></label>
      <input type="text" class="input brand-input" value="${s.brand}" placeholder="Brand" />

      <label class="field-label">Inquiry <span class="hint">(select all that apply)</span></label>
      <div class="tag-picker">${renderInquiryPicker(chat.chatId)}</div>

      <label class="field-label">Status</label>
      <select class="status-select">${optionTags(statusOptions, "Select status…")}</select>

      <div class="toggle-row">
        <label class="field-label">Telegram chat <span class="auto-tag">auto</span></label>
        <label class="switch">
          <input type="checkbox" class="tg-check" ${s.telegram ? "checked" : ""} disabled />
          <span class="slider"></span>
        </label>
      </div>

      ${
        s.logged
          ? `<div class="logged-badge">✓ Logged to Lark Base</div>`
          : `<button class="submit-btn" data-action="submit" data-chat="${chat.chatId}">Record to Lark Base</button>`
      }
    `;

    chatListEl.appendChild(card);
    if (s.status) card.querySelector(".status-select").value = s.status;
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
    const username = card.querySelector(".username-input").value.trim();
    if (!username) { setStatus("Enter a username before looking up.", "error"); return; }
    const brand = card.querySelector(".brand-input").value.trim();
    if (!brand) { setStatus("Brand couldn't be detected — check it before looking up.", "error"); return; }
    s.username = username;
    btn.disabled = true;
    btn.textContent = "…";
    try {
      const { row, otherBrands } = await fetchBonusRow(username, brand);
      s.matchedRow = row;
      s.otherBrandMatches = otherBrands;
      s.claimedPrograms = {};
      s.releasedBonusAmount = "";
      s.claimSecret = false;
      setStatus(row ? `Found ${username} under ${brand}.` : "No record found.");
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
    // Released Amount + Claim Secret auto-fill the moment ANY ticket is
    // claimed — verbatim text from whichever source matched (regular column,
    // Ang Pao, or Redeem Code), no guessing at numbers.
    const allSources = [
      ...BONUS_PROGRAMS.map((p) => ({ key: p.key, label: p.label, display: r[p.key] })),
      { key: "angPao", label: "Ang Pao (Special Reload Event)", display: r.angPao?.status },
      { key: "redeemCode", label: "Redeem Code", display: r.redeemCode?.status },
    ];
    const claimedEntries = allSources
      .filter((src) => s.claimedPrograms[src.key])
      .map((src) => `${src.label}: ${src.display}`);
    s.releasedBonusAmount = claimedEntries.join(" | ");
    s.claimSecret = true;
    card.querySelector(".ticket-slot").innerHTML = renderTickets(chatId);
    card.querySelector(".auto-fields-slot").innerHTML = renderAutoFields(chatId);
  }

  if (btn.dataset.action === "submit") {
    const brand = card.querySelector(".brand-input").value.trim();
    const status = card.querySelector(".status-select").value;
    if (!brand || !s.inquiry.length || !status) {
      setStatus("Pick a brand, at least one inquiry, and a status before recording.", "error");
      return;
    }
    if (!s.username) { setStatus("Enter the username before recording.", "error"); return; }

    s.brand = brand;
    s.status = status;

    const chatDef = SAMPLE_CHATS.find((c) => c.chatId === chatId);

    btn.disabled = true;
    btn.textContent = "Recording…";
    try {
      const res = await fetch("/.netlify/functions/lark-record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: s.username,
          nameCustomer: s.matchedRow?.nameCustomer || "",
          brand: s.brand,
          inquiry: s.inquiry,
          status: s.status,
          link: chatDef?.link || "",
          telegram: s.telegram,
          releasedAmount: s.releasedBonusAmount,
          claimSecret: s.claimSecret,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Record failed");
      s.logged = true;
      setStatus(`Logged ${s.username} to Lark Base.`, "success");
      renderChats(SAMPLE_CHATS);
    } catch (err) {
      setStatus("Recording failed: " + err.message, "error");
      btn.disabled = false;
      btn.textContent = "Record to Lark Base";
    }
  }
});

chatListEl.addEventListener("change", (e) => {
  const checkbox = e.target.closest(".tag-picker input[type=checkbox]");
  if (!checkbox) return;
  const card = checkbox.closest(".chat-card");
  const chatId = card.dataset.chatId;
  const s = state[chatId];
  const val = checkbox.value;

  if (checkbox.checked) {
    // Rule: max 2 inquiries per case, and if picking a 2nd, one of the two
    // must be "Feedback" (e.g. Unknown+Feedback is fine, Unknown+Other is not).
    if (s.inquiry.length >= 2) {
      checkbox.checked = false;
      setStatus("Only 2 inquiries can be selected per case.", "error");
      return;
    }
    if (s.inquiry.length === 1) {
      const existing = s.inquiry[0];
      if (existing !== "Feedback" && val !== "Feedback") {
        checkbox.checked = false;
        setStatus('When picking 2 inquiries, one of them must be "Feedback".', "error");
        return;
      }
    }
    s.inquiry.push(val);
  } else {
    s.inquiry = s.inquiry.filter((v) => v !== val);
  }

  // Re-render so unselected boxes grey out once 2 are picked.
  card.querySelector(".tag-picker").innerHTML = renderInquiryPicker(chatId);
});

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = "status-bar" + (kind ? " " + kind : "");
}

document.getElementById("refreshBtn").addEventListener("click", () => {
  setStatus("Preview mode — showing sample chats until connected to LiveChat.");
  renderChats(SAMPLE_CHATS);
});
document.getElementById("openSettings").addEventListener("click", (e) => e.preventDefault());
document.getElementById("dumpRaw").addEventListener("click", (e) => {
  e.preventDefault();
  console.log("State:", state);
  setStatus("Current state logged to console (F12 → Console tab).");
});

renderChats(SAMPLE_CHATS);
