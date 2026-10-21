(() => {
  const meta = document.querySelector('meta[name="widget-release"]')?.content || '';
  const isVersion = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
  const stamped = isVersion(meta);
  const endpoint = stamped ? '/release.json' : '/widget-version';
  const POLL_MS = 60000;
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
    } catch (_) { return ''; }
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
      if (!baseline) { baseline = version; return; }
      pending = version === baseline ? '' : version;
      render();
    } finally { checking = false; }
  }

  window.deploymentUpdatePending = () => !!pending;

  window.reloadForDeploymentUpdate = () => {
    if (!pending) return 'none';
    const key = `rc-refreshed-release:${pending}`;
    try {
      if (sessionStorage.getItem(key)) return 'already-tried';
      sessionStorage.setItem(key, '1');
    } catch (_) { }
    location.reload();
    return 'reloaded';
  };

  setInterval(checkRelease, POLL_MS);
  document.addEventListener('visibilitychange', () => { checkRelease(); });
  checkRelease({ force: true });
})();
