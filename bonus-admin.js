const $ = (id) => document.getElementById(id);
const fields = ["recordId", "key", "label", "inquiry", "sourceTableId", "sourceBaseToken", "usernameField", "brandField", "dateField", "displayField", "rule", "ruleValue", "selection", "amountEligible", "active"];
let configs = [];
if (new URLSearchParams(location.search).get("embedded") === "1") document.body.classList.add("embedded");

function setStatus(text, kind = "") { $("adminStatus").textContent = text; $("adminStatus").className = `bonus-admin-status ${kind}`; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

function formValue() {
  const result = {};
  for (const name of fields) result[name] = ["active", "amountEligible"].includes(name) ? $(name).checked : $(name).value.trim();
  return result;
}

function clearForm() {
  $("bonusForm").reset();
  $("recordId").value = "";
  $("key").disabled = false;
  $("usernameField").value = "Username/UID";
  $("brandField").value = "Brand";
  $("dateField").value = "Time of Inspection";
  $("displayField").value = "Status";
  $("active").checked = true;
  $("formTitle").textContent = "Add regular bonus";
  toggleRuleValue();
}

function editConfig(config) {
  for (const name of fields) {
    if (["active", "amountEligible"].includes(name)) $(name).checked = !!config[name];
    else $(name).value = config[name] || "";
  }
  $("formTitle").textContent = `Edit ${config.label}`;
  $("key").disabled = true;
  toggleRuleValue();
  $("configSection").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderList() {
  $("configList").innerHTML = configs.length ? configs.map((config, index) => `
    <div class="bonus-config-row ${config.active ? "" : "inactive"}">
      <div><div class="bonus-config-title">${escapeHtml(config.label)} <code>${escapeHtml(config.key)}</code></div>
      <div class="bonus-config-meta">${escapeHtml(config.sourceTableId)} · ${escapeHtml(config.displayField)} · ${escapeHtml(config.rule.replaceAll("_", " "))}${config.ruleValue ? ` “${escapeHtml(config.ruleValue)}”` : ""} · ${escapeHtml(config.selection)} · ${config.active ? "active" : "disabled"}</div></div>
      <div class="bonus-config-actions"><button class="secondary-btn" data-edit="${index}">Edit</button><button class="secondary-btn" data-toggle="${index}">${config.active ? "Disable" : "Enable"}</button></div>
    </div>`).join("") : `<p class="bonus-admin-help">No bonuses configured yet.</p>`;
}

async function loadConfigs() {
  setStatus("Loading…");
  const res = await fetch("/bonus-config?all=1");
  const data = await res.json();
  if (!data.ok) return setStatus(data.error || "Could not load configurations", "error");
  if (!data.configured) return setStatus("Set LARK_TABLE_BONUS_CONFIG in Cloudflare first.", "error");
  configs = data.configs || [];
  $("configSection").classList.remove("hidden");
  $("listSection").classList.remove("hidden");
  renderList();
  setStatus("Configurations loaded.", "success");
}

async function saveConfig(config) {
  const res = await fetch("/bonus-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Save failed");
  await loadConfigs();
  if (window.parent !== window) window.parent.postMessage({ type: "bonus-config-changed" }, location.origin);
  clearForm();
}

function toggleRuleValue() { $("ruleValueLabel").classList.toggle("hidden", $("rule").value === "any_text"); }

$("loadConfigs").addEventListener("click", () => loadConfigs().catch((err) => setStatus(err.message, "error")));
$("clearForm").addEventListener("click", clearForm);
$("rule").addEventListener("change", toggleRuleValue);
$("bonusForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { setStatus("Saving…"); await saveConfig(formValue()); setStatus("Bonus saved and available to agents.", "success"); }
  catch (err) { setStatus(err.message, "error"); }
});
$("configList").addEventListener("click", async (event) => {
  const edit = event.target.closest("[data-edit]");
  if (edit) return editConfig(configs[Number(edit.dataset.edit)]);
  const toggle = event.target.closest("[data-toggle]");
  if (!toggle) return;
  const config = { ...configs[Number(toggle.dataset.toggle)] };
  config.active = !config.active;
  try { setStatus("Saving…"); await saveConfig(config); setStatus(config.active ? "Bonus enabled." : "Bonus disabled.", "success"); }
  catch (err) { setStatus(err.message, "error"); }
});
toggleRuleValue();
loadConfigs().catch((err) => setStatus(err.message, "error"));


// ---- LiveChat groups (read-only) ----
const GROUP_LICENSES = { lc1: "License 1", lc2: "License 2" };
function savedLiveChatToken(key) {
  try {
    const own = Number(sessionStorage.getItem(`ca-admin-livechat-expiry:${key}`) || 0);
    if (own > Date.now()) return sessionStorage.getItem(`ca-admin-livechat-token:${key}`) || "";
    const widget = Number(sessionStorage.getItem(`ca-livechat-agent-token-expiry:${key}`) || 0);
    if (widget > Date.now()) return sessionStorage.getItem(`ca-livechat-agent-token:${key}`) || "";
    const shared = JSON.parse(localStorage.getItem(`ca-livechat-login-backup:${key}`) || "null");
    if (shared?.token && shared.expiresAt > Date.now()) return shared.token;
  } catch (_) { }
  return "";
}
function groupTokens() {
  const tokens = {};
  for (const key of Object.keys(GROUP_LICENSES)) { const token = savedLiveChatToken(key); if (token) tokens[key] = token; }
  return tokens;
}
function setGroupStatus(text, kind = "") { $("groupStatus").textContent = text; $("groupStatus").className = `bonus-admin-status ${kind}`; }

async function connectLiveChat(key) {
  const config = await (await fetch("/livechat-oauth-config", { cache: "no-store" })).json();
  const client = (config.clients || []).find((c) => c.key === key);
  if (!client) throw new Error(`${GROUP_LICENSES[key]} is not configured for LiveChat login.`);
  const state = crypto.randomUUID();
  const redirectUri = config.redirectUri || `${location.origin}/blast/oauth.html`;
  const url = new URL("https://accounts.livechat.com/");
  url.search = new URLSearchParams({ response_type: "token", client_id: client.clientId, redirect_uri: redirectUri, state, prompt: "consent" }).toString();
  const popup = window.open(url, "livechat-agent-oauth", "popup=yes,width=560,height=720");
  if (!popup) throw new Error("Your browser blocked the LiveChat login window. Allow popups and try again.");
  let callbackOrigin = location.origin;
  try { callbackOrigin = new URL(redirectUri).origin; } catch (_) { }
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.origin !== callbackOrigin || event.data?.source !== "ca-livechat-oauth" || event.data.state !== state) return;
      window.removeEventListener("message", onMessage);
      if (event.data.type !== "SUCCESS") return reject(new Error(event.data.error || "LiveChat login was not completed."));
      sessionStorage.setItem(`ca-admin-livechat-token:${key}`, event.data.token);
      sessionStorage.setItem(`ca-admin-livechat-expiry:${key}`, String(event.data.expiresAt));
      resolve();
    };
    window.addEventListener("message", onMessage);
  });
}

