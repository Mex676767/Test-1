(() => {
  // "New version available" notice. It NEVER reloads the page by itself: an automatic reload can interrupt a ticket being
  // created, a claim in flight, unsent attachments (memory only) or an agent typing in LiveChat's own chat box (outside this
  // iframe, so it looks idle here). The agent updates deliberately with the app's ⟳ Refresh button (app.js asks
  // window.deploymentUpdatePending() and, when it is safe, calls window.reloadForDeploymentUpdate()).
  //
  // Two kinds of release id, both explicit 40-hex versions (never ETags or file sizes):
  //  * deploy.ps1 releases stamp the commit into the widget-release meta tag and /release.json;
  //  * plain git-push deploys (the normal path) cannot stamp anything, so /widget-version reports a hash of the
  //    deployed client files, and the first successful read after load is this page's own baseline.
  //
  // Known limit: that baseline is read AFTER the page loaded, so a deploy that lands in the few seconds between "the
  // scripts were fetched" and "the first /widget-version answer" becomes the baseline and is not announced until the
  // next deploy. Closing it would need per-file hashes compared with the exact bytes this page loaded; the window is a
  // few seconds per page load, and the page's own cache headers (revalidate on every load) shrink the damage.
  const meta = document.querySelector('meta[name="widget-release"]')?.content || '';
  const isVersion = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
  const stamped = isVersion(meta);
  const endpoint = stamped ? '/release.json' : '/widget-version';
  const POLL_MS = 60000;      // how often to ask which version is deployed (skipped while the widget is hidden)
  let baseline = stamped ? meta : '';
  let pending = '';
  let checking = false;
  let banner = null;

  async function fetchVersion() {
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) return '';
      const { version } = await response.json();
      return isVersion(version) ? version : '';
    } catch (_) { return ''; } // A failed or odd answer is "no information", never evidence of a new deployment.
  }

  function render() {
    const button = document.getElementById?.('refreshBtn');
    if (button) {
      if (button.dataset && !button.dataset.defaultTitle) button.dataset.defaultTitle = button.title || '';
      button.classList.toggle('update-pending', !!pending);
      button.title = pending ? 'New version available — click to update' : (button.dataset?.defaultTitle || button.title);
    }
    if (!pending) { if (banner) banner.style.display = 'none'; return; }
    if (!document.body) return;
    if (!banner) {
      banner = document.createElement('div');
      banner.setAttribute('role', 'status');
      banner.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;padding:8px 10px;border-radius:8px;'
        + 'background:#1b2a4a;color:#fff;font:12px/1.35 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35);text-align:center;';
      banner.textContent = 'New version available — click ⟳ Refresh at the top to update.';
      document.body.appendChild(banner);
    }
    banner.style.display = 'block';
  }

  async function checkRelease({ force = false } = {}) {
    if (checking || (document.hidden && !force && baseline)) return;
    checking = true;
    try {
      const version = await fetchVersion();
      if (!version) return;
      // First successful read of an unstamped page = the version this page was loaded with.
      if (!baseline) { baseline = version; return; }
      pending = version === baseline ? '' : version;
      render();
    } finally { checking = false; }
  }

  window.deploymentUpdatePending = () => !!pending;

  // Called by the ⟳ button once app.js has decided it is safe. One reload per release per tab, so a stale page served by an
  // intermediary can never trap the agent in a reload loop. Returns 'reloaded' | 'already-tried' | 'none'.
  window.reloadForDeploymentUpdate = () => {
    if (!pending) return 'none';
    const key = `rc-refreshed-release:${pending}`;
    try {
      if (sessionStorage.getItem(key)) return 'already-tried';
      sessionStorage.setItem(key, '1');
    } catch (_) { /* storage blocked: still allow the one click */ }
    location.reload();
    return 'reloaded';
  };

  setInterval(checkRelease, POLL_MS);
  document.addEventListener('visibilitychange', () => { checkRelease(); });
  checkRelease({ force: true }); // establish the baseline right away
})();
