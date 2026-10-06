(() => {
  const loaded = document.querySelector('meta[name="widget-release"]')?.content;
  if (!loaded || loaded === 'development') return;
  let checking = false;
  let refreshing = false;
  async function checkRelease() {
    if (checking || refreshing || document.hidden) return;
    checking = true;
    try {
      const response = await fetch('/release.json', { cache: 'no-store' });
      if (!response.ok) return;
      const { version } = await response.json();
      if (typeof version !== 'string' || !/^[a-f0-9]{40}$/.test(version) || version === loaded) return;
      if (!window.canRefreshForDeployment?.()) return;
      // One attempt per release per tab, even if an intermediary serves old HTML.
      const key = `rc-refreshed-release:${version}`;
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
      refreshing = true;
      location.reload();
    } catch (_) { /* Network failure is not evidence of a new deployment. */ }
    finally { checking = false; }
  }
  setInterval(checkRelease, 60000);
  document.addEventListener('visibilitychange', checkRelease);
})();