function renderGroupLogins() {
  const tokens = groupTokens();
  $("groupLogins").innerHTML = Object.entries(GROUP_LICENSES).map(([key, label]) =>
    `<button type="button" class="secondary-btn" data-connect="${key}">${tokens[key] ? "✓ " : ""}${escapeHtml(label)}${tokens[key] ? " signed in" : " — sign in with LiveChat"}</button>`).join(" ");
}

async function loadGroups() {
  const tokens = groupTokens();
  if (!Object.keys(tokens).length) { $("groupList").innerHTML = ""; return setGroupStatus("Sign in with LiveChat for at least one license first.", "error"); }
  setGroupStatus("Loading groups…");
  const res = await fetch("/livechat-groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentTokens: tokens }) });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Could not load groups.");
  $("groupList").innerHTML = data.licenses.map((license) => {
    const label = GROUP_LICENSES[license.accountKey] || license.accountKey;
    if (!license.ok) return `<h3>${escapeHtml(label)}</h3><p class="bonus-admin-status error">${escapeHtml(license.error || "Failed")}</p>`;
    const rows = license.groups.map((g) => `<tr><td class="mono">${escapeHtml(g.id)}</td><td>${escapeHtml(g.name)}</td></tr>`).join("");
    return `<h3>${escapeHtml(label)} <small>(${license.groups.length} groups)</small></h3><table class="bonus-group-table"><thead><tr><th>ID</th><th>Name</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join("");
  setGroupStatus("");
}

$("groupLogins").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-connect]");
  if (!button) return;
  try { setGroupStatus("Complete the login in the new window…"); await connectLiveChat(button.dataset.connect); renderGroupLogins(); await loadGroups(); }
  catch (err) { setGroupStatus(err.message, "error"); }
});
$("loadGroups").addEventListener("click", () => loadGroups().catch((err) => setGroupStatus(err.message, "error")));
renderGroupLogins();
