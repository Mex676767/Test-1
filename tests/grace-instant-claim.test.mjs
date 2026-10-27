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
const consts = [
  app.match(/const GRACE_DEPOSIT_RULE = "[a-zA-Z]+";/)[0],
  app.match(/const GRACE_REQUIRED_DEPOSIT_BY_BONUS = \{[^}]*\};/)[0],
].join('\n');
const functions = ['graceClaimAmount', 'graceTerms', 'graceDepositCheck', 'graceInstantState', 'renderGraceInstant'].map(grab).join('\n');
const escapeHtml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const load = (rule) => {
  const source = rule ? consts.replace(/"atLeast"/, `"${rule}"`) : consts;
  return vm.runInContext(`${source}\n${functions}\n({ graceTerms, graceDepositCheck, graceInstantState, renderGraceInstant })`,
    vm.createContext({ String, Number, escapeHtml }));
};
const g = load();

test('the bonus and the required deposit are read from the Grace Period text', () => {
  assert.deepEqual({ ...g.graceTerms('Pass 108') }, { bonus: '108', required: 1000 }, 'RM108 is the RM1,000 bonus of the SOP');
  assert.deepEqual({ ...g.graceTerms('Pass RM108') }, { bonus: '108', required: 1000 });
  assert.deepEqual({ ...g.graceTerms('Activated : 2026-10-17 14:35 - Pass - 108') }, { bonus: '108', required: 1000 });
  assert.deepEqual({ ...g.graceTerms('Activated: Pass - Deposit 1,500 Bonus 158') }, { bonus: '158', required: 1500 }, 'a requirement written in the text wins');
});

test('a bonus with no known requirement can never be claimed instantly', () => {
  const unknown = g.graceInstantState('Pass 58', '99999', false);
  assert.equal(unknown.known, false);
  assert.equal(unknown.ready, false);
  assert.match(unknown.note, /isn't set up/);
  assert.equal(g.graceInstantState('Pass', '1000', false).ready, false);
});

test('claim stays blocked until the entered deposit reaches the requirement', () => {
  assert.equal(g.graceInstantState('Pass 108', '', false).ready, false);
  assert.match(g.graceInstantState('Pass 108', '', false).note, /RM1000 needed/);
  const short = g.graceInstantState('Pass 108', '999.99', false);
  assert.equal(short.ready, false);
  assert.match(short.note, /RM999\.99 entered — RM1000 needed/);
  assert.equal(g.graceInstantState('Pass 108', 'abc', false).ready, false);
  assert.equal(g.graceInstantState('Pass 108', '0', false).ready, false);
});

test('"at least" reading: the exact amount and a bigger deposit both unlock the claim', () => {
  assert.equal(g.graceInstantState('Pass 108', '1000', false).ready, true);
  assert.equal(g.graceInstantState('Pass 108', '1,000', false).ready, true);
  assert.equal(g.graceInstantState('Pass 108', '1200.5', false).ready, true);
  assert.equal(g.graceInstantState('Pass 108', '1000', false).label, 'Claim RM108');
});

test('the rule is one constant: "exact" only accepts the required amount', () => {
  const exact = load('exact');
  assert.equal(exact.graceInstantState('Pass 108', '1000', false).ready, true);
  assert.equal(exact.graceInstantState('Pass 108', '1200', false).ready, false);
  assert.match(exact.graceInstantState('Pass 108', '1200', false).note, /exactly RM1000/);
});

test('another bonus already claimed in the case keeps Grace Period blocked (1 bonus per case)', () => {
  const blocked = g.graceInstantState('Pass 108', '1000', true);
  assert.equal(blocked.ready, false);
  assert.match(blocked.note, /Another bonus is already claimed/);
});

test('the card shows the deposit box and a disabled Claim until the deposit matches', () => {
  const before = g.renderGraceInstant('C1', 'Pass 108', '500', false);
  assert.match(before, /class="grace-deposit-input"[^>]*value="500"/);
  assert.match(before, /grace-claim-btn" data-action="claim" data-program="gracePeriod" data-chat="C1" disabled/);
  const after = g.renderGraceInstant('C1', 'Pass 108', '1000', false);
  assert.doesNotMatch(after, /data-program="gracePeriod"[^>]*disabled/);
  assert.match(after, /grace-deposit-note ready/);
  assert.match(after, />Claim RM108</);
  assert.doesNotMatch(g.renderGraceInstant('C1', 'Pass 58', '', false), /grace-deposit-input/, 'no box when the requirement is unknown');
});

test('the entered text is escaped in the card', () => {
  assert.doesNotMatch(g.renderGraceInstant('C1', 'Pass 108', '"><img src=x>', false), /<img/);
});

test('claim handler: Activate only before activation; after it the claim needs the matching deposit, then the normal claim runs', () => {
  const claim = app.slice(app.indexOf('if (programKey === "gracePeriod") {'), app.indexOf('// Telegram RM28 / Redeem Code / Special Reload'));
  assert.match(claim, /const isPass = /);
  assert.match(claim, /if \(isPass && s\.gracePeriodActivated\) \{[\s\S]*?graceInstantState\(display, s\.graceDepositAmount, otherClaim\);[\s\S]*?if \(!g\.ready\) \{[\s\S]*?setStatus\(g\.note, "error"\);[\s\S]*?return;/);
  assert.match(claim, /if \(isPass && !s\.gracePeriodActivated\) \{[\s\S]*?s\.status = "Activated";/);
  assert.match(claim, /raiseClaimTicket\(chatId, "gracePeriod", amount\)/, 'the claim ticket popup is still raised');
  assert.match(claim, /submitRecord\(chatId, \{ auto: true, reason: "Grace Period claimed" \}\)/, 'the Lark record is still written');
});

test('card: an activated Grace Period shows the deposit panel; a claimed one shows ✓ Claimed with the undo button', () => {
  assert.match(app, /def\.graceInstant = isPass && !!s\.gracePeriodActivated && !graceClaimed;/);
  assert.match(app, /def\.doneLabel = isPass && !graceClaimed \? "✓ Activated" : "✓ Claimed";/);
  assert.match(app, /d\.graceInstant \? renderGraceInstant\(chatId, d\.display, s\.graceDepositAmount, alreadyClaimedOne\)/);
});

test('the deposit is kept per case and cleared on a new lookup, a case switch and an undo of the activation', () => {
  assert.match(app, /"riskReloadAmount", "graceDepositAmount",/, 'saved with the case');
  assert.equal((app.match(/s\.graceDepositAmount = "";/g) || []).length >= 4, true);
  assert.match(app, /if \(wasGraceActivationOnly\) \{\s*s\.gracePeriodActivated = false;\s*s\.graceDepositAmount = "";/);
  assert.match(app, /const graceDepositInput = e\.target\.closest\("\.grace-deposit-input"\);/);
});
