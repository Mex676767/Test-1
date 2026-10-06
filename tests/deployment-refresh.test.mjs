import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../deployment-refresh.js', import.meta.url), 'utf8');

const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40), NEWER = 'c'.repeat(40);
const flush = () => new Promise((resolve) => setImmediate(resolve));

// A tiny fake page: tracks reloads, the banner, timers, activity events and what was fetched.
function boot({ meta = 'development', version = OLD, safe = () => true } = {}) {
  const s = { version, ok: true, hidden: false, clock: 1_000_000, reloads: 0, saves: 0, fetched: [], banner: null, intervals: [], listeners: {}, appended: [] };
  const store = new Map();
  const el = (tag) => ({ tag, style: {}, children: [], handlers: {}, textContent: '', disabled: false,
    setAttribute() {}, append(...c) { this.children.push(...c); }, addEventListener(n, fn) { this.handlers[n] = fn; } });
  const document = {
    get hidden() { return s.hidden; },
    querySelector: () => ({ content: meta }),
    addEventListener(name, fn) { (s.listeners[name] ||= []).push(fn); },
    createElement: el,
    body: { appendChild(node) { s.banner = node; s.appended.push(node); } },
  };
  const context = {
    document, Date: { now: () => s.clock },
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    fetch: async (url) => { s.fetched.push(url); return { ok: s.ok, json: async () => ({ version: s.version }) }; },
    setInterval: (fn, ms) => { s.intervals.push({ fn, ms }); return s.intervals.length; },
    location: { reload: () => { s.reloads += 1; } },
    window: { canRefreshForDeployment: () => safe(), prepareForDeploymentRefresh: () => { s.saves += 1; } },
  };
  vm.runInNewContext(source, context);
  const poll = s.intervals.find((i) => i.ms === 60000).fn;
  const retry = s.intervals.find((i) => i.ms === 5000).fn;
  const emit = (name) => (s.listeners[name] || []).forEach((fn) => fn());
  const bannerText = () => s.banner?.children[0]?.textContent || '';
  const button = () => s.banner?.children[1];
  return { s, poll, retry, emit, bannerText, button };
}
const IDLE = 21_000;   // a bit more than the widget's 20 s idle window

test('git-push deploys: the first read is the baseline; an unchanged version never reloads or nags', async () => {
  const p = boot();
  await flush();
  assert.deepEqual(p.s.fetched, ['/widget-version'], 'unstamped pages ask /widget-version, not /release.json');
  p.s.clock += 120_000; await p.poll(); await flush(); p.retry();
  assert.equal(p.s.reloads, 0);
  assert.equal(p.s.banner, null, 'no banner');
});

test('a new version shows a banner, waits until the widget is idle, then reloads once (saving state first)', async () => {
  const p = boot();
  await flush();
  p.s.version = NEW;
  p.s.clock += 5_000;                       // the agent was active a moment ago
  await p.poll(); await flush();
  assert.match(p.bannerText(), /new version is available/i);
  assert.equal(p.s.reloads, 0, 'recently active: not yet');
  p.s.clock += IDLE; p.retry();
  assert.equal(p.s.reloads, 1);
  assert.equal(p.s.saves, 1, 'state is saved right before the reload');
  p.retry(); await p.poll(); await flush();
  assert.equal(p.s.reloads, 1, 'only one reload per release per tab');
});

test('activity keeps postponing the reload', async () => {
  const p = boot();
  await flush();
  p.s.version = NEW; await p.poll(); await flush();
  p.s.clock += IDLE - 5000; p.emit('keydown'); p.retry();     // typing just now
  assert.equal(p.s.reloads, 0);
  p.s.clock += 10_000; p.retry();
  assert.equal(p.s.reloads, 0, 'still inside the idle window after the keystroke');
  p.s.clock += IDLE; p.retry();
  assert.equal(p.s.reloads, 1);
});

test('never reloads during a lookup / Blast run / queue / focused field, and says why', async () => {
  let busy = true;
  const p = boot({ safe: () => !busy });
  await flush();
  p.s.version = NEW; p.s.clock += IDLE; await p.poll(); await flush();
  p.s.clock += IDLE; p.retry(); p.retry();
  assert.equal(p.s.reloads, 0);
  assert.match(p.bannerText(), /after your current lookup or Blast finishes/i);
  assert.equal(p.button().disabled, true);
  busy = false; p.s.clock += 1000; p.retry();
  assert.equal(p.s.reloads, 1, 'reloads as soon as it is safe');
});

test('"Reload now" reloads immediately when it is safe, even if the agent was just active', async () => {
  const p = boot();
  await flush();
  p.s.version = NEW; await p.poll(); await flush();
  p.emit('pointerdown');
  p.retry();
  assert.equal(p.s.reloads, 0);
  assert.equal(p.button().disabled, false);
  p.button().handlers.click();
  assert.equal(p.s.reloads, 1);
});

test('"Reload now" still refuses when it is not safe', async () => {
  const p = boot({ safe: () => false });
  await flush();
  p.s.version = NEW; await p.poll(); await flush();
  p.button().handlers.click();
  assert.equal(p.s.reloads, 0);
});

test('a hidden widget does not reload; it does once shown and idle', async () => {
  const p = boot();
  await flush();
  p.s.version = NEW; await p.poll(); await flush();
  p.s.hidden = true; p.s.clock += IDLE; p.retry();
  assert.equal(p.s.reloads, 0);
  p.s.hidden = false; p.emit('visibilitychange'); await flush();
  assert.equal(p.s.reloads, 1);
});

test('errors, non-JSON and malformed versions are "no information": no baseline, no reload', async () => {
  const p = boot({ version: 'not-a-version' });
  await flush();
  p.s.clock += IDLE; await p.poll(); await flush(); p.retry();
  assert.equal(p.s.reloads, 0);
  p.s.ok = false; p.s.version = NEW; await p.poll(); await flush();
  assert.equal(p.s.reloads, 0);
  // the first GOOD answer later becomes the baseline (still no reload)
  p.s.ok = true; p.s.version = OLD; await p.poll(); await flush(); p.retry();
  assert.equal(p.s.reloads, 0);
  p.s.version = NEW; p.s.clock += IDLE; await p.poll(); await flush(); p.retry();
  assert.equal(p.s.reloads, 1);
});

test('a second, newer release triggers another reload (one per release, not one per tab lifetime)', async () => {
  const p = boot();
  await flush();
  p.s.version = NEW; p.s.clock += IDLE; await p.poll(); await flush(); p.retry();
  assert.equal(p.s.reloads, 1);
  // pretend the page reloaded and now loads NEW as its baseline, then NEWER ships
  const q = boot({ version: NEW });
  await flush();
  q.s.version = NEWER; q.s.clock += IDLE; await q.poll(); await flush(); q.retry();
  assert.equal(q.s.reloads, 1);
});

test('stamped (deploy.ps1) releases keep working: baseline is the meta tag and the poll uses /release.json', async () => {
  const p = boot({ meta: OLD, version: OLD });
  await flush();
  assert.deepEqual(p.s.fetched.every((u) => u === '/release.json'), true);
  p.s.clock += IDLE; await p.poll(); await flush(); p.retry();
  assert.equal(p.s.reloads, 0, 'same release: nothing');
  p.s.version = NEW; await p.poll(); await flush(); p.retry();
  assert.equal(p.s.reloads, 1);
  // Even stale HTML served after a refresh must not cause a reload loop.
  const again = boot({ meta: OLD, version: NEW });
  again.s.clock += IDLE; await again.poll(); await flush(); again.retry();
  assert.equal(again.s.reloads, 1, 'its own tab: once');
});
