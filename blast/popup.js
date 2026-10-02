// State: array of { url, messages: [] | null (null = use default) }
let chatEntries = [];
let defaultMessages = [];
let running = false;
let paused = false;

const chatList    = document.getElementById('chatList');
const addChatBtn  = document.getElementById('addChatBtn');
const defMsgCount = document.getElementById('defMsgCount');
const defMsgList  = document.getElementById('defMsgList');
const delaySlider = document.getElementById('delaySlider');
const delayVal    = document.getElementById('delayVal');
const concurrencySelect = document.getElementById('concurrencySelect');
const concurrencyPicker = document.getElementById('concurrencyPicker');
const concurrencyTrigger = document.getElementById('concurrencyTrigger');
const concurrencyLabel = document.getElementById('concurrencyLabel');
const concurrencyMenu = document.getElementById('concurrencyMenu');
const startBtn    = document.getElementById('startBtn');
const pauseBtn    = document.getElementById('pauseBtn');
const stopBtn     = document.getElementById('stopBtn');
const runControls = document.getElementById('runControls');
const status      = document.getElementById('status');
const statusText  = document.getElementById('statusText');
const prog        = document.getElementById('prog');
const log         = document.getElementById('log');
const openSettings= document.getElementById('openSettings');

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ── Load ──────────────────────────────────────────────────────────────────────
chrome.storage.sync.get(['cannedMessages', 'delay', 'concurrency', 'concurrencyVersion', 'chatEntries', 'isRunning'], (d) => {
  defaultMessages = d.cannedMessages || [];
  const delay = d.delay || 3;
  delaySlider.value = delay;
  delayVal.textContent = delay + 's';
  const savedConcurrency = Number(d.concurrency);
  const concurrency = d.concurrencyVersion === 2 && [1, 3, 5, 8, 10].includes(savedConcurrency)
    ? savedConcurrency
    : 5;
  concurrencySelect.value = String(concurrency);
  updateConcurrencyPicker();
  if (d.concurrencyVersion !== 2) chrome.storage.sync.set({ concurrency: 5, concurrencyVersion: 2 });

  // Large queues exceed chrome.storage.sync's per-item quota, so keep them local.
  // Fall back to the old sync value once to migrate existing installations.
  chrome.storage.local.get(['chatEntries'], (localData) => {
    const storedEntries = localData.chatEntries ?? d.chatEntries ?? [{ url: '', messages: null }];
    chatEntries = storedEntries.map(entry => ({
      url: entry.url || '',
      messages: entry.messages ?? null,
      expanded: Boolean(entry.expanded),
      imageUrl: entry.imageUrl || '',
      imageDataUrl: entry.imageDataUrl || null,
      imageFileName: entry.imageFileName || null,
    }));
    chrome.storage.local.set({ chatEntries });
    if (d.chatEntries !== undefined) chrome.storage.sync.remove('chatEntries');
    renderAll();
    renderDefaultPreview();
  });

  // Restore running state if popup was closed mid-automation
  if (d.isRunning) {
    running = true;
    paused = Boolean(d.isPaused);
    status.classList.add('on');
    statusText.textContent = paused ? 'Paused — press Resume to continue' : 'Running…';
  }
  updateRunControls();
});

if (openSettings && window.parent === window) {
  openSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || event.data?.type !== 'blast-settings-updated') return;
  defaultMessages = Array.isArray(event.data.cannedMessages) ? event.data.cannedMessages : [];
  renderDefaultPreview();
});

// ── Render all chat rows ──────────────────────────────────────────────────────
function renderAll() {
  chatList.innerHTML = '';
  chatEntries.forEach((entry, i) => renderRow(entry, i));
}

