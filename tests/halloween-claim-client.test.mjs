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

function voidWidget({ reply, preview = false, ref = 'TK2610260001' } = {}) {
  const calls = { posts: [], status: [] };
  const s = { claimTickets: ref ? { halloween: ref, topPnl: 'TK2610260099' } : {} };
  const context = vm.createContext({
    state: { A: s }, previewMode: preview,
    ticketFields: [{ key: 'status', label: 'Status', options: [{ value: 'OPEN', label: 'Open' }, { value: 'X_VOID_TICKET', label: 'X. VOID TICKET' }] }],
    fetchTicketConfig: async () => {}, TICKET_FIELD_SPECS: [{ stateKey: 'status', keys: ['status'], labels: ['Status'] }],
    ticketFieldFor: (spec) => (spec?.stateKey === 'status' ? context.ticketFields[0] : undefined),
    ticketFieldOptions: (field) => field?.options || [],
    ticketAuthor: () => ({ accountKey: 'lc1' }), saveState: () => {},
    setStatus: (text, kind) => calls.status.push({ text, kind }),
    fetch: async (url, init) => { calls.posts.push({ url, body: JSON.parse(init.body) }); return { json: async () => reply }; },
  });
  vm.runInContext(grab('voidHalloweenTicket'), context);
  return { run: () => context.voidHalloweenTicket('A'), calls, s, context };
}

test('undoing a Halloween claim sets its ticket to the void status', async () => {
  const w = voidWidget({ reply: { ok: true } });
  await w.run();
  assert.equal(w.calls.posts.length, 1);
  assert.equal(w.calls.posts[0].url, '/ticket-update');
  assert.deepEqual(w.calls.posts[0].body.fields, { status: 'X_VOID_TICKET' });
  assert.equal(w.calls.posts[0].body.ref, 'TK2610260001');
  assert.equal(w.s.claimTickets.halloween, undefined, 'a new claim will raise a new ticket');
  assert.equal(w.s.claimTickets.topPnl, 'TK2610260099', 'other tickets are untouched');
  assert.match(w.calls.status.at(-1).text, /TK2610260001 is now X\. VOID TICKET/);
});

test('if the ticket cannot be voided, the undo stands and the agent is told to void it by hand', async () => {
  const w = voidWidget({ reply: { ok: false, error: 'You cannot change this ticket.' } });
  await w.run();
  assert.equal(w.calls.status.at(-1).kind, 'error');
  assert.match(w.calls.status.at(-1).text, /could not be voided \(You cannot change this ticket\.\)\. Void it by hand\./);
  assert.equal(w.s.claimTickets.halloween, 'TK2610260001');
});

function removeNoteWidget({ answer, undoneDay = 1, preview = false, blocker = '' }) {
  const calls = { posted: [], painted: 0 };
  const ui = { notes: ['old'] };
  const s = { halloweenUndoneDay: undoneDay };
  const context = vm.createContext({
    state: { A: s }, previewMode: preview, consoleNoteBlocker: () => blocker,
    postConsoleNote: async (_s, extra) => { calls.posted.push(extra); return answer; },
    noteUi: () => ui, paintNoteSection: () => { calls.painted++; },
  });
  vm.runInContext(grab('removeHalloweenActionNote'), context);
  return { run: () => context.removeHalloweenActionNote('A'), calls, ui, s };
}

test('undoing Day 1 asks the console to remove the Halloween Day 1 Action log line', async () => {
  const w = removeNoteWidget({ answer: { ok: true, removed: true } });
  assert.equal(await w.run(), ' The Action log note was removed.');
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.posted)), [{ remove: true, startsWith: 'Halloween Day 1:', type: 'action' }]);
  assert.equal(w.ui.notes, null, 'the shown note list is refreshed');
  assert.equal(w.s.halloweenUndoneDay, 0, 'asked once per undo');
  assert.equal(await removeNoteWidget({ answer: { ok: true, removed: false } }).run(), ' There was no Action log note to remove.');
});

test('a note that cannot be removed only warns the agent to remove it by hand', async () => {
  const text = await removeNoteWidget({ answer: { ok: false, error: 'The console did not answer.' } }).run();
  assert.match(text, /could not be removed \(The console did not answer\.\)\. Remove it by hand\./);
});

test('no note is removed for Day 2 or Day 3, in admin preview, or when notes are not possible', async () => {
  for (const options of [{ undoneDay: 2 }, { undoneDay: 3 }, { undoneDay: 0 }, { preview: true }, { blocker: 'Unknown player' }]) {
    const w = removeNoteWidget({ answer: { ok: true, removed: true }, ...options });
    assert.equal(await w.run(), '', JSON.stringify(options));
    assert.equal(w.calls.posted.length, 0, JSON.stringify(options));
  }
});

test('the removal result is added to the undo message, with or without a ticket to void', async () => {
  const withTicket = voidWidget({ reply: { ok: true } });
  await withTicket.context.voidHalloweenTicket('A', ' The Action log note was removed.');
  assert.match(withTicket.calls.status.at(-1).text, /is now X\. VOID TICKET\. The Action log note was removed\./);
  const noTicket = voidWidget({ reply: { ok: true }, ref: '' });
  await noTicket.context.voidHalloweenTicket('A', ' The Action log note could not be removed (x). Remove it by hand.');
  assert.equal(noTicket.calls.posts.length, 0);
  assert.equal(noTicket.calls.status.at(-1).kind, 'error');
  assert.match(noTicket.calls.status.at(-1).text, /^Halloween claim undone\. The Action log note could not be removed/);
});

test('nothing is voided in admin preview or when no ticket was raised', async () => {
  const preview = voidWidget({ reply: { ok: true }, preview: true });
  await preview.run();
  assert.equal(preview.calls.posts.length, 0);
  const none = voidWidget({ reply: { ok: true }, ref: '' });
  await none.run();
  assert.equal(none.calls.posts.length, 0);
});
