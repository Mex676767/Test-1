// How Pages finds the shared Lark queue (the Durable Object). By default: the object named "lark-api-global", wherever Cloudflare put it.
//
// Two optional Pages variables make it possible to MOVE the queue to another region without a code change, and to move it back:
//   LARK_QUEUE_NAME            a different object name (default "lark-api-global"). A new name is a brand-new object (empty memory,
//                              fresh stats) and Cloudflare creates it NEAR THE FIRST CALLER, or at the region below.
//   LARK_QUEUE_LOCATION_HINT   where to create a new object: wnam, enam, sam, weur, eur, apac, oc, afr or me. The hint only matters
//                              when the object is created; an existing name never moves. Unset = no hint.
// Both unset = exactly today. See HANDOVER.md "Moving the queue closer to Lark" for the procedure and its risks (during the switch
// two objects can briefly both run, so do it off-peak).
export const DEFAULT_QUEUE_NAME = "lark-api-global";
const HINTS = new Set(["wnam", "enam", "sam", "weur", "eur", "apac", "oc", "afr", "me"]);

export function queueNameOf(env) {
  const name = String(env?.LARK_QUEUE_NAME || "").trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(name) ? name : DEFAULT_QUEUE_NAME;
}
export function queueHintOf(env) {
  const hint = String(env?.LARK_QUEUE_LOCATION_HINT || "").trim().toLowerCase();
  return HINTS.has(hint) ? hint : "";
}
export function queueStubFrom(binding, env) {
  const id = binding.idFromName(queueNameOf(env));
  const hint = queueHintOf(env);
  return hint ? binding.get(id, { locationHint: hint }) : binding.get(id);
}