function renderRow(entry, i) {
  const row = document.createElement('div');
  row.className = 'chat-row';
  row.dataset.index = i;

  const useDefault = entry.messages === null;
  const msgs = entry.messages || ['', '', ''];
  const isOpen = entry.expanded || false;

  row.innerHTML = `
    <div class="row-top">
      <div class="row-num">${i + 1}</div>
      <input class="row-url" type="text" placeholder="https://my.livechatinc.com/archives/…" value="${entry.url || ''}">
      <div class="row-actions">
        <button class="expand-btn" title="${isOpen ? 'Collapse' : 'Edit messages'}">${isOpen ? '▲' : '✉'}</button>
        <button class="del-btn" title="Remove">×</button>
      </div>
    </div>
    <div class="msg-panel ${isOpen ? 'open' : ''}">
      <div class="panel-label">Messages for this chat</div>
      <label class="use-default">
        <input type="checkbox" class="use-default-chk" ${useDefault ? 'checked' : ''}>
        <span>Use default messages</span>
      </label>
      <div class="custom-msgs" style="${useDefault ? 'opacity:.4;pointer-events:none' : ''}">
        ${msgs.map((m, j) => `
          <div class="msg-row" data-msg="${j}">
            <div class="msg-num">${j + 1}</div>
            <textarea class="msg-input" rows="1" placeholder="Message ${j + 1}…">${m}</textarea>
            <button class="msg-del" title="Remove message">×</button>
          </div>
        `).join('')}
        <button class="add-msg-btn">+ Add message</button>
      </div>
    </div>
  `;

  chatList.appendChild(row);
  bindRowEvents(row, i);
}

function bindRowEvents(row, i) {
  row.querySelector('.row-url').addEventListener('input', e => {
    chatEntries[i].url = e.target.value.trim();
    save();
  });

  row.querySelector('.expand-btn').addEventListener('click', () => {
    chatEntries[i].expanded = !chatEntries[i].expanded;
    save();
    renderAll();
  });

  row.querySelector('.del-btn').addEventListener('click', () => {
    chatEntries.splice(i, 1);
    save();
    renderAll();
  });

  const panel = row.querySelector('.msg-panel');
  const customMsgs = row.querySelector('.custom-msgs');
  const useDefaultChk = row.querySelector('.use-default-chk');

  useDefaultChk.addEventListener('change', () => {
    const checked = useDefaultChk.checked;
    chatEntries[i].messages = checked ? null : getMessagesFromPanel(panel);
    customMsgs.style.cssText = checked ? 'opacity:.4;pointer-events:none' : '';
    save();
  });

  panel.querySelectorAll('.msg-input').forEach((ta, j) => {
    ta.addEventListener('input', () => {
      if (!useDefaultChk.checked) {
        const msgs = getMessagesFromPanel(panel);
        chatEntries[i].messages = msgs;
        save();
      }
      autoResize(ta);
    });
    autoResize(ta);
  });

  panel.querySelectorAll('.msg-del').forEach((btn, j) => {
    btn.addEventListener('click', () => {
      if (chatEntries[i].messages && chatEntries[i].messages.length > 1) {
        chatEntries[i].messages.splice(j, 1);
        save();
        renderAll();
      }
    });
  });

  panel.querySelector('.add-msg-btn').addEventListener('click', () => {
    if (!chatEntries[i].messages) chatEntries[i].messages = getMessagesFromPanel(panel);
    if (chatEntries[i].messages.length < 6) {
      chatEntries[i].messages.push('');
      chatEntries[i].expanded = true;
      save();
      renderAll();
    }
  });

}

function getMessagesFromPanel(panel) {
  return Array.from(panel.querySelectorAll('.msg-input')).map(t => t.value);
}

function autoResize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.max(36, ta.scrollHeight) + 'px';
}

// ── Add new chat row ──────────────────────────────────────────────────────────
document.getElementById('clearManualBtn').addEventListener('click', () => {
  if (chatEntries.length === 0) return;
  chatEntries = [{ url: '', messages: null, expanded: false }];
  save();
  renderAll();
});

addChatBtn.addEventListener('click', () => {
  chatEntries.push({ url: '', messages: null, expanded: true });
  save();
  renderAll();
  setTimeout(() => {
    const inputs = chatList.querySelectorAll('.row-url');
    inputs[inputs.length - 1]?.focus();
  }, 50);
});

