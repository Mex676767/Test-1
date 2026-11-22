// Counting group-to-group chat transfers from LiveChat archives (admin report).
//
// A transfer counts when the chat's source group is tracked for that license and the destination is a different,
// non-tracked group... see classifyThread for the exact order of checks. Group IDs overlap between licenses, so
// every function works on one license at a time.
//
// The archive stores the chat's CURRENT group and one "chat_transferred" system message per transfer that only
// names the destination. The group a chat started in is not stored, so the source of a thread's FIRST transfer is
// unknown. Later transfers are known (source = destination of the previous transfer). A first transfer into a
// tracked group never counts whatever its source was, so that case is still decided; a first transfer into any other
// group is reported as "undetermined" instead of being guessed.

export const TRANSFER_LICENSES = {
  lc1: {
    label: "License 1",
    tracked: [45, 48, 31, 30, 51, 32, 26, 25, 60, 29, 41, 28, 33, 62, 40, 27, 34],
    notSource: { 67: "AS126 Priority Support", 55: "Priority 96", 54: "Priority TC" },
  },
  lc2: {
    label: "License 2",
    tracked: [22, 12, 5, 6, 26, 13, 27, 11, 23],
    notSource: { 29: "Priority 96", 28: "Priority TC" },
  },
};

export const KL_OFFSET_MS = 8 * 3_600_000; // Asia/Kuala_Lumpur is UTC+8 all year
export const WINDOW_BUFFER_MS = 2 * 86_400_000; // archives are filtered by thread start, transfers can come later
export const MAX_RANGE_DAYS = 92;

const clean = (value) => String(value ?? "").trim();

