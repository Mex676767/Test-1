(() => {
  // "New version available" nudge, and an automatic reload once the widget is idle.
  //
  // Two kinds of release id, both explicit 40-hex versions (never ETags or file sizes):
  //  * deploy.ps1 releases stamp the commit into the widget-release meta tag and /release.json;
  //  * plain git-push deploys (the normal path) cannot stamp anything, so /widget-version reports a hash of the
  //    deployed client files, and the first successful read after load is this page's own baseline.
  const meta = document.querySelector('meta[name="widget-release"]')?.content || '';
  const isVersion = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
  const stamped = isVersion(meta);
  const endpoint = stamped ? '/release.json' : '/widget-version';
  const POLL_MS = 60000;      // how often to ask which version is deployed
  const RETRY_MS = 5000;      // while a new version waits, how often to re-check whether it is safe to reload
  const IDLE_MS = 20000;      // no clicks/typing/scrolling for this long counts as idle
  let baseline = stamped ? meta : '';
  let pending = '';
  let checking = false;
  let refreshing = false;
  let lastActivity = Date.now();
  let banner = null;
  let reloadButton = null;
  let bannerText = null;

  const touch = () => { lastActivity = Date.now(); };
  for (const name of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) {
    document.addEventListener(name, touch, { passive: true, capture: true });
  }

  const safeToReload = () => {
    try { return !!window.canRefreshForDeployment?.(); } catch (_) { return false; }
  };

  async function fetchVersion() {
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) return '';
      const { version } = await response.json();
      return isVersion(version) ? version : '';
    } catch (_) { return ''; } // A failed or odd answer is "no information", never evidence of a new deployment.
  }

  function render() {
    if (!pending) { if (banner) banner.style.display = 'none'; return; }
    if (!document.body) return;
    if (!banner) {
      banner = document.createElement('div');
      banner.setAttribute('role', 'status');
      banner.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;display:flex;gap:8px;align-items:center;'
        + 'justify-content:space-between;padding:8px 10px;border-radius:8px;background:#1b2a4a;color:#fff;font:12px/1.35 system-ui,sans-serif;'
        + 'box-shadow:0 4px 14px rgba(0,0,0,.35);';
      bannerText = document.createElement('span');
      reloadButton = document.createElement('button');
      reloadButton.type = 'button';
      reloadButton.textContent = 'Reload now';
      reloadButton.style.cssText = 'flex:none;border:0;border-radius:6px;padding:4px 10px;background:#4f7cff;color:#fff;font:inherit;cursor:pointer;';
      reloadButton.addEventListener('click', () => reloadIfSafe({ ignoreIdle: true }));
      banner.append(bannerText, reloadButton);
      document.body.appendChild(banner);
    }
    const ready = safeToReload();
    bannerText.textContent = ready
      ? 'A new version is available. It will load when you are idle.'
      : 'A new version is available. It will load after your current lookup or Blast finishes.';
    reloadButton.disabled = !ready;
    reloadButton.style.opacity = ready ? '1' : '0.5';
    banner.style.display = 'flex';
  }

  function reloadIfSafe({ ignoreIdle = false } = {}) {
    if (!pending || refreshing) return;
    render();
    if (document.hidden && !ignoreIdle) return;                       // wait until the widget is actually shown
    if (!safeToReload()) return;                                      // lookups, Blast, queued work, focused field...
    if (!ignoreIdle && Date.now() - lastActivity < IDLE_MS) return;   // someone is working in it right now
    // One attempt per release per tab, even if an intermediary serves old HTML.
    const key = `rc-refreshed-release:${pending}`;
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch (_) { /* storage blocked: still reload once */ }
    refreshing = true;
    try { window.prepareForDeploymentRefresh?.(); } catch (_) { /* never block the reload on a save hiccup */ }
    location.reload();
  }

  async function checkRelease({ force = false } = {}) {
    if (checking || refreshing || (document.hidden && !force && baseline)) return;
    checking = true;
    try {
      const version = await fetchVersion();
      if (!version) return;
      // First successful read of an unstamped page = the version this page was loaded with.
      if (!baseline) { baseline = version; return; }
      if (version === baseline) { pending = ''; render(); return; }
      pending = version;
      reloadIfSafe();
    } finally { checking = false; }
  }

  setInterval(checkRelease, POLL_MS);
  setInterval(() => { if (pending) reloadIfSafe(); }, RETRY_MS);
  document.addEventListener('visibilitychange', () => { checkRelease(); if (pending) reloadIfSafe(); });
  checkRelease({ force: true }); // establish the baseline right away
})();