// ── Default messages preview ──────────────────────────────────────────────────
function renderDefaultPreview() {
  defMsgCount.textContent = defaultMessages.length;
  if (!defaultMessages.length) {
    defMsgList.innerHTML = '<div class="empty-note">No default messages. Open Settings to create one.</div>';
    return;
  }
  defMsgList.innerHTML = defaultMessages.map((m, i) =>
    `<div class="default-item">${i + 1}. ${m}</div>`
  ).join('');
}

// ── Delay ─────────────────────────────────────────────────────────────────────
delaySlider.addEventListener('input', () => {
  const v = parseFloat(delaySlider.value);
  delayVal.textContent = v + 's';
  chrome.storage.sync.set({ delay: v });
});

function updateConcurrencyPicker() {
  const selected = concurrencySelect.options[concurrencySelect.selectedIndex];
  concurrencyLabel.textContent = selected?.textContent || '5 — Balanced';
  concurrencyMenu.querySelectorAll('.speed-option').forEach((option) => {
    const active = option.dataset.value === concurrencySelect.value;
    option.classList.toggle('selected', active);
    option.setAttribute('aria-selected', String(active));
  });
}

function closeConcurrencyPicker() {
  concurrencyPicker.classList.remove('open');
  concurrencyTrigger.setAttribute('aria-expanded', 'false');
}

concurrencyTrigger.addEventListener('click', () => {
  const opening = !concurrencyPicker.classList.contains('open');
  concurrencyPicker.classList.toggle('open', opening);
  concurrencyTrigger.setAttribute('aria-expanded', String(opening));
});

concurrencyMenu.querySelectorAll('.speed-option').forEach((option) => {
  option.addEventListener('click', () => {
    concurrencySelect.value = option.dataset.value;
    concurrencySelect.dispatchEvent(new Event('change', { bubbles: true }));
    closeConcurrencyPicker();
  });
});

document.addEventListener('click', (event) => {
  if (!concurrencyPicker.contains(event.target)) closeConcurrencyPicker();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeConcurrencyPicker();
});

concurrencySelect.addEventListener('change', () => {
  updateConcurrencyPicker();
  chrome.storage.sync.set({ concurrency: Number(concurrencySelect.value), concurrencyVersion: 2 });
});

// ── Save ──────────────────────────────────────────────────────────────────────
function save() {
  chrome.storage.local.set({ chatEntries });
}

// ── Log ───────────────────────────────────────────────────────────────────────
function addLog(msg, type = '') {
  log.classList.add('on');
  const el = document.createElement('div');
  el.className = 'log-line ' + type;
  el.textContent = msg;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function updateRunControls() {
  pauseBtn.disabled = false;
  stopBtn.disabled = false;
  runControls.classList.toggle('is-running', running);
  startBtn.hidden = running;
  pauseBtn.hidden = !running;
  stopBtn.hidden = !running;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  pauseBtn.className = paused ? 'btn btn-resume' : 'btn btn-pause';
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'blast-run-state', running }, window.location.origin);
  }
}

// ── Background messages ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PROGRESS') {
    statusText.innerHTML = msg.text;
    prog.textContent = msg.progress || '';
    if (msg.log) addLog(msg.log, msg.logType || '');
  }
  if (msg.type === 'DONE') {
    running = false;
    paused = false;
    chrome.storage.sync.set({ isRunning: false, isPaused: false });
    statusText.innerHTML = msg.stopped ? 'Stopped' : '✓ All chats completed';
    prog.textContent = '';
    updateRunControls();
    addLog(msg.stopped ? '■ Automation stopped' : '✓ Automation finished', msg.stopped ? 'info' : 'ok');
  }
  if (msg.type === 'PAUSED') {
    paused = true;
    chrome.storage.sync.set({ isPaused: true });
    statusText.textContent = 'Pausing — active chats will finish safely';
    updateRunControls();
    addLog('Ⅱ Paused before starting any more chats', 'info');
  }
  if (msg.type === 'RESUMED') {
    paused = false;
    chrome.storage.sync.set({ isPaused: false });
    statusText.textContent = 'Running…';
    updateRunControls();
    addLog('▶ Automation resumed', 'ok');
  }
  if (msg.type === 'ERROR') {
    addLog('✗ ' + msg.text, 'err');
  }
});

