import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const fn = app.match(/function bonusExpiredEarlier\([^)]*\) \{[\s\S]*?\n\}/)[0];
const { bonusExpiredEarlier } = vm.runInContext(`${fn}\n({ bonusExpiredEarlier })`, vm.createContext({ Number, Date }));

const DAY = 24 * 3600 * 1000;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

test('Grace Period that expired on an earlier day is hidden', () => {
  assert.equal(bonusExpiredEarlier('gracePeriod', { graceExpiryMs: startOfToday() - 1 }, {}), true);
  assert.equal(bonusExpiredEarlier('gracePeriod', { graceExpiryMs: Date.now() - 7 * DAY }, {}), true);
});

test('Risk Player that expired on an earlier day is hidden', () => {
  assert.equal(bonusExpiredEarlier('riskPlayer', { riskExpiryMs: Date.now() - 3 * DAY }, {}), true);
});

test('still shown on the expiry day and before it (Reactivate keeps working)', () => {
  assert.equal(bonusExpiredEarlier('gracePeriod', { graceExpiryMs: startOfToday() }, {}), false);
  assert.equal(bonusExpiredEarlier('gracePeriod', { graceExpiryMs: Date.now() + DAY }, {}), false);
  assert.equal(bonusExpiredEarlier('riskPlayer', { riskExpiryMs: Date.now() + DAY }, {}), false);
});

test('no expiry date, or another bonus, is never hidden by this rule', () => {
  assert.equal(bonusExpiredEarlier('gracePeriod', { graceExpiryMs: null }, {}), false);
  assert.equal(bonusExpiredEarlier('gracePeriod', {}, {}), false);
  assert.equal(bonusExpiredEarlier('topPnl', { graceExpiryMs: 1, riskExpiryMs: 1 }, {}), false);
});

test('already activated or claimed in this chat stays visible', () => {
  const old = Date.now() - 7 * DAY;
  assert.equal(bonusExpiredEarlier('gracePeriod', { graceExpiryMs: old }, { gracePeriodActivated: true }), false);
  assert.equal(bonusExpiredEarlier('gracePeriod', { graceExpiryMs: old }, { claimedPrograms: { gracePeriod: true } }), false);
  assert.equal(bonusExpiredEarlier('riskPlayer', { riskExpiryMs: old }, { claimedPrograms: { riskPlayer: true } }), false);
});

test('both the card list and the "Bonuses ready" status use the rule', () => {
  assert.match(app, /isClaimableValue\(r\[p\.key\]\) && !bonusExpiredEarlier\(p\.key, r, state\[chatId\]\)/);
  assert.match(app, /if \(bonusExpiredEarlier\(p\.key, r, s\)\) return;/);
});