export function klDayStartMs(date) {
  const text = clean(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return NaN;
  return Date.parse(`${text}T00:00:00+08:00`);
}

export function klDay(ms) {
  return new Date(ms + KL_OFFSET_MS).toISOString().slice(0, 10);
}

export function rfc3339(ms) {
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");
}

const QUOTES = /^["'“”‘’`]+|["'“”‘’`]+$/g;
export function normName(value) {
  return clean(String(value ?? "").normalize("NFKC")).toLowerCase().replace(/\s+/g, " ").replace(QUOTES, "").trim();
}

export function buildDirectory(groups = [], agents = []) {
  const names = new Map();
  const byName = new Map();
  for (const group of groups) {
    const id = clean(group?.id);
    if (!id) continue;
    names.set(id, clean(group.name));
    const key = normName(group.name);
    if (key) byName.set(key, [...(byName.get(key) || []), id]);
  }
  const agentKeys = new Set();
  for (const agent of agents) for (const value of [agent?.name, agent?.id, agent?.email]) if (normName(value)) agentKeys.add(normName(value));
  return { names, byName, agentKeys };
}

function strings(value) {
  if (value == null) return [];
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object") return [value.name, value.title, value.email, value.group_name, value.id, value.group_id].flatMap(strings);
  return [];
}

export function isTransferEvent(event) {
  if (event?.type !== "system_message") return false;
  return event.system_message_type === "chat_transferred" || /transferred the chat to/i.test(clean(event.text));
}

export function targetStrings(event) {
  const vars = event?.text_vars && typeof event.text_vars === "object" ? event.text_vars : {};
  const fromVars = strings(vars.targets ?? vars.target);
  if (fromVars.length) return fromVars;
  const match = /transferred the chat to\s+(.+?)\s*\.?\s*$/i.exec(clean(event?.text));
  return match ? [match[1]] : [];
}

function resolveOne(text, dir, split = true) {
  const key = normName(text);
  if (!key) return [];
  const byName = dir.byName.get(key);
  if (byName) return byName.length === 1 ? [{ kind: "group", id: byName[0] }] : [{ kind: "unknown", text: clean(text), why: "name matches more than one group" }];
  if (/^\d+$/.test(key) && dir.names.has(key)) return [{ kind: "group", id: key }];
  if (dir.agentKeys.has(key)) return [{ kind: "agent" }];
  if (split) {
    const parts = clean(text).split(/\s*(?:,|&|\band\b)\s*/i).filter(Boolean);
    if (parts.length > 1) return parts.flatMap((part) => resolveOne(part, dir, false));
  }
  return [{ kind: "unknown", text: clean(text), why: "not a known group or agent" }];
}

export function resolveTargets(event, dir) {
  return targetStrings(event).flatMap((text) => resolveOne(text, dir));
}

// Walks one archived thread's transfers in order. `range` limits which transfers are reported, but the chain of
// groups is followed through all of them so a transfer in range still knows where it came from.
export function classifyThread(thread, license, dir, range = { fromMs: -Infinity, toMs: Infinity }) {
  const tracked = new Set(license.tracked.map(String));
  const events = (thread?.events || [])
    .map((event, index) => ({ event, index, at: Date.parse(event?.created_at || "") }))
    .filter(({ event }) => isTransferEvent(event))
    .sort((a, b) => (a.at - b.at) || (a.index - b.index));

  let current = null; // group the chat is in right now, null = not known
  const transfers = [];
  for (const { event, at } of events) {
    const targets = resolveTargets(event, dir);
    const groups = targets.filter((target) => target.kind === "group");
    const unknown = targets.filter((target) => target.kind === "unknown");
    const item = { at, text: clean(event.text), sourceId: current, destId: null, targets };
    const inRange = at >= range.fromMs && at < range.toMs;
    item.inRange = inRange;

    if (targets.length && targets.every((target) => target.kind === "agent")) {
      item.status = "ignoredAgent";
    } else if (groups.length !== 1 || unknown.length || targets.some((target) => target.kind === "agent")) {
      item.status = "unclassified";
      item.reason = !targets.length ? "no destination in the message"
        : unknown.length ? `destination not recognised: ${unknown.map((target) => target.text).join(" | ")}`
          : groups.length > 1 ? "more than one destination group" : "agent and group together";
      current = null;
    } else {
      const dest = groups[0].id;
      item.destId = dest;
      if (current === null) item.status = tracked.has(dest) ? "destTracked" : "undetermined";
      else if (current === dest) item.status = "sameGroup";
      else if (!tracked.has(current)) item.status = "sourceUntracked";
      else if (tracked.has(dest)) item.status = "destTracked";
      else item.status = "counted";
      current = dest;
    }
    transfers.push(item);
  }

  const finalGroups = ((thread?.access?.group_ids) || []).map(String);
  const mismatch = current !== null && finalGroups.length > 0 && !finalGroups.includes(current);
  return { transfers, mismatch, finalGroups };
}

export function newTotals() {
  return {
    threads: 0, threadsWithTransfers: 0, transfers: 0, counted: 0,
    sameGroup: 0, sourceUntracked: 0, destTracked: 0, ignoredAgent: 0, undetermined: 0, unclassified: 0, mismatchThreads: 0,
    byDay: {}, bySource: {}, byDestination: {}, undeterminedByDestination: {}, unclassifiedSamples: [],
  };
}

const bump = (map, key, by = 1) => { map[key] = (map[key] || 0) + by; };
const SAMPLE_LIMIT = 10;

export function addThread(totals, chat, license, dir, range) {
  const thread = chat?.thread || {};
  totals.threads += 1;
  const { transfers, mismatch } = classifyThread(thread, license, dir, range);
  const inRange = transfers.filter((item) => item.inRange);
  if (!inRange.length) return totals;
  totals.threadsWithTransfers += 1;
  if (mismatch) totals.mismatchThreads += 1;
  for (const item of inRange) {
    totals.transfers += 1;
    totals[item.status] += 1;
    if (item.status === "counted") {
      bump(totals.byDay, klDay(item.at));
      bump(totals.bySource, item.sourceId);
      bump(totals.byDestination, item.destId);
    } else if (item.status === "undetermined") {
      bump(totals.undeterminedByDestination, item.destId);
    } else if (item.status === "unclassified" && totals.unclassifiedSamples.length < SAMPLE_LIMIT) {
      totals.unclassifiedSamples.push(`${item.reason} — "${item.text}"`);
    }
  }
  return totals;
}
