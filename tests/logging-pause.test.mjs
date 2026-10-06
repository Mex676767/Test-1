import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function pauseContext() {
  const consts = app.match(/const LOGGING_TABS = [^\n]*/)[0];
  const fn = app.match(/function isLoggingPaused\(\)[^\n]*/)[0];
  const context = vm.createContext({});
  vm.runInContext(`let activeMainTab = 'customer'; let blastRunInProgress = false; let blastLoggingLock = false; ${consts} ${fn}`, context);
  return { paused: () => vm.runInContext('isLoggingPaused()', context), set: (code) => vm.runInContext(code, context) };
}

test('logging is on for the Retention tab only', () => {
  const c = pauseContext();
  assert.equal(c.paused(), false, 'Retention records chats');
  for (const tab of ['blast', 'tickets', 'knowledge', 'some-future-tab', '']) {
    c.set(`activeMainTab = ${JSON.stringify(tab)}`);
    assert.equal(c.paused(), true, `${tab || '(empty)'} pauses logging`);
  }
  c.set(`activeMainTab = 'customer'`);
  assert.equal(c.paused(), false, 'back on Retention it resumes by itself');
});

test('an active Blast pauses logging even if the agent is looking at Retention', () => {
  const c = pauseContext();
  c.set('blastRunInProgress = true');
  assert.equal(c.paused(), true);
  c.set('blastRunInProgress = false; blastLoggingLock = true');
  assert.equal(c.paused(), true);
  c.set('blastLoggingLock = false');
  assert.equal(c.paused(), false);
});

test('every tab button in the page except Retention pauses logging (so a new tab does too, without touching this code)', () => {
  const tabs = [...html.matchAll(/data-main-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(tabs.includes('customer') && tabs.length >= 4, tabs.join(','));
  const c = pauseContext();
  for (const tab of tabs) {
    c.set(`activeMainTab = ${JSON.stringify(tab)}`);
    assert.equal(c.paused(), tab !== 'customer', tab);
  }
});

test('the manual checkbox and its storage are gone; every logging gate asks isLoggingPaused()', () => {
  assert.doesNotMatch(html, /loggingPauseCheck|loggingPauseToggle|Don't log chats|customerTools/);
  assert.doesNotMatch(app, /loggingPauseCheck|loggingPauseToggle|\bloggingPaused\b/);
  assert.match(app, /localStorage\.removeItem\("rc-logging-paused"\)/, 'a stale saved value is cleared');
  const gates = app.match(/isLoggingPaused\(\)/g) || [];
  assert.ok(gates.length >= 5, `used by the submit gate, the banner, both sweeps (found ${gates.length})`);
  const submit = app.slice(app.indexOf('async function submitRecord'));
  assert.ok(submit.indexOf('if (isLoggingPaused())') > -1 && submit.indexOf('if (isLoggingPaused())') < submit.indexOf('if (!selectedAgent)'), 'the gate comes before any write');
});

test('a paused record is deferred, not dropped: the gate returns without marking the chat logged', () => {
  const gate = app.match(/if \(isLoggingPaused\(\)\) \{[\s\S]*?return;\s*\}/)[0];
  assert.doesNotMatch(gate, /\.logged\s*=/);
  assert.doesNotMatch(gate, /autoRecordError\s*=/);
});