// ── Start / Pause / Resume / Stop ─────────────────────────────────────────────
startBtn.addEventListener('click', () => {
  const jobs = [];
  const preflightFailures = [];
  const duplicateNotices = [];
  const seenChatIds = new Map();
  chatEntries.forEach((e, queueIndex) => {
    if (!e.url) return;
    const job = {
      queueIndex,
      url: e.url,
      messages: e.messages !== null
        ? e.messages.filter(m => m.trim())
        : defaultMessages.filter(m => m.trim()),
      imageUrl: (e.imageUrl || '').trim(),
      imageDataUrl: e.imageDataUrl || null,
      imageFileName: e.imageFileName || 'image.png',
    };
    if (!e.url.includes('livechat') && !e.url.includes('livechatinc')) {
      preflightFailures.push({ index: queueIndex, job, stage: 'queue validation', reason: 'URL is not a recognized LiveChat link' });
    } else if (!job.messages.length) {
      preflightFailures.push({ index: queueIndex, job, stage: 'queue validation', reason: 'No messages were configured for this chat' });
    } else {
      let directChatId = '';
      try {
        const parts = new URL(e.url).pathname.split('/').filter(Boolean);
        const chatIndex = parts.indexOf('chats');
        if (chatIndex >= 0) directChatId = parts[chatIndex + 1] || '';
      } catch (_) {}
      if (directChatId && seenChatIds.has(directChatId)) {
        duplicateNotices.push(`Skipped row ${queueIndex + 1}: same customer chat as row ${seenChatIds.get(directChatId) + 1}`);
        return;
      }
      if (directChatId) seenChatIds.set(directChatId, queueIndex);
      jobs.push(job);
    }
  });

  if (preflightFailures.length) {
    chrome.runtime.sendMessage({ type: 'LOG_FAILURES', failures: preflightFailures });
  }


  if (!jobs.length) { addLog('⚠ No valid chats with messages found', 'err'); return; }

  running = true;
  paused = false;
  chrome.storage.sync.set({ isRunning: true, isPaused: false });
  log.innerHTML = '';
  duplicateNotices.forEach((notice) => addLog(`↷ ${notice}`, 'info'));
  status.classList.add('on');
  statusText.textContent = 'Starting…';
  updateRunControls();

  chrome.runtime.sendMessage({
    type: 'START',
    jobs,
    delay: parseFloat(delaySlider.value) * 1000,
    concurrency: Number(concurrencySelect.value)
  });
});

pauseBtn.addEventListener('click', () => {
  if (!running) return;
  chrome.runtime.sendMessage({ type: paused ? 'RESUME' : 'PAUSE' });
});

stopBtn.addEventListener('click', () => {
  if (!running) return;
  chrome.runtime.sendMessage({ type: 'STOP' });
  statusText.textContent = 'Stopping…';
  pauseBtn.disabled = true;
  stopBtn.disabled = true;
});

// ── Bulk Import ───────────────────────────────────────────────────────────────
const MAX_ROWS = 1000;

const bulkLinks = document.getElementById('bulkLinks');
const bulkMsg1  = document.getElementById('bulkMsg1');
const bulkMsg2  = document.getElementById('bulkMsg2');
const bulkMsg3  = document.getElementById('bulkMsg3');
const bulkStatus  = document.getElementById('bulkStatus');
const bulkLoadBtn = document.getElementById('bulkLoadBtn');
const bulkClearBtn = document.getElementById('bulkClearBtn');

function getLines(ta) {
  return ta.value.split('\n').map(l => l.trim());
}

function countNonEmpty(ta) {
  return getLines(ta).filter(l => l.length > 0).length;
}

function updateCounter(ta, counterId) {
  const el = document.getElementById(counterId);
  const n = countNonEmpty(ta);
  el.textContent = `${n} / ${MAX_ROWS}`;
  el.className = 'bulk-counter' + (n > MAX_ROWS ? ' over' : '');
}

