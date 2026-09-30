/* Web version of LC V4. Queue data remains in this browser; sends use the
 * signed-in agent's OAuth token, never the shared admin PAT. */
(() => {
  if (globalThis.chrome?.storage?.local && globalThis.chrome?.runtime?.sendMessage) return;

  const storageListeners = [];
  const runtimeListeners = [];
  const prefix = "ca-livechat-engagement:";
  const TOKEN_KEY = "ca-livechat-agent-token";
  const TOKEN_EXPIRY_KEY = "ca-livechat-agent-token-expiry";
  const STATE_KEY = "ca-livechat-oauth-state";
  const PENDING_ACCOUNT_KEY = "ca-livechat-oauth-pending-account";
  const SELECTED_ACCOUNT_KEY = "ca-livechat-selected-account";
  let stopRequested = false;

  const readArea = (name) => { try { return JSON.parse(localStorage.getItem(prefix + name) || "{}"); } catch (_) { return {}; } };
  const writeArea = (name, next, previous) => {
    localStorage.setItem(prefix + name, JSON.stringify(next));
    const changes = {};
    new Set([...Object.keys(previous), ...Object.keys(next)]).forEach((key) => {
      if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changes[key] = { oldValue: previous[key], newValue: next[key] };
    });
    if (Object.keys(changes).length) storageListeners.forEach((fn) => fn(changes, name));
  };
  const pick = (data, keys) => {
    if (keys == null) return { ...data };
    if (typeof keys === "string") return { [keys]: data[keys] };
    if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, data[key]]));
    return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, data[key] ?? fallback]));
  };
  const area = (name) => ({
    get(keys, callback) { const value = pick(readArea(name), keys); callback?.(value); return Promise.resolve(value); },
    set(values, callback) { const old = readArea(name); writeArea(name, { ...old, ...values }, old); callback?.(); return Promise.resolve(); },
    remove(keys, callback) { const old = readArea(name); const next = { ...old }; (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete next[key]); writeArea(name, next, old); callback?.(); return Promise.resolve(); },
    clear(callback) { const old = readArea(name); writeArea(name, {}, old); callback?.(); return Promise.resolve(); },
  });
  const emit = (message) => runtimeListeners.forEach((fn) => fn(message, {}, () => {}));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const selectedAccount = () => sessionStorage.getItem(SELECTED_ACCOUNT_KEY) || "lc1";
  const accountStorageKey = (base, accountKey) => `${base}:${accountKey || selectedAccount()}`;
  const token = (accountKey = selectedAccount()) => Number(sessionStorage.getItem(accountStorageKey(TOKEN_EXPIRY_KEY, accountKey)) || 0) > Date.now()
    ? sessionStorage.getItem(accountStorageKey(TOKEN_KEY, accountKey)) || ""
    : "";

  function extractIds(url) {
    try {
      const path = new URL(url).pathname.split("/").filter(Boolean);
      const chats = path.indexOf("chats");
      if (chats >= 0 && path[chats + 1]) return { chatId: path[chats + 1], threadId: path[chats + 2] || "" };
      const archives = path.indexOf("archives");
      return { chatId: "", threadId: archives >= 0 ? path[archives + 1] || "" : "" };
    } catch (_) { return { chatId: "", threadId: "" }; }
  }

  function recordFailure(job, index, stage, reason) {
    const old = readArea("local");
    const entry = { timestamp: new Date().toISOString(), jobNumber: Number(job?.queueIndex ?? index) + 1, threadId: extractIds(job?.url || "").threadId, url: job?.url || "", stage, reason };
    writeArea("local", { ...old, failureLog: [entry, ...(old.failureLog || [])].slice(0, 500) }, old);
  }

  async function resolveChat(url) {
    const ids = extractIds(url);
    if (ids.chatId) return { ...ids, isActive: null };
    if (!ids.threadId) throw new Error("The LiveChat archive link is invalid.");
    const response = await fetch("/livechat-chat-status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: ids.threadId }) });
    const data = await response.json();
    if (!response.ok || !data.ok || !data.chatId) throw new Error(data.error || "This archive is outside the recent lookup window.");
    if (data.accountKey && data.accountKey !== selectedAccount()) {
      throw new Error(`This link belongs to ${data.accountKey === "lc1" ? "LiveChat Account 1" : "LiveChat Account 2"}. Switch accounts above before sending.`);
    }
    return { chatId: data.chatId, threadId: ids.threadId, isActive: data.isActive };
  }

  async function action(name, body, formData) {
    const accessToken = token();
    if (!accessToken) throw new Error("Your agent authorization expired. Connect LiveChat again.");
    const response = await fetch(`https://api.livechatinc.com/v3.6/agent/action/${name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, ...(formData ? {} : { "Content-Type": "application/json" }) },
      body: formData || JSON.stringify(body || {}),
    });
    const text = await response.text();
    let data = {}; try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!response.ok || data.error) throw new Error(data.error?.message || data.error || `${name} failed (${response.status})`);
    return data;
  }

  const dataUrlFile = (dataUrl, fileName) => {
    const [meta, encoded] = dataUrl.split(",");
    const mime = /data:([^;]+)/.exec(meta)?.[1] || "application/octet-stream";
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    return new File([bytes], fileName || "image.png", { type: mime });
  };

  async function sendImage(chatId, job) {
    let file;
    if (job.imageDataUrl) file = dataUrlFile(job.imageDataUrl, job.imageFileName);
    else if (job.imageUrl) {
      const response = await fetch(job.imageUrl);
      if (!response.ok) throw new Error(`Image download failed (${response.status}).`);
      const blob = await response.blob();
      file = new File([blob], job.imageFileName || job.imageUrl.split("/").pop() || "image", { type: blob.type });
    }
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    const uploaded = await action("upload_file", null, form);
    await action("send_event", { chat_id: chatId, event: { type: "file", url: uploaded.url, visibility: "all", alternative_text: file.name } });
  }

  async function runJob(job, index, total, delay) {
    let resumed = false;
    let chatId = "";
    try {
      emit({ type: "PROGRESS", text: `Opening chat ${index + 1} of ${total}…`, progress: `${index + 1}/${total}`, log: `Opening ${job.url}`, logType: "info" });
      const chat = await resolveChat(job.url);
      chatId = chat.chatId;
      if (chat.isActive !== true) { await action("resume_chat", { chat: { id: chat.chatId } }); resumed = true; }
      for (let i = 0; i < job.messages.length; i += 1) {
        if (stopRequested) throw new Error("Stopped by user");
        await action("send_event", { chat_id: chat.chatId, event: { type: "message", text: job.messages[i], visibility: "all" } });
        if (i < job.messages.length - 1) await sleep(delay);
      }
      await sendImage(chat.chatId, job);
      if (resumed) {
        await action("deactivate_chat", { id: chat.chatId, ignore_requester_presence: true });
        resumed = false;
      }
      emit({ type: "PROGRESS", text: `Completed chat ${index + 1} of ${total}`, progress: `${index + 1}/${total}`, log: `✓ Chat ${index + 1} sent as the connected agent`, logType: "ok" });
    } catch (error) {
      recordFailure(job, index, "LiveChat API", error.message);
      emit({ type: "PROGRESS", text: `Chat ${index + 1} failed`, progress: `${index + 1}/${total}`, log: `✗ Chat ${index + 1}: ${error.message}`, logType: "err" });
    } finally {
      // Do not leave a customer chat open when a later message or image fails.
      if (resumed && chatId) {
        try { await action("deactivate_chat", { id: chatId, ignore_requester_presence: true }); } catch (_) {}
      }
    }
  }

  async function runJobs(jobs, delay, concurrency) {
    stopRequested = false;
    let cursor = 0;
    const worker = async () => { while (!stopRequested) { const index = cursor++; if (index >= jobs.length) return; await runJob(jobs[index], index, jobs.length, delay); } };
    await Promise.all(Array.from({ length: Math.min(3, Math.max(1, concurrency || 1), jobs.length) }, worker));
    emit({ type: "DONE" });
  }

  function connectAgent(client) {
    const state = crypto.randomUUID();
    sessionStorage.setItem(STATE_KEY, state);
    sessionStorage.setItem(PENDING_ACCOUNT_KEY, client.key);
    sessionStorage.setItem(SELECTED_ACCOUNT_KEY, client.key);
    // Use the exact URI registered in Developer Console. Cloudflare preview
    // aliases can have a different origin, which LiveChat rejects even when
    // the rest of the OAuth request is correct.
    const redirectUri = oauthConfig.redirectUri || `${location.origin}/blast/oauth.html`;
    const url = new URL("https://accounts.livechat.com/");
    url.search = new URLSearchParams({ response_type: "token", client_id: client.clientId, redirect_uri: redirectUri, state, prompt: "consent" }).toString();
    window.open(url, "livechat-agent-oauth", "popup=yes,width=560,height=720");
  }

  function renderConnection(config) {
    const banner = document.getElementById("bridgeBanner");
    if (!banner) return;
    const clients = Array.isArray(config.clients) && config.clients.length
      ? config.clients
      : (config.clientId ? [{ key: "lc1", label: "LiveChat Account 1", clientId: config.clientId }] : []);
    let accountKey = selectedAccount();
    if (!clients.some((client) => client.key === accountKey)) accountKey = clients[0]?.key || "lc1";
    sessionStorage.setItem(SELECTED_ACCOUNT_KEY, accountKey);
    const client = clients.find((item) => item.key === accountKey);
    const connected = Boolean(token(accountKey));
    const accountPicker = clients.length > 1
      ? `<select id="agentAccountSelect" style="border:1px solid currentColor;border-radius:7px;background:#161a20;color:inherit;padding:7px 9px;font:600 11px inherit">${clients.map((item) => `<option value="${item.key}"${item.key === accountKey ? " selected" : ""}>${item.label}</option>`).join("")}</select>`
      : "";
    banner.innerHTML = `<div style="display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap"><span style="flex:1;min-width:260px"><strong>${connected ? "Agent connected" : "Admin preview"}</strong> · ${connected ? `${client?.label || "LiveChat"} is connected. Blasts will be authored by this CS agent for KPI attribution.` : config.configured ? `Connect the CS agent for ${client?.label || "this LiveChat account"} before sending.` : "Queue editing is ready. Add the LiveChat Client ID variables in Cloudflare before live sending."}</span>${accountPicker}<button id="agentConnectBtn" style="border:1px solid currentColor;border-radius:7px;background:transparent;color:inherit;padding:7px 10px;font:600 11px inherit;cursor:pointer">${connected ? "Reconnect" : "Connect LiveChat"}</button></div>`;
    document.getElementById("agentAccountSelect")?.addEventListener("change", (event) => {
      sessionStorage.setItem(SELECTED_ACCOUNT_KEY, event.target.value);
      renderConnection(config);
    });
    const button = document.getElementById("agentConnectBtn");
    button.disabled = !client;
    button.style.opacity = client ? "1" : ".45";
    button.addEventListener("click", () => client && connectAgent(client));
  }

  let oauthConfig = { configured: false, clients: [], clientId: "", redirectUri: "" };
  window.addEventListener("message", (event) => {
    const callbackOrigin = oauthConfig.redirectUri ? new URL(oauthConfig.redirectUri).origin : location.origin;
    if (event.origin !== callbackOrigin || event.data?.source !== "ca-livechat-oauth") return;
    if (event.data.state !== sessionStorage.getItem(STATE_KEY)) return;
    if (event.data.type === "SUCCESS") {
      const accountKey = sessionStorage.getItem(PENDING_ACCOUNT_KEY) || selectedAccount();
      sessionStorage.setItem(accountStorageKey(TOKEN_KEY, accountKey), event.data.token);
      sessionStorage.setItem(accountStorageKey(TOKEN_EXPIRY_KEY, accountKey), String(event.data.expiresAt));
      sessionStorage.setItem(SELECTED_ACCOUNT_KEY, accountKey);
      renderConnection(oauthConfig);
    } else emit({ type: "ERROR", text: event.data.error || "LiveChat authorization failed." });
  });
  fetch("/livechat-oauth-config", { cache: "no-store" }).then((response) => response.json()).then((config) => { oauthConfig = config; renderConnection(config); }).catch(() => renderConnection(oauthConfig));

  globalThis.chrome = {
    storage: { local: area("local"), sync: area("sync"), onChanged: { addListener(fn) { storageListeners.push(fn); } } },
    runtime: {
      onMessage: { addListener(fn) { runtimeListeners.push(fn); } },
      openOptionsPage() { location.href = "settings.html"; },
      sendMessage(message) {
        if (message?.type === "STOP") stopRequested = true;
        if (message?.type === "LOG_FAILURES") (message.failures || []).forEach((failure) => recordFailure(failure.job, failure.index, failure.stage || "queue validation", failure.reason || "Invalid queue item"));
        if (message?.type === "START") {
          if (!token()) {
            setTimeout(() => emit({ type: "PROGRESS", text: "Connect the CS agent before sending.", progress: "Not sent", log: "No customer message was sent.", logType: "err" }), 0);
            setTimeout(() => emit({ type: "DONE" }), 50);
          } else runJobs(message.jobs || [], Number(message.delay) || 0, Number(message.concurrency) || 1);
        }
        return Promise.resolve();
      },
    },
  };
})();
