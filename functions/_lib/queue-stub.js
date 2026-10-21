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
