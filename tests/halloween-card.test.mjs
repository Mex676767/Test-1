import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const grab = (name) => {
  const match = app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `found ${name} in app.js`);
  return match[0];
};
const source = ['escapeHtml', 'halloweenActionable', 'halloweenInput', 'halloweenClaimLabel', 'halloweenChip', 'renderHalloweenCard'].map(grab).join('\n');

function widget(h, over = {}) {
  const s = { claimedPrograms: {}, halloweenChoice: '', halloweenDeposit: '', halloweenShared: false, halloweenMethod: '', halloweenPostLink: '', ...over };
  const context = vm.createContext({ state: { A: { ...s, matchedRow: { halloween: h } } }, previewMode: false, HALLOWEEN_METHODS: ['Social post', '5 friends'], HALLOWEEN_INQUIRY_PREFIX: 'Halloween Day ' });
  vm.runInContext(source, context);
  return context;
}
const table = [{ min: 500, trick: 200, treat: 150 }, { min: 300, trick: 120, treat: 90 }, { min: 100, trick: 40, treat: 30 }, { min: 50, trick: 18, treat: 15 }];
const base = { day: 2, brand: 'EZ', fullBrand: 'EZ96', tier: 'Tier V', redPacket: 28, shareExtra: 28 };
const HOSTILE = '"><img src=x onerror=alert(1)><script>alert(2)</script>\'';

