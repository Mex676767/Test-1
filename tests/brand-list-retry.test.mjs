import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];

function harness({ loadOnAttempt = Infinity, startWith = [] } = {}) {
  const timers = [];
  const calls = { bootstrap: 0, brandList: 0 };
  const context = vm.createContext({
    BRAND_LIST_RETRY_MS: [15_000, 30_000, 60_000],
    brandListRetryTimer: null, brandListRetryCount: 0, brandOptions: startWith,
    setTimeout: (cb, ms) => { timers.push({ cb, ms }); return timers.length; },
  });
  context.fetchBootstrapOptions = async ({ fresh }) => {
    assert.equal(fresh, true, 'a retry skips any cached copy');
    calls.bootstrap++;
    if (calls.bootstrap >= loadOnAttempt) { context.brandOptions = ['AC', 'FUN']; return true; }
    return false;
  };
  context.fetchBrandOptions = async () => { calls.brandList++; };
  vm.runInContext(fn('scheduleBrandListRetry'), context);
  const fire = async () => { const t = timers.shift(); await t.cb(); return t.ms; };
  return { context, timers, calls, fire, schedule: () => vm.runInContext('scheduleBrandListRetry()', context) };
}

test('an empty Brand list is fetched again after 15 s, 30 s, then every 60 s until it loads', async () => {
  const h = harness({ loadOnAttempt: 4 });
  h.schedule();
  h.schedule();
  assert.equal(h.timers.length, 1, 'only one retry is pending at a time');
  assert.equal(await h.fire(), 15_000);
  assert.equal(await h.fire(), 30_000);
  assert.equal(await h.fire(), 60_000);
  assert.equal(h.calls.brandList, 3, 'falls back to the brand-only endpoint when bootstrap fails');
  assert.equal(await h.fire(), 60_000);
  assert.deepEqual(h.context.brandOptions, ['AC', 'FUN']);
  assert.equal(h.timers.length, 0, 'retries stop once brands are loaded');
  assert.equal(h.context.brandListRetryCount, 0);
});

test('a loaded Brand list schedules no retry', () => {
  const h = harness({ startWith: ['AC'] });
  h.schedule();
  assert.equal(h.timers.length, 0);
});

test('the dropdown refresh starts the retry check', () => {
  assert.match(fn('refreshDropdownOptions'), /scheduleBrandListRetry\(\);/);
});
