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
const source = ['escapeHtml', 'halloweenActionable', 'halloweenInput', 'halloweenChip', 'renderHalloweenCard'].map(grab).join('\n');

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
    day1: /Player's choice/, day2: /Did the player share today\?/, day3: /share again today/, day3NoShare: /did not share on Day 2/,
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