const ALLOWED_TAGS = new Set(['div', 'button', 'label', 'span', 'input', 'strong', 'small', 'a']);
function assertSafe(html, label) {
  const tags = [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((match) => match[1].toLowerCase());
  assert.deepEqual(tags.filter((tag) => !ALLOWED_TAGS.has(tag)), [], `${label}: only the card's own tags may appear`);
  const withoutValues = html.replace(/="[^"]*"/g, '=""');
  const insideTags = [...withoutValues.matchAll(/<[^>]*>/g)].map((match) => match[0]).join(' ');
  assert.doesNotMatch(insideTags, /\son\w+\s*=/i, `${label}: no event-handler attribute may appear`);
  assert.doesNotMatch(html, /href="\s*javascript:/i, `${label}: no javascript: link`);
}

test('hostile text from Lark never turns into markup on any card state', () => {
  const states = [
    { ...base, state: 'day1', table, fullBrand: HOSTILE, tier: HOSTILE },
    { ...base, state: 'day2', choice: HOSTILE, track: HOSTILE, day1Deposit: HOSTILE, day1Bonus: HOSTILE },
    { ...base, day: 3, state: 'day3', canShare: true, shareMethod: HOSTILE, postLink: HOSTILE, choice: HOSTILE, day2Total: HOSTILE },
    { ...base, day: 3, state: 'day3', canShare: true, shareMethod: 'Social post', postLink: 'javascript:alert(1)', choice: 'TRICK' },
    { ...base, state: 'closed', message: HOSTILE },
    { ...base, state: 'done', message: HOSTILE },
  ];
  for (const [index, h] of states.entries()) {
    const ctx = widget(h, { halloweenShared: true, halloweenMethod: 'Social post', halloweenPostLink: HOSTILE, halloweenDeposit: HOSTILE, halloweenChoice: 'TRICK' });
    assertSafe(ctx.renderHalloweenCard('A'), `state ${index}`);
  }
  const claimed = widget({ ...base, state: 'day2' }, { claimedPrograms: { halloween: true }, halloweenClaim: { day: HOSTILE, amount: HOSTILE } });
  assertSafe(claimed.renderHalloweenCard('A'), 'claimed card');
});

test('a post link is only made clickable when it is a real web address', () => {
  const link = (postLink) => widget({ ...base, day: 3, state: 'day3', canShare: true, shareMethod: 'Social post', postLink, choice: 'TRICK' }, { halloweenShared: true }).renderHalloweenCard('A');
  assert.match(link('https://facebook.com/p/1'), /href="https:\/\/facebook\.com\/p\/1"/);
  assert.doesNotMatch(link('javascript:alert(1)'), /href=/);
  assert.doesNotMatch(link('data:text/html,<b>x</b>'), /href=/);
  assert.doesNotMatch(link('facebook.com/p/1'), /href=/, 'a bare domain is stored but not turned into a link');
});

test('the card amount follows the same rules as the server for any typed deposit', () => {
  const amountFor = (deposit, choice) => {
    const ctx = widget({ ...base, day: 1, state: 'day1', table }, { halloweenDeposit: deposit, halloweenChoice: choice });
    const input = ctx.halloweenInput(ctx.state.A, ctx.state.A.matchedRow.halloween);
    return input.valid ? input.amount : null;
  };
  const cases = [['350', 'TRICK', 120], ['350', 'TREAT', 90], ['200', 'TRICK', 40], ['50', 'TREAT', 15], ['500', 'TRICK', 200], ['99999', 'TREAT', 150], ['1,000', 'TRICK', 200],
    ['49', 'TRICK', null], ['0', 'TRICK', null], ['', 'TRICK', null], ['abc', 'TRICK', null], ['-5', 'TRICK', null], ['.', 'TRICK', null], ['350', '', null], ['1e3', 'TRICK', 200], [' 350 ', 'TRICK', 120]];
  for (const [deposit, choice, expected] of cases) assert.equal(amountFor(deposit, choice), expected, `RM${JSON.stringify(deposit)} ${choice}`);
});

test('Day 2 and Day 3 amounts add the share extra only when allowed', () => {
  const amount = (h, over) => {
    const ctx = widget(h, over);
    const input = ctx.halloweenInput(ctx.state.A, h);
    return input.valid ? input.amount : null;
  };
  const day2 = { ...base, state: 'day2' };
  assert.equal(amount(day2, {}), 28);
  assert.equal(amount(day2, { halloweenShared: true }), null, 'sharing needs a method');
  assert.equal(amount(day2, { halloweenShared: true, halloweenMethod: '5 friends' }), 56);
  assert.equal(amount(day2, { halloweenShared: true, halloweenMethod: 'Social post' }), null, 'a social post needs a link');
  assert.equal(amount(day2, { halloweenShared: true, halloweenMethod: 'Social post', halloweenPostLink: ' ' }), null);
  assert.equal(amount(day2, { halloweenShared: true, halloweenMethod: 'Social post', halloweenPostLink: 'https://x.test' }), 56);
  assert.equal(amount({ ...base, day: 3, state: 'day3', canShare: false, shareMethod: '5 friends' }, { halloweenShared: true }), 28, 'no share extra on Day 3 without a Day 2 share');
  assert.equal(amount({ ...base, day: 3, state: 'day3', canShare: true, shareMethod: '5 friends' }, { halloweenShared: true }), 56);
  assert.equal(amount({ ...base, tier: 'Tier 3', redPacket: 18, state: 'day2' }, { halloweenShared: true, halloweenMethod: '5 friends' }), 46);
});

test('admin preview can show every Halloween card state, and the switch only exists in admin preview', () => {
  const statesSource = app.match(/const HALLOWEEN_PREVIEW_STATES = \[[\s\S]*?\];/)[0];
  const extra = [statesSource, 'let halloweenPreviewKey = "day2";', grab('halloweenPreviewSample'), grab('renderHalloweenPreviewSwitch')].join('\n');
  const expected = {
    day1: /Player's choice/, topup: /New total deposited today/, day2: /Did the player share today\?/, day3: /share again today/, day3NoShare: /did not share on Day 2/,
    low: /below RM300/, done: /already claimed/, tier: /Tier 3 and Tier V players only/,
  };
  const keys = [];
  for (const preview of [true, false]) {
    const context = vm.createContext({ state: { A: { claimedPrograms: {} } }, previewMode: preview, BONUS_SHOWCASE_PREVIEW: preview, HALLOWEEN_METHODS: ['Social post', '5 friends'], HALLOWEEN_INQUIRY_PREFIX: 'Halloween Day ' });
    vm.runInContext(source + '\n' + extra + '\nthis.keys = HALLOWEEN_PREVIEW_STATES.map(([key]) => key);', context);
    if (!preview) { assert.equal(context.renderHalloweenPreviewSwitch('A'), '', 'agents never see the switch'); continue; }
    keys.push(...context.keys);
    assert.match(context.renderHalloweenPreviewSwitch('A'), /data-action="halloweenPreviewState"/);
    for (const key of context.keys) {
      context.state.A.matchedRow = { halloween: context.halloweenPreviewSample(key) };
      const html = context.renderHalloweenCard('A');
      assert.match(html, expected[key], `${key} renders its own state`);
      assertSafe(html, key);
    }
  }
  assert.deepEqual(keys, Object.keys(expected));
});

test('Day 1 top-up: the card pays the new total\'s row minus what was already paid, with the first choice', () => {
  const topup = { ...base, day: 1, state: 'topup', table, choice: 'TRICK', track: 'Below RM300', day1Deposit: 50, day1Bonus: 18 };
  const input = (h, deposit) => { const ctx = widget(h, { halloweenDeposit: deposit, halloweenChoice: 'TREAT' }); return ctx.halloweenInput(ctx.state.A, h); };
  assert.equal(input(topup, '300').amount, 102, 'RM50 → RM300 total: RM120 row minus RM18 paid');
  assert.match(input(topup, '300').sub, /TRICK · RM300 row RM120 − RM18 already paid/, 'TRICK stays, whatever was picked before');
  assert.match(input(topup, '300').next, /Unlocks Day 2 and Day 3/);
  assert.equal(input(topup, '150').amount, 22);
  assert.match(input(topup, '150').next, /Still below RM300/);
  assert.match(input(topup, '50').error, /more than the RM50 already counted/);
  assert.match(input(topup, '80').error, /still in the RM50 row: no extra bonus\. Next row at RM100/);
  assert.equal(input({ ...topup, choice: 'TREAT', day1Bonus: 15 }, '500').amount, 135);
  assert.equal(input({ ...topup, track: 'RM300+', day1Deposit: 300, day1Bonus: 120 }, '500').next, '', 'already unlocked: nothing more to say');

  const html = widget(topup).renderHalloweenCard('A');
  assert.match(html, /New total deposited today/);
  assert.match(html, />Claim top-up</);
  assert.match(html, /Day 1 so far/);
  assert.doesNotMatch(html, /Player's choice/, 'the choice cannot be changed on a top-up');
  assertSafe(widget({ ...topup, choice: HOSTILE, day1Deposit: HOSTILE, day1Bonus: HOSTILE }).renderHalloweenCard('A'), 'top-up');
  const claimed = widget(topup, { claimedPrograms: { halloween: true }, halloweenClaim: { day: 1, amount: 102, topup: true } }).renderHalloweenCard('A');
  assert.match(claimed, /Day 1 top-up claimed · RM102/);
});
