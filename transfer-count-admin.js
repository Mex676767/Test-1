(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const LICENSE_LABEL = { lc1: "License 1", lc2: "License 2" };
  const RETRY_WAITS = [3000, 8000, 15000];
  const DAY_MS = 86_400_000;
  let stopRequested = false;
  let busy = false;

  function setStatus(text, kind = "") { $("tcStatus").textContent = text; $("tcStatus").className = `bonus-admin-status ${kind}`; }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function api(body) {
    const response = await fetch("/livechat-transfer-count", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-scan-key": $("tcKey").value.trim() },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!data) throw Object.assign(new Error(`The server answered HTTP ${response.status}.`), { status: response.status });
    if (!data.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
    return data;
  }

  // Numbers add up, objects merge key by key, lists (samples) are joined and capped.
  function merge(into, add) {
    for (const [key, value] of Object.entries(add)) {
      if (typeof value === "number") into[key] = (into[key] || 0) + value;
      else if (Array.isArray(value)) into[key] = [...(into[key] || []), ...value].slice(0, 20);
      else if (value && typeof value === "object") into[key] = merge(into[key] || {}, value);
    }
    return into;
  }

  function dayAfter(date) {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d) + DAY_MS).toISOString().slice(0, 10);
  }

  function allDays(from, toExclusive) {
    const days = [];
    for (let day = from; day < toExclusive; day = dayAfter(day)) days.push(day);
    return days;
  }

  async function runLicense(accountKey, from, to, onProgress) {
    const run = { accountKey, totals: {}, groups: {}, trackedMissing: [], agentsError: "", pages: 0, done: false, error: "" };
    let pageId = "";
    while (!stopRequested) {
      let data = null;
      for (let attempt = 0; ; attempt += 1) {
        try { data = await api({ accountKey, from, to, pageId }); break; }
        catch (err) {
          if ([400, 401, 404, 405].includes(err.status) || attempt >= RETRY_WAITS.length) { run.error = err.message; run.status = err.status; return run; }
          onProgress(run, `LiveChat is busy (${err.message}). Trying again in ${RETRY_WAITS[attempt] / 1000}s…`);
          await sleep(RETRY_WAITS[attempt]);
        }
      }
      merge(run.totals, data.totals);
      run.groups = data.groups;
      run.trackedMissing = data.trackedMissing;
      run.agentsError = data.agentsError;
      run.pages += 1;
      pageId = data.nextPageId;
      run.found = data.found;
      onProgress(run, "");
      if (!pageId) { run.done = true; return run; }
    }
    return run;
  }

  function table(rows, head) {
    if (!rows.length) return `<p class="bonus-admin-help">None.</p>`;
    return `<table class="tc-table"><thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ""}>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell, i) => `<td${i ? ' class="num"' : ""}>${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }

  function renderRun(run, days) {
    const t = run.totals;
    const num = (value) => Number(value || 0).toLocaleString("en-US");
    const name = (id) => (run.groups[id] ? `${run.groups[id]} (${id})` : `Group ${id}`);
    const byGroup = (map) => Object.entries(map || {}).sort((a, b) => b[1] - a[1]).map(([id, count]) => [name(id), num(count)]);
    const state = run.error ? `<span class="tc-bad">Stopped: ${esc(run.error.replace(/\.$/, ""))}. The numbers below are only the part counted so far.</span>`
      : run.done ? "Complete." : "Partial: stopped before the end. The numbers below are only the part counted so far.";
    const warnings = [
      run.trackedMissing?.length ? `These tracked group IDs do not exist in this LiveChat license: ${run.trackedMissing.join(", ")}. The license may be mapped the wrong way round; do not trust these numbers until that is checked.` : "",
      run.agentsError ? `Agent names could not be loaded (${run.agentsError}), so transfers straight to an agent may show as unclassified.` : "",
      t.mismatchThreads ? `${num(t.mismatchThreads)} chat(s) ended in a different group than their last transfer says. Open one with “Check one chat” to see why.` : "",
    ].filter(Boolean).map((text) => `<p class="tc-warn">${esc(text)}</p>`).join("");
    return `
      <article class="tc-result">
        <h3>${esc(LICENSE_LABEL[run.accountKey])}</h3>
        <p class="bonus-admin-help">${state} ${num(t.threads)} archived chats read in ${num(run.pages)} page(s).</p>
        ${warnings}
        <div class="tc-big"><strong>${num(t.counted)}</strong> transfers counted</div>
        <table class="tc-table"><tbody>
          <tr><td>Transfers found in the dates</td><td class="num">${num(t.transfers)}</td></tr>
          <tr><td>Counted (tracked source group → a different, non-tracked group)</td><td class="num">${num(t.counted)}</td></tr>
          <tr><td>Not counted: destination is a tracked group</td><td class="num">${num(t.destTracked)}</td></tr>
          <tr><td>Not counted: source group is not tracked</td><td class="num">${num(t.sourceUntracked)}</td></tr>
          <tr><td>Not counted: same group again</td><td class="num">${num(t.sameGroup)}</td></tr>
          <tr><td>Ignored: sent straight to an agent</td><td class="num">${num(t.ignoredAgent)}</td></tr>
          <tr class="tc-open"><td>Undetermined: first transfer of a chat, source group is not kept in the archive. It counts only if that source was tracked.</td><td class="num">${num(t.undetermined)}</td></tr>
          <tr class="tc-open"><td>Unclassified: destination not recognised</td><td class="num">${num(t.unclassified)}</td></tr>
        </tbody></table>
        ${t.unclassifiedSamples?.length ? `<details><summary>Unclassified examples</summary><pre>${esc(t.unclassifiedSamples.join("\n"))}</pre></details>` : ""}
        <h4>Counted per day (Kuala Lumpur time)</h4>
        ${table(days.map((day) => [day, num(t.byDay?.[day])]), ["Day", "Counted"])}
        <h4>Counted per destination group</h4>${table(byGroup(t.byDestination), ["Destination", "Counted"])}
        <h4>Counted per source group</h4>${table(byGroup(t.bySource), ["Source", "Counted"])}
        <h4>Undetermined per destination group</h4>${table(byGroup(t.undeterminedByDestination), ["Destination", "Undetermined"])}
      </article>`;
  }

  async function count() {
    if (busy) return;
    const from = $("tcFrom").value;
    const lastDay = $("tcTo").value;
    const accounts = ["lc1", "lc2"].filter((key) => $(`tc_${key}`).checked);
    if (!$("tcKey").value.trim()) return setStatus("Enter the admin key first.", "error");
    if (!from || !lastDay || lastDay < from) return setStatus("Choose a first day and a last day that is not earlier.", "error");
    if (!accounts.length) return setStatus("Choose at least one license.", "error");
    const to = dayAfter(lastDay);
    const days = allDays(from, to);
    busy = true; stopRequested = false;
    $("tcRun").disabled = true; $("tcStop").disabled = false; $("tcResults").innerHTML = "";
    const finished = [];
    const failures = [];
    const show = () => { $("tcResults").innerHTML = finished.join(""); };
    try {
      for (const accountKey of accounts) {
        if (stopRequested) break;
        const slot = finished.length;
        const run = await runLicense(accountKey, from, to, (progress, note) => {
          setStatus(note || `${LICENSE_LABEL[accountKey]}: ${progress.pages} page(s) read, ${Number(progress.totals.threads || 0).toLocaleString("en-US")} chats so far${progress.found ? ` (about ${Number(progress.found).toLocaleString("en-US")} in the dates)` : ""}…`);
          finished[slot] = renderRun(progress, days);
          show();
        });
        finished[slot] = renderRun(run, days);
        show();
        if (run.error) failures.push(`${LICENSE_LABEL[accountKey]}: ${run.error.replace(/\.$/, "")}`);
        if (run.status === 401 || run.status === 404) {
          finished.length = 0; show();
          return setStatus(run.status === 401 ? "The admin key was not accepted." : "This feature is not switched on (SCAN_KEY is not set in Cloudflare).", "error");
        }
      }
      if (failures.length) setStatus(`Stopped early: ${failures.join(" / ")}. Numbers marked "Stopped" are partial.`, "error");
      else setStatus(stopRequested ? "Stopped." : "Finished.", stopRequested ? "" : "success");
    } catch (err) {
      setStatus(err.message, "error");
    } finally {
      busy = false; $("tcRun").disabled = false; $("tcStop").disabled = true;
    }
  }

  async function probe() {
    const chatId = $("tcChat").value.trim();
    if (!$("tcKey").value.trim()) return setStatus("Enter the admin key first.", "error");
    if (!chatId) return setStatus("Paste a chat ID first.", "error");
    $("tcProbeOut").textContent = "Reading…";
    try {
      const data = await api({ accountKey: $("tcChatLicense").value, step: "probe", chatId });
      $("tcProbeOut").textContent = JSON.stringify({ license: data.license, found: data.found, trackedMissing: data.trackedMissing, agentsError: data.agentsError, threads: data.threads, groupNames: data.groups }, null, 2);
    } catch (err) {
      $("tcProbeOut").textContent = `Could not read the chat: ${err.message}`;
    }
  }

  $("tcRun").addEventListener("click", count);
  $("tcStop").addEventListener("click", () => { stopRequested = true; setStatus("Stopping after the current page…"); });
  $("tcProbe").addEventListener("click", probe);
})();
