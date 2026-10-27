import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];

const amountFor = (previewMode, display) => vm.runInContext(`${fn('graceClaimAmount')}; graceClaimAmount(${JSON.stringify(display)})`, vm.createContext({ previewMode, String }));

const REAL = 'Activated : 2026-10-17 14:35 - Pass - 58';

test('the amount of a real activated Grace text is the number after "Pass - ", not the date', () => {
  assert.equal(amountFor(true, REAL), '58');
  assert.equal(amountFor(true, 'Activated : 2026-10-17 14:35 - Pass - 108.5  '), '108.5');
  assert.equal(amountFor(true, 'Activated : 2026-10-17 14:35 - Pass - 1000'), '1000');
});

test('the older "Bonus N" text is still read first, in preview and in the installed widget', () => {
  assert.equal(amountFor(true, 'Activated: Pass - Deposit 1000 Bonus 108'), '108');
  assert.equal(amountFor(false, 'Activated: Pass - Deposit 1000 Bonus 108'), '108');
});

test('installed widget: the same amount is read as in the admin preview', () => {
  assert.equal(amountFor(false, REAL), '58');
  assert.equal(amountFor(false, 'Activated : 2026-10-17 14:35 - Pass - 108.5  '), '108.5');
});

test('text with no amount gives nothing, so the claim keeps its old fallback', () => {
  assert.equal(amountFor(true, 'Activated : 2026-10-17 14:35 - Pass'), '');
  assert.equal(amountFor(true, ''), '');
  assert.equal(amountFor(true, 'Pass 58'), '', '"Pass 58" is the not-yet-activated text: no claim amount');
});

test('the claim handler uses it and keeps the old fallback to the whole text', () => {
  const claim = app.slice(app.indexOf('if (programKey === "gracePeriod") {'), app.indexOf('// Telegram RM28 / Redeem Code / Special Reload'));
  assert.match(claim, /const amount = graceClaimAmount\(display\) \|\| graceTerms\(display\)\.bonus;/);
  assert.match(claim, /s\.releasedBonusAmount = amount \|\| display;/);
  assert.match(claim, /s\.releasedAmountRaw = amount \|\| display;/);
});