[bulkLinks, bulkMsg1, bulkMsg2, bulkMsg3].forEach((ta, i) => {
  const ids = ['cntLinks','cntMsg1','cntMsg2','cntMsg3'];
  ta.addEventListener('input', () => {
    // Auto-parse: if user pastes tab-separated data into links column
    if (ta === bulkLinks && ta.value.includes('\t')) {
      parseTabbedPaste(ta.value);
      return;
    }
    updateCounter(ta, ids[i]);
  });
  ta.addEventListener('paste', (e) => {
    // Give the paste time to land before checking
    setTimeout(() => {
      if (ta === bulkLinks && ta.value.includes('\t')) {
        parseTabbedPaste(ta.value);
      } else {
        updateCounter(ta, ids[i]);
      }
    }, 10);
  });
});

// Parse tab-separated paste (copied from Excel/Sheets with all 4 columns)
function parseTabbedPaste(raw) {
  const rows = raw.split('\n').map(r => r.split('\t').map(c => c.trim())).filter(r => r.some(c => c));

  // Check if first row is a header (LINKS / MESSAGE 1 etc.) — skip it
  const firstRow = rows[0].map(c => c.toLowerCase());
  const startIdx = (firstRow[0] === 'links' || firstRow[0] === 'link') ? 1 : 0;
  const dataRows = rows.slice(startIdx);

  const links = [], m1 = [], m2 = [], m3 = [];
  dataRows.forEach(cols => {
    links.push(cols[0] || '');
    m1.push(cols[1] || '');
    m2.push(cols[2] || '');
    m3.push(cols[3] || '');
  });

  bulkLinks.value = links.join('\n');
  bulkMsg1.value  = m1.join('\n');
  bulkMsg2.value  = m2.join('\n');
  bulkMsg3.value  = m3.join('\n');

  ['cntLinks','cntMsg1','cntMsg2','cntMsg3'].forEach((id, i) => {
    updateCounter([bulkLinks,bulkMsg1,bulkMsg2,bulkMsg3][i], id);
  });

  showBulkStatus(`Auto-parsed ${dataRows.length} rows from tabbed paste.`, 'ok');
}

function showBulkStatus(msg, type) {
  bulkStatus.textContent = msg;
  bulkStatus.className = 'bulk-status ' + type;
}

bulkClearBtn.addEventListener('click', () => {
  bulkLinks.value = bulkMsg1.value = bulkMsg2.value = bulkMsg3.value = '';
  ['cntLinks','cntMsg1','cntMsg2','cntMsg3'].forEach(id => {
    document.getElementById(id).textContent = `0 / ${MAX_ROWS}`;
    document.getElementById(id).className = 'bulk-counter';
  });
  if (document.getElementById('cntImg')) document.getElementById('cntImg').textContent = '—';
  if (typeof imgFileClear !== 'undefined') imgFileClear.click();
  bulkStatus.className = 'bulk-status';
});

bulkLoadBtn.addEventListener('click', () => {
  const links = getLines(bulkLinks).filter(l => l.length > 0);
  const msgs1  = getLines(bulkMsg1);
  const msgs2  = getLines(bulkMsg2);
  const msgs3  = getLines(bulkMsg3);

  if (!links.length) {
    showBulkStatus('⚠ No links found. Add at least one URL in the Links column.', 'err');
    return;
  }

  // Validate links count
  if (links.length > MAX_ROWS) {
    showBulkStatus(`⚠ Too many links (${links.length}). Maximum is ${MAX_ROWS}.`, 'err');
    return;
  }

  // Validate each message column individually
  const m1nonEmpty = msgs1.filter(m => m.length > 0);
  const m2nonEmpty = msgs2.filter(m => m.length > 0);
  const m3nonEmpty = msgs3.filter(m => m.length > 0);

  if (m1nonEmpty.length > MAX_ROWS || m2nonEmpty.length > MAX_ROWS || m3nonEmpty.length > MAX_ROWS) {
    showBulkStatus(`⚠ One or more message columns exceed ${MAX_ROWS} rows.`, 'err');
    return;
  }

  // Check at least one message column has data
  if (!m1nonEmpty.length && !m2nonEmpty.length && !m3nonEmpty.length) {
    showBulkStatus('⚠ No messages found. Fill in at least Message 1.', 'err');
    return;
  }


  // Build entries — with image support
  const imgUrls = bulkImgMode === 'url' 
    ? (bulkImgUrl ? bulkImgUrl.value.split('\n').map(l => l.trim()) : [])
    : [];

  const newEntries = links.map((url, i) => {
    const rowMsgs = [
      msgs1[i] || '',
      msgs2[i] || '',
      msgs3[i] || '',
    ].filter(m => m.trim().length > 0);

    return {
      url,
      messages: rowMsgs.length > 0 ? rowMsgs : null,
      imageUrl: bulkImgMode === 'url' ? (imgUrls[i] || '') : '',
      imageDataUrl: bulkImgMode === 'file' ? bulkImgDataUrl : null,
      imageFileName: bulkImgMode === 'file' ? bulkImgFileName : null,
      expanded: false,
    };
  });


  // Replace chatEntries and save
  chatEntries = newEntries;
  save();
  renderAll();

  showBulkStatus(`✓ Loaded ${newEntries.length} chat${newEntries.length !== 1 ? 's' : ''} into the queue.`, 'ok');

  // Switch to manual tab so user can review + run
  setTimeout(() => {
    document.querySelector('[data-tab="manual"]').click();
  }, 800);
});

