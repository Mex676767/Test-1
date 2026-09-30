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
  const DETECTED_ACCOUNT_KEY = "rc-livechat-account";
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
  const validAccountKey = (value) => /^lc[12]$/.test(String(value || "")) ? String(value) : "";
  const detectedAccount = () => {
    const own = validAccountKey(sessionStorage.getItem(DETECTED_ACCOUNT_KEY));
    if (own) return own;
    try { return validAccountKey(window.parent?.sessionStorage?.getItem(DETECTED_ACCOUNT_KEY)); } catch (_) { return ""; }
  };
  const selectedAccount = () => detectedAccount() || validAccountKey(sessionStorage.getItem(SELECTED_ACCOUNT_KEY));
  const accountStorageKey = (base, accountKey) => `${base}:${accountKey || selectedAccount()}`;
  const token = (accountKey = selectedAccount()) => accountKey && Number(sessionStorage.getItem(accountStorageKey(TOKEN_EXPIRY_KEY, accountKey)) || 0) > Date.now()
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

  async function detectAccountFromUrl(url) {
    const ids = extractIds(url);
    if (!ids.threadId) return "";
    const response = await fetch("/livechat-chat-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: ids.threadId, ...(ids.chatId ? { realChatId: ids.chatId } : {}) }),
    });
    const data = await response.json();
    return response.ok && data.ok ? validAccountKey(data.accountKey) : "";
  }

  async function resolveChat(url) {
    const ids = extractIds(url);
    if (ids.chatId) return { ...ids, isActive: null };
    if (!ids.threadId) throw new Error("The LiveChat archive link is invalid.");
    const response = await fetch("/livechat-chat-status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: ids.threadId }) });
    const data = await response.json();
    if (!response.ok || !data.ok || !data.chatId) throw new Error(data.error || "This archive is outside the recent lookup window.");
    if (data.accountKey && data.accountKey !== selectedAccount()) {
      throw new Error("This chat belongs to the other LiveChat workspace. Open the app there and reconnect before sending.");
    }
    return { chatId: data.chatId, threadId: ids.threadId, isActive: data.isActive };
  }

  async function action(name, body, formData) {
    const accessToken = token();
    if (!accessToken) throw new Error("Your agent authorization expired. Connect LiveChat again.");
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await fetch(`https://api.livechatinc.com/v3.6/agent/action/${name}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, ...(formData ? {} : { "Content-Type": "application/json" }) },
        body: formData || JSON.stringify(body || {}),
      });
      const text = await response.text();
      let data = {}; try { data = text ? JSON.parse(text) : {}; } catch (_) {}
      const errorType = String(data.error?.type || data.error?.code || "").toLowerCase();
      const isRateLimited = response.status === 429 || errorType === "too_many_requests";
      if (isRateLimited && attempt < maxAttempts) {
        const retryAfter = Number(response.headers?.get?.("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 600 * (2 ** (attempt - 1)));
        continue;
      }
      if (!response.ok || data.error) throw new Error(data.error?.message || data.error || `${name} failed (${response.status})`);
      return data;
    }
    throw new Error(`${name} was rate limited. Try a lower speed.`);
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
    await Promise.all(Array.from({ length: Math.min(10, Math.max(1, concurrency || 1), jobs.length) }, worker));
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

  async function accountForConnection(clients) {
    const workspaceAccount = detectedAccount();
    if (clients.some((client) => client.key === workspaceAccount)) return workspaceAccount;

    const firstUrl = (readArea("local").chatEntries || []).find((entry) => String(entry?.url || "").trim())?.url;
    if (firstUrl) {
      const detected = await detectAccountFromUrl(firstUrl);
      if (detected) {
        sessionStorage.setItem(SELECTED_ACCOUNT_KEY, detected);
        return detected;
      }
    }

    const connected = clients.filter((client) => Boolean(token(client.key)));
    if (connected.length === 1) return connected[0].key;

    const previous = validAccountKey(sessionStorage.getItem(SELECTED_ACCOUNT_KEY));
    return clients.some((client) => client.key === previous) ? previous : "";
  }

  function renderConnection(config) {
    const banner = document.getElementById("bridgeBanner");
    if (!banner) return;
    const clients = Array.isArray(config.clients) && config.clients.length
      ? config.clients
      : (config.clientId ? [{ key: "lc1", label: "LiveChat Account 1", clientId: config.clientId }] : []);
    const accountKey = selectedAccount();
    const client = clients.find((item) => item.key === accountKey);
    const connected = Boolean(token(accountKey));
    const connectionNote = connected
      ? ""
      : config.configured
        ? "Detected automatically from this workspace or the first chat link."
        : "LiveChat OAuth has not been configured yet.";
    banner.innerHTML = `<div class="connection-card${connected ? " is-connected" : ""}"><div class="connection-state"><span class="connection-dot"></span><div class="connection-copy"><div class="connection-title">LiveChat Account</div>${connectionNote ? `<div class="connection-note">${connectionNote}</div>` : ""}</div></div><div class="connection-controls"><button id="agentConnectBtn" class="connection-button">${connected ? "Reconnect" : "Connect"}</button></div></div>`;
    const button = document.getElementById("agentConnectBtn");
    button.disabled = !clients.length;
    button.style.opacity = clients.length ? "1" : ".45";
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Detecting…";
      try {
        const detectedKey = await accountForConnection(clients);
        const detectedClient = clients.find((item) => item.key === detectedKey);
        if (!detectedClient) {
          const note = banner.querySelector(".connection-note");
          if (note) note.textContent = "Open a customer chat or paste one archive link so the LiveChat Account can be detected.";
          button.textContent = "Connect";
          button.disabled = false;
          return;
        }
        sessionStorage.setItem(SELECTED_ACCOUNT_KEY, detectedKey);
        connectAgent(detectedClient);
      } catch (_) {
        const note = banner.querySelector(".connection-note");
        if (note) note.textContent = "Could not detect this LiveChat Account. Open a customer chat and try again.";
        button.textContent = "Connect";
        button.disabled = false;
      }
    });
  }

  let oauthConfig = { configured: false, clients: [], clientId: "", redirectUri: "" };
  window.addEventListener("storage", (event) => {
    if (event.storageArea === sessionStorage && event.key === DETECTED_ACCOUNT_KEY) renderConnection(oauthConfig);
  });
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
