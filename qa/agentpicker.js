// "Who do you want to check?": an optional multi-choice list of agents, in the same custom style as the calendar. Nothing chosen means
// everybody. Markup: <span class="ap"> with a .ap-display button and a .ap-pop popup.
const nameKey = (name) => String(name || "").trim().replace(/\s+/g, " ").toLowerCase();

// The label on the button for a choice: "All agents", the one name, or "3 agents".
export function pickerLabel(selectedNames, total) {
  if (!selectedNames.length) return total ? `All agents (${total})` : "All agents";
  return selectedNames.length === 1 ? selectedNames[0] : `${selectedNames.length} agents`;
}

export function attachAgentPicker(root, { onOpen = () => {} } = {}) {
  const display = root.querySelector(".ap-display");
  const popup = root.querySelector(".ap-pop");
  let choices = []; // [{ name, emails }]
  let selected = new Set(); // nameKey values
  let query = "";
  let message = "";

  const names = () => choices.filter((choice) => selected.has(nameKey(choice.name))).map((choice) => choice.name);
  const syncDisplay = () => { display.textContent = pickerLabel(names(), choices.length); };
  const close = () => { popup.hidden = true; display.setAttribute("aria-expanded", "false"); };

  function render() {
    const shown = choices.filter((choice) => nameKey(choice.name).includes(nameKey(query)));
    popup.innerHTML = `
      <input type="search" class="ap-search" placeholder="Search agents…" value="${query.replace(/"/g, "&quot;")}" autocomplete="off" />
      <div class="ap-actions"><button type="button" class="ap-link" data-all>Select shown</button><button type="button" class="ap-link" data-none>Clear</button></div>
      <div class="ap-list">${message ? `<p class="ap-empty">${message}</p>` : shown.length ? shown.map((choice) => `<label class="ap-option"><input type="checkbox" data-name="${nameKey(choice.name).replace(/"/g, "&quot;")}"${selected.has(nameKey(choice.name)) ? " checked" : ""} /><span>${choice.name.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span></label>`).join("") : `<p class="ap-empty">No agent matches.</p>`}</div>`;
    const search = popup.querySelector(".ap-search");
    if (document.activeElement === document.body || query) { search.focus(); search.setSelectionRange(query.length, query.length); }
  }

  display.addEventListener("click", () => {
    if (!popup.hidden) return close();
    onOpen();
    render();
    popup.hidden = false;
    display.setAttribute("aria-expanded", "true");
  });
  popup.addEventListener("input", (event) => {
    if (!event.target.classList.contains("ap-search")) return;
    query = event.target.value;
    render();
  });
  popup.addEventListener("change", (event) => {
    const box = event.target.closest("input[data-name]");
    if (!box) return;
    if (box.checked) selected.add(box.dataset.name); else selected.delete(box.dataset.name);
    syncDisplay();
  });
  popup.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-all")) choices.filter((choice) => nameKey(choice.name).includes(nameKey(query))).forEach((choice) => selected.add(nameKey(choice.name)));
    else if (button.hasAttribute("data-none")) selected = new Set();
    else return;
    syncDisplay();
    render();
  });
  document.addEventListener("click", (event) => { if (!root.contains(event.target)) close(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
  syncDisplay();

  return {
    // The agents to choose from; a choice that is no longer in the list is dropped.
    setChoices(list) {
      choices = list;
      message = "";
      const known = new Set(list.map((choice) => nameKey(choice.name)));
      selected = new Set([...selected].filter((key) => known.has(key)));
      syncDisplay();
      if (!popup.hidden) render();
    },
    setMessage(text) { message = text; if (!popup.hidden) render(); },
    selectedNames: names,
    // The LiveChat emails of the chosen agents (an agent can have two logins), or null when nothing is chosen = everybody.
    selectedEmails() {
      const chosen = choices.filter((choice) => selected.has(nameKey(choice.name)));
      return chosen.length ? chosen.flatMap((choice) => choice.emails) : null;
    },
    reset() { selected = new Set(); syncDisplay(); },
  };
}