// ── Image Column (Bulk) ───────────────────────────────────────────────────────
let bulkImgMode = 'url'; // 'url' or 'file'
let bulkImgDataUrl = null;
let bulkImgFileName = null;

const imgSubUrl   = document.getElementById('imgSubUrl');
const imgSubFile  = document.getElementById('imgSubFile');
const imgPaneUrl  = document.getElementById('imgPaneUrl');
const imgPaneFile = document.getElementById('imgPaneFile');
const imgPickBtn  = document.getElementById('imgPickBtn');
const imgFileInput= document.getElementById('imgFileInput');
const imgFileName = document.getElementById('imgFileName');
const imgFileClear= document.getElementById('imgFileClear');
const imgFileWrap = document.getElementById('imgFileWrap');
const imgFileType = document.getElementById('imgFileType');

imgSubUrl.addEventListener('click', () => {
  bulkImgMode = 'url';
  imgSubUrl.classList.add('active'); imgSubFile.classList.remove('active');
  imgPaneUrl.classList.add('on'); imgPaneFile.classList.remove('on');
});

imgSubFile.addEventListener('click', () => {
  bulkImgMode = 'file';
  imgSubFile.classList.add('active'); imgSubUrl.classList.remove('active');
  imgPaneFile.classList.add('on'); imgPaneUrl.classList.remove('on');
});

// THE WORKING FILE BUTTON: direct .click() call — only method that works in extension popups
imgPickBtn.addEventListener('click', function(e) {
  e.preventDefault();
  e.stopPropagation();
  imgFileInput.click();
});

imgFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    bulkImgDataUrl = ev.target.result;
    bulkImgFileName = file.name;
    imgFileName.textContent = file.name;
    imgFileName.style.display = 'block';
    imgFileClear.style.display = 'inline';
    imgFileType.style.display = 'none';
    imgPickBtn.textContent = '📎 Change image';
    imgFileWrap.classList.add('has-file');
    document.getElementById('cntImg').textContent = '1 file';
  };
  reader.readAsDataURL(file);
});

imgFileClear.addEventListener('click', () => {
  bulkImgDataUrl = null; bulkImgFileName = null;
  imgFileInput.value = '';
  imgFileName.style.display = 'none'; imgFileName.textContent = '';
  imgFileClear.style.display = 'none';
  imgFileType.style.display = 'block';
  imgPickBtn.textContent = '📎 Choose image';
  imgFileWrap.classList.remove('has-file');
  document.getElementById('cntImg').textContent = '—';
});

// Track URL counter
const bulkImgUrl = document.getElementById('bulkImgUrl');
if (bulkImgUrl) {
  bulkImgUrl.addEventListener('input', () => {
    const n = bulkImgUrl.value.split('\n').filter(l => l.trim()).length;
    document.getElementById('cntImg').textContent = n > 0 ? `${n} / ${MAX_ROWS}` : '—';
  });
}
