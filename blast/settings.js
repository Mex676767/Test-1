const msgList = document.getElementById('msgList');
const addMsg = document.getElementById('addMsg');
const saveBtn = document.getElementById('saveBtn');
const savedToast = document.getElementById('savedToast');
const failureListEl = document.getElementById('failureList');
const failureCountEl = document.getElementById('failureCount');
const copyFailuresBtn = document.getElementById('copyFailures');
const clearFailuresBtn = document.getElementById('clearFailures');

let messages = [];
let failureLog = [];

chrome.storage.sync.get(['cannedMessages'], (data) => {
  messages = data.cannedMessages || ['', '', ''];
  render();
});

function loadFailureLog() {
  chrome.storage.local.get(['failureLog'], (data) => {
    failureLog = Array.isArray(data.failureLog) ? data.failureLog : [];
    renderFailureLog();
  });
}

function renderFailureLog() {
  failureListEl.innerHTML = '';
  failureCountEl.textContent = String(failureLog.length);
  if (!failureLog.length) {
    const empty = document.createElement('div');
    empty.className = 'failure-empty';
    empty.textContent = 'No skipped or failed chats recorded.';
    failureListEl.appendChild(empty);
    return;
  }

  failureLog.forEach(entry => {
    const item = document.createElement('div');
    item.className = 'failure-item';

    const meta = document.createElement('div');
    meta.className = 'failure-meta';
    const date = new Date(entry.timestamp);
    meta.textContent = `#${entry.jobNumber || '?'} · ${Number.isNaN(date.getTime()) ? entry.timestamp : date.toLocaleString()}`;
    const thread = document.createElement('span');
    thread.textContent = entry.threadId || 'unknown thread';
    meta.appendChild(thread);

    const stage = document.createElement('div');
    stage.className = 'failure-stage';
    stage.textContent = entry.stage || 'unknown stage';

    const reason = document.createElement('div');
    reason.className = 'failure-reason';
    reason.textContent = entry.reason || 'Unknown error';

    const link = document.createElement('a');
    link.className = 'failure-link';
    link.textContent = entry.url || 'No link recorded';
    try {
      const parsed = new URL(entry.url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        link.href = parsed.href;
        link.target = '_blank';
        link.rel = 'noreferrer';
      }
    } catch (_) {}

    item.append(meta, stage, reason, link);
    failureListEl.appendChild(item);
  });
}

copyFailuresBtn.addEventListener('click', async () => {
  if (!failureLog.length) return;
  const text = failureLog.map(entry => [
    entry.timestamp,
    `Chat ${entry.jobNumber || '?'}`,
    entry.threadId || 'unknown',
    entry.stage || 'unknown stage',
    entry.reason || 'Unknown error',
    entry.url || '',
  ].join('\t')).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    copyFailuresBtn.textContent = 'Copied ✓';
  } catch (_) {
    copyFailuresBtn.textContent = 'Copy failed';
  }
  setTimeout(() => { copyFailuresBtn.textContent = 'Copy'; }, 1500);
});

clearFailuresBtn.addEventListener('click', () => {
  if (!failureLog.length || !confirm('Clear the entire skipped-chat log?')) return;
  chrome.storage.local.remove('failureLog', loadFailureLog);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.failureLog) loadFailureLog();
});

loadFailureLog();

function render() {
  msgList.innerHTML = '';
  messages.forEach((msg, i) => {
    const row = document.createElement('div');
    row.className = 'msg-item';
    row.innerHTML = `
      <div class="msg-num">${i + 1}</div>
      <textarea class="msg-textarea" placeholder="Type message ${i + 1}…" data-index="${i}">${msg}</textarea>
      <button class="remove-btn" data-index="${i}" title="Remove">×</button>
    `;
    msgList.appendChild(row);
  });

  // Bind events
  msgList.querySelectorAll('.msg-textarea').forEach(ta => {
    ta.addEventListener('input', (e) => {
      messages[parseInt(e.target.dataset.index)] = e.target.value;
    });
  });

  msgList.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.index);
      messages.splice(idx, 1);
      render();
    });
  });

  addMsg.style.display = messages.length >= 6 ? 'none' : 'block';
}

addMsg.addEventListener('click', () => {
  if (messages.length < 6) {
    messages.push('');
    render();
    // Focus last textarea
    setTimeout(() => {
      const areas = msgList.querySelectorAll('.msg-textarea');
      areas[areas.length - 1].focus();
    }, 50);
  }
});

saveBtn.addEventListener('click', () => {
  const filtered = messages.filter(m => m.trim() !== '');
  chrome.storage.sync.set({ cannedMessages: filtered }, () => {
    savedToast.classList.add('show');
    setTimeout(() => savedToast.classList.remove('show'), 2500);
  });
});
