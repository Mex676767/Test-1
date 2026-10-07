// Stop rules for the load-test script, kept apart so they can be tested without a server.
//
// 1. Before a run starts the queue must NOT still be backed off from an earlier throttle: its gap (gapMs) has to equal the base gap
//    (250 ms in production). A raised gap means Lark throttled recently; a new burst would measure the back-off, not the queue.
// 2. After a run, stop if more than `maxNon200` requests did not answer HTTP 200, or if Lark throttled during the run
//    (limited / retries429 / tokenLimited went up in the queue's stats).
export const DEFAULT_BASE_GAP_MS = 250;
export const DEFAULT_MAX_NON_200 = 2;

export function checkRunStart(stats, baseGapMs = DEFAULT_BASE_GAP_MS) {
  if (!stats || typeof stats !== "object") return { ok: false, reason: "no queue snapshot: cannot tell whether the queue is still backed off" };
  if (Number(stats.gapMs) !== Number(baseGapMs)) return { ok: false, reason: `queue gapMs is ${stats.gapMs}, not the base gap ${baseGapMs}: it is still backed off after a throttle; wait until it recovers (it shrinks by about 20% every 20 successful calls) and try again` };
  if (Number(stats.active) > 0 || Number(stats.queued) > 0) return { ok: false, reason: `the queue is not idle (active ${stats.active}, queued ${stats.queued}): wait for other traffic to finish` };
  return { ok: true };
}

const delta = (before, after, key) => Number(after?.[key] || 0) - Number(before?.[key] || 0);

export function checkRunEnd({ results, before, after, maxNon200 = DEFAULT_MAX_NON_200 }) {
  const reasons = [];
  const non200 = results.filter((r) => r.status !== 200).length;
  if (non200 > maxNon200) reasons.push(`${non200} requests did not answer HTTP 200 (limit ${maxNon200})`);
  if (before && after) {
    for (const key of ["limited", "retries429", "tokenLimited"]) {
      const d = delta(before, after, key);
      if (d > 0) reasons.push(`${key} went up by ${d} during the run (Lark throttled)`);
    }
    if (Number(after.gapMs) > Number(before.gapMs)) reasons.push(`the queue's gapMs rose from ${before.gapMs} to ${after.gapMs}`);
  }
  return { stop: reasons.length > 0, reasons, non200 };
}
