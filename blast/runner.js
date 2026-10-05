(() => {
  const status = document.getElementById('status');
  const progress = document.getElementById('progress');
  const log = document.getElementById('log');
  const pause = document.getElementById('pause');
  const stop = document.getElementById('stop');
  let paused = false;
  function show(message) {
    if (message.text) status.textContent = message.text;
    if (message.progress) progress.textContent = message.progress;
    if (message.type === 'PROGRESS') { pause.disabled = false; stop.disabled = false; }
    if (message.type === 'PAUSED' || message.type === 'RESUMED') {
      paused = message.type === 'PAUSED';
      pause.textContent = paused ? 'Resume' : 'Pause';
      status.textContent = paused ? 'Paused — active chats finish safely' : 'Running…';
    }
    if (message.type === 'DONE') {
      pause.disabled = true;
      stop.disabled = true;
      status.textContent = message.interrupted ? 'Run interrupted — no queue was restarted'
        : message.stopped ? 'Stopped' : `Finished · ${message.sent || 0} sent · ${message.failed || 0} failed`;
    }
    if (message.log || message.type === 'ERROR') {
      const line = document.createElement('li');
      line.className = message.logType || (message.type === 'ERROR' ? 'err' : '');
      line.textContent = message.log || message.text;
      log.appendChild(line);
    }
  }
  chrome.runtime.onMessage.addListener(show);
  pause.addEventListener('click', () => chrome.runtime.sendMessage({ type: paused ? 'RESUME' : 'PAUSE' }));
  stop.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP' });
    stop.disabled = true;
    pause.disabled = true;
    status.textContent = 'Stopping — finishing chat cleanup…';
  });
  window.opener?.postMessage({ type: 'BLAST_RUNNER_READY' }, location.origin);
})();
