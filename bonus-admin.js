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
