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
const source = ['halloweenActionable', 'halloweenInput', 'claimHalloween'].map(grab).join('\n');

// A Day 2 card for a Tier 3 player (RM18), ready to claim without sharing.
function widget({ verdict, preview = false }) {
  const calls = { posts: [], tickets: [], status: [], submitted: 0 };
  const button = { disabled: false, textContent: '' };
  const card = { querySelector: (selector) => (selector === '.hw-claim' ? button : { innerHTML: '' }) };
  const s = {
    username: 'zzali', brand: 'EZ', chatUrl: 'https://chat/1', claimedPrograms: {}, escalation: {}, inquiry: [],
    halloweenShared: false, halloweenMethod: '', halloweenPostLink: '',
    matchedRow: { halloween: { day: 2, state: 'day2', brand: 'EZ', fullBrand: 'EZ96', tier: 'Tier 3', redPacket: 18, shareExtra: 28 } },
  };
  const context = vm.createContext({
    state: { A: s }, previewMode: preview, selectedAgent: 'Aina', activeChats: [{ chatId: 'A', link: 'https://chat/1' }],
    HALLOWEEN_INQUIRY_PREFIX: 'Halloween Day ', inquiryOptions: ['Halloween Day 2'],
    setStatus: (text, kind) => calls.status.push({ text, kind }),
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.posts.push(body);
      return { json: async () => (body.preview ? verdict : { ok: true, day: 2, amount: verdict.amount }) };
    },
    raiseClaimTicket: async (_chatId, program, amount) => { calls.tickets.push({ program, amount }); return true; },
    chatListEl: { querySelector: () => card }, claimWriteInFlight: new Set(),
    logCaseOrigin: () => {}, reportClaim: () => {}, renderTickets: () => '', renderAutoFields: () => '', refreshInquiryChips: () => {},
    renderInquiryDropdown: () => '', refreshStatusChip: () => {}, renderStatusDropdown: () => '',
    submitRecord: async () => { calls.submitted++; }, addHalloweenActionNote: async () => {},
  });
  vm.runInContext(source, context);
  return { run: () => context.claimHalloween('A', button, card), calls, s };
}

test('the ticket is raised for the amount the server confirmed, after the rules were checked', async () => {
  const w = widget({ verdict: { ok: true, day: 2, amount: 18 } });
  await w.run();
  assert.equal(w.calls.posts[0].preview, true, 'first a check that writes nothing');
  assert.deepEqual(w.calls.tickets, [{ program: 'halloween', amount: 18 }]);
  assert.equal(w.calls.posts[1].preview, false, 'then the real claim');
  assert.equal(w.s.claimedPrograms.halloween, true);
  assert.equal(w.calls.submitted, 1);
});

test('if the server now says a different amount (tier or day changed), no ticket is raised and nothing is claimed', async () => {
  const w = widget({ verdict: { ok: true, day: 2, amount: 28 } });
  await w.run();
  assert.deepEqual(w.calls.tickets, []);
  assert.equal(w.calls.posts.length, 1, 'only the check ran');
  assert.equal(w.s.claimedPrograms.halloween, undefined);
  assert.match(w.calls.status.at(-1).text, /now RM28, not RM18.*Look up the player again/);
});

test('a claim the server would refuse never raises a ticket', async () => {
  const w = widget({ verdict: { ok: false, error: 'Day 2 was already claimed for this player.' } });
  await w.run();
  assert.deepEqual(w.calls.tickets, []);
  assert.equal(w.calls.posts.length, 1);
  assert.match(w.calls.status.at(-1).text, /already claimed.*Nothing was claimed/);
});

test('admin preview never raises a ticket and only sends a check', async () => {
  const w = widget({ verdict: { ok: true, day: 2, amount: 18 }, preview: true });
  await w.run();
  assert.deepEqual(w.calls.tickets, []);
  assert.ok(w.calls.posts.every((post) => post.preview === true));
  assert.equal(w.calls.submitted, 0);
});
