const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const pad = (n) => String(n).padStart(2, "0");
const iso = (year, month, day) => `${year}-${pad(month + 1)}-${pad(day)}`;
const parse = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  return match ? { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) } : null;
};
const todayParts = () => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() }; };

export function calendarDays(year, month) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(year, month, 1 - offset + i);
    return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate(), otherMonth: date.getMonth() !== month };
  });
}

export const displayDate = (value) => { const p = parse(value); return p ? `${pad(p.day)}/${pad(p.month + 1)}/${p.year}` : ""; };

export function attachDatePicker(root, { placeholder = "dd/mm/yyyy", firstYear = 2024 } = {}) {
  const input = root.querySelector("input");
  const display = root.querySelector(".dp-display");
  const popup = root.querySelector(".dp-pop");
  let view = todayParts();
  let jump = "";

  const close = () => { popup.hidden = true; jump = ""; display.setAttribute("aria-expanded", "false"); };
  const syncDisplay = () => { display.textContent = displayDate(input.value) || placeholder; display.classList.toggle("placeholder", !input.value); };

  function render() {
    const selected = parse(input.value);
    const today = todayParts();
    const lastYear = today.year;
    const years = Array.from({ length: lastYear - firstYear + 1 }, (_, i) => lastYear - i);
    const list = jump === "month"
      ? MONTHS.map((name, i) => `<button type="button" class="dp-option${i === view.month ? " active" : ""}" data-month="${i}">${name}</button>`).join("")
      : jump === "year" ? years.map((y) => `<button type="button" class="dp-option${y === view.year ? " active" : ""}" data-year="${y}">${y}</button>`).join("") : "";
    popup.innerHTML = `
      <div class="dp-header">
        <button type="button" class="dp-nav" data-nav="-1" title="Previous month">‹</button>
        <button type="button" class="dp-jump" data-jump="month">${MONTHS[view.month]}</button>
        <button type="button" class="dp-jump" data-jump="year">${view.year}</button>
        <button type="button" class="dp-nav" data-nav="1" title="Next month">›</button>
      </div>
      ${jump ? `<div class="dp-list">${list}</div>` : `
      <div class="dp-weekdays">${WEEKDAYS.map((w) => `<span>${w}</span>`).join("")}</div>
      <div class="dp-grid">${calendarDays(view.year, view.month).map((cell) => {
        const isSelected = selected && selected.year === cell.year && selected.month === cell.month && selected.day === cell.day;
        const isToday = today.year === cell.year && today.month === cell.month && today.day === cell.day;
        return `<button type="button" class="dp-day${cell.otherMonth ? " other" : ""}${isToday ? " today" : ""}${isSelected ? " selected" : ""}" data-date="${iso(cell.year, cell.month, cell.day)}">${cell.day}</button>`;
      }).join("")}</div>
      <div class="dp-footer"><button type="button" class="dp-link" data-clear>Clear</button><button type="button" class="dp-link" data-today>Today</button></div>`}`;
  }

  function pick(value) {
    input.value = value;
    syncDisplay();
    close();
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  display.addEventListener("click", () => {
    if (!popup.hidden) return close();
    const selected = parse(input.value);
    view = selected ? { year: selected.year, month: selected.month, day: 1 } : todayParts();
    jump = "";
    render();
    popup.hidden = false;
    display.setAttribute("aria-expanded", "true");
  });

  popup.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.date) return pick(target.dataset.date);
    if (target.hasAttribute("data-clear")) return pick("");
    if (target.hasAttribute("data-today")) { const t = todayParts(); return pick(iso(t.year, t.month, t.day)); }
    if (target.dataset.nav) {
      const moved = new Date(view.year, view.month + Number(target.dataset.nav), 1);
      view = { year: moved.getFullYear(), month: moved.getMonth(), day: 1 };
    } else if (target.dataset.jump) {
      jump = jump === target.dataset.jump ? "" : target.dataset.jump;
    } else if (target.dataset.month !== undefined) {
      view.month = Number(target.dataset.month);
      jump = "";
    } else if (target.dataset.year !== undefined) {
      view.year = Number(target.dataset.year);
      jump = "";
    }
    render();
  });

  document.addEventListener("click", (event) => { if (!root.contains(event.target)) close(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
  input.addEventListener("input", syncDisplay);
  syncDisplay();
  return { setValue(value) { input.value = value; syncDisplay(); } };
}
