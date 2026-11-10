import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const grab = (name) => {
  const match = app.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `found ${name} in app.js`);
  return match[0];
};
const context = vm.createContext({});
vm.runInContext([
  app.match(/const RELOAD_DEPOSIT_PROGRAMS = new Set\([^)]*\);/)[0].replace('const ', 'var '),
  grab('needsReloadDeposit'), grab('reloadDepositValid'),
].join('\n'), context);
const { needsReloadDeposit, reloadDepositValid } = context;

test('reload bonuses need a deposit amount before Claim; free bonuses do not', () => {
  for (const key of ['vipBooster', 'redeemCode', 'specialReload']) assert.equal(needsReloadDeposit(key, {}), true, key);
  for (const key of ['topPnl', 'ltvTest', 'mooncake', 'vs96Feedback', 'telegram28']) assert.equal(needsReloadDeposit(key, {}), false, key);
});

test('Grace Period: the normal claim needs a deposit; Pass (Activate) uses its own deposit check', () => {
  assert.equal(needsReloadDeposit('gracePeriod', { gracePeriod: 'Eligible - Bonus 18' }), true);
  assert.equal(needsReloadDeposit('gracePeriod', { gracePeriod: 'Pass - Deposit 100 - Bonus 18' }), false);
});

test('only a positive amount counts as entered', () => {
  for (const value of ['', ' ', '0', '.', 'abc', undefined, null]) assert.equal(reloadDepositValid(value), false, String(value));
  for (const value of ['50', '1,000', '0.5', ' 200 ']) assert.equal(reloadDepositValid(value), true, value);
});

test('free bonus daily limit: a free bonus already given today (Malaysia time) greys out the others', () => {
  const ctx = vm.createContext({ BONUS_INQUIRY_MAP: { topPnl: 'TOP P&L', ltvTest: 'TOP LTV', mooncake: 'Moon Bonus', vs96Feedback: 'VS96 Feedback bonus', telegram28: 'Telegram RM28', vipBooster: '12hour VIP Deposit Boost' } });
  vm.runInContext([
    app.match(/const FREE_BONUS_PROGRAMS = new Set\([^)]*\);/)[0].replace('const ', 'var '),
    grab('malaysiaDay'), grab('freeBonusGivenToday'),
  ].join('\n'), ctx);
  const today = ctx.malaysiaDay();
  const s = (claimsToday, claimsDay = today, caRecordId = 'recNow') => ({ caRecordId, matchedRow: { claimsToday, claimsDay } });
  assert.equal(ctx.freeBonusGivenToday(s([{ recordId: 'recA', inquiry: ['TOP P&L'] }])), 'TOP P&L');
  assert.equal(ctx.freeBonusGivenToday(s([{ recordId: 'recA', inquiry: ['12hour VIP Deposit Boost'] }])), '', 'a reload bonus does not count');
  assert.equal(ctx.freeBonusGivenToday(s([{ recordId: 'recA', inquiry: ['TOP P&L'] }], '2000-01-01')), '', 'read on another day: wiped');
  assert.equal(ctx.freeBonusGivenToday(s([{ recordId: 'recNow', inquiry: ['TOP P&L'] }])), '', 'this case itself does not count');
  assert.equal(ctx.freeBonusGivenToday(s(null)), '', 'lookup could not read today\'s claims');
  assert.equal(ctx.malaysiaDay(Date.UTC(2026, 10, 9, 16, 0)), '2026-11-10', 'midnight in Malaysia starts the new day');
});
