import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../deployment-refresh.js', import.meta.url), 'utf8');

const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40), NEWER = 'c'.repeat(40);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const DAY = 24 * 60 * 60 * 1000;

// A tiny fake page: reloads, notice, the ⟳ button, timers, listeners and every fetch.
function boot({ meta = 'development', version = OLD, safe = true } = {}) {
  const s = { version, ok: true, hidden: false, clock: 1_000_000, reloads: 0, fetched: [], banner: null, intervals: [], listeners: {}, store: new Map() };
  const el = (tag) => ({ tag, style: {}, textContent: '', children: [], setAttribute() {}, append(...c) { this.children.push(...c); } });
  const button = { title: 'Refresh active chats', dataset: {}, classes: new Set(), classList: { toggle(name, on) { on ? button.classes.add(name) : button.classes.delete(name); } } };
  const document = {
    get hidden() { return s.hidden; },
    querySelector: () => ({ content: meta }),
    getElementById: (id) => (id === 'refreshBtn' ? button : null),
    addEventListener(name, fn) { (s.listeners[name] ||= []).push(fn); },
    createElement: el,
    body: { appendChild(node) { s.banner = node; } },
  };
  const context = {
    document, Date: { now: () => s.clock },
    sessionStorage: { getItem: (k) => s.store.get(k) ?? null, setItem: (k, v) => s.store.set(k, v) },
    fetch: async (url) => { s.fetched.push(url); return { ok: s.ok, json: async () => ({ version: s.version }) }; },
    setInterval: (fn, ms) => { s.intervals.push({ fn, ms }); return s.intervals.length; },
    location: { reload: () => { s.reloads += 1; } },
    window: { canRefreshForDeployment: () => safe, prepareForDeploymentRefresh() {} },
  };
  vm.runInNewContext(source, context);
  const w = context.window;
  return { s, w, button, poll: () => s.intervals.find((i) => i.ms === 60000).fn(), emit: (n) => (s.listeners[n] || []).forEach((fn) => fn()),
    notice: () => (s.banner && s.banner.style.display !== 'none' ? s.banner.textContent : '') };
}

test('unstamped (git-push) pages: first read is the baseline; an unchanged version shows nothing', async () => {
  const p = boot();
  await flush();
  assert.deepEqual(p.s.fetched, ['/widget-version']);
  p.s.clock += 120_000; await p.poll(); await flush();
  assert.equal(p.w.deploymentUpdatePending(), false);
  assert.equal(p.notice(), '');
  assert.equal(p.button.classes.has('update-pending'), false);
});

test('a new version shows the notice and highlights ⟳, and NEVER reloads on its own', async () => {
  const p = boot({ safe: true });                               // even when everything says it would be safe and idle
  await flush();
  p.s.version = NEW; await p.poll(); await flush();
  assert.equal(p.notice(), 'New version available — click ⟳ Refresh at the top to update.');
  assert.equal(p.s.banner.children.length, 0, 'the notice has no button of its own: ⟳ is the one way to update');
  assert.equal(p.w.deploymentUpdatePending(), true);
  assert.equal(p.button.classes.has('update-pending'), true);
  assert.match(p.button.title, /New version available/);
  // time passes: a day of polls, retries, visibility changes, activity
  for (let i = 0; i < 200; i += 1) {
    p.s.clock += DAY / 200;
    await p.poll(); await flush();
    p.emit('visibilitychange'); p.emit('keydown'); p.emit('pointerdown');
    p.s.intervals.forEach((t) => t.fn());                       // every timer the script ever registered
  }
  assert.equal(p.s.reloads, 0, 'no automatic reload path exists any more');
});

test('only polling remains: every 60 s, and not while the widget is hidden', async () => {
  const p = boot();
  await flush();
  assert.deepEqual(p.s.intervals.map((i) => i.ms), [60000], 'one timer: the notice poll (no idle/retry reload timers)');
  const fetched = p.s.fetched.length;
  p.s.hidden = true; await p.poll(); await flush();
  assert.equal(p.s.fetched.length, fetched, 'hidden: no request');
  p.s.hidden = false; p.emit('visibilitychange'); await flush();
  assert.equal(p.s.fetched.length, fetched + 1, 'visible again: checked at once');
});

test('the notice and highlight clear when the deployed version goes back to the one this page has', async () => {
  const p = boot();
  await flush();
  p.s.version = NEW; await p.poll(); await flush();
  assert.equal(p.w.deploymentUpdatePending(), true);
  p.s.version = OLD; await p.poll(); await flush();
  assert.equal(p.w.deploymentUpdatePending(), false);
  assert.equal(p.notice(), '');
  assert.equal(p.button.classes.has('update-pending'), false);
  assert.equal(p.button.title, 'Refresh active chats', 'the original tooltip is restored');
});

test('reloadForDeploymentUpdate: nothing without an update, one reload per release, and a newer release resets it', async () => {
  const p = boot();
  await flush();
  assert.equal(p.w.reloadForDeploymentUpdate(), 'none');
  assert.equal(p.s.reloads, 0);
  p.s.version = NEW; await p.poll(); await flush();
  assert.equal(p.w.reloadForDeploymentUpdate(), 'reloaded');
  assert.equal(p.s.reloads, 1);
  assert.equal(p.w.reloadForDeploymentUpdate(), 'already-tried', 'a stale page served by an intermediary cannot loop the reload');
  assert.equal(p.s.reloads, 1);
  p.s.version = NEWER; await p.poll(); await flush();
  assert.equal(p.w.reloadForDeploymentUpdate(), 'reloaded', 'a different release gets its own single attempt');
  assert.equal(p.s.reloads, 2);
});

test('errors, non-JSON and malformed versions are "no information": no baseline, no notice', async () => {
  const p = boot({ version: 'not-a-version' });
  await flush();
  await p.poll(); await flush();
  assert.equal(p.w.deploymentUpdatePending(), false);
  p.s.ok = false; p.s.version = NEW; await p.poll(); await flush();
  assert.equal(p.w.deploymentUpdatePending(), false);
  p.s.ok = true; p.s.version = OLD; await p.poll(); await flush();     // first GOOD answer becomes the baseline
  assert.equal(p.w.deploymentUpdatePending(), false);
  p.s.version = NEW; await p.poll(); await flush();
  assert.equal(p.w.deploymentUpdatePending(), true);
});

test('stamped (deploy.ps1) releases: baseline is the meta tag, the poll uses /release.json, still never automatic', async () => {
  const p = boot({ meta: OLD, version: OLD });
  await flush();
  assert.ok(p.s.fetched.every((u) => u === '/release.json'));
  p.s.version = NEW; await p.poll(); await flush();
  assert.equal(p.w.deploymentUpdatePending(), true);
  p.s.clock += DAY; await p.poll(); p.s.intervals.forEach((t) => t.fn());
  assert.equal(p.s.reloads, 0);
});

test('the script contains no location.reload() other than the one behind reloadForDeploymentUpdate', () => {
  const calls = source.match(/location\.reload\s*\(/g) || [];
  assert.equal(calls.length, 1);
  const at = source.indexOf('location.reload(');
  assert.ok(source.lastIndexOf('window.reloadForDeploymentUpdate', at) > source.lastIndexOf('setInterval', at) - 1, 'it lives inside reloadForDeploymentUpdate');
  assert.doesNotMatch(source, /IDLE_MS|RETRY_MS|lastActivity|reloadIfSafe/);
});
