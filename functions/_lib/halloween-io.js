// Lark reads used by the Halloween lookup and claim endpoint.
import {
  searchRecords, findOldestClaimableRow, getFieldOptionMap, toDisplay,
  TABLE_HALLOWEEN, TABLE_PNL,
} from "./lark.js";
import { F } from "./halloween.js";

const MAP_FIELDS = [F.tier, F.choice, F.track, F.shareMethod];

// Option id -> name maps, only needed if Lark returns ids instead of names. Never throws.
export async function readOptionMaps() {
  const maps = {};
  await Promise.all(MAP_FIELDS.map(async (name) => {
    try { maps[name] = await getFieldOptionMap(TABLE_HALLOWEEN, name); } catch (_) { }
  }));
  return maps;
}

// The player's one Halloween row (oldest if a race made two), or null.
export function readHalloweenRow(username, brand, opts = {}) {
  if (!TABLE_HALLOWEEN) return Promise.resolve(null);
  return findOldestClaimableRow(TABLE_HALLOWEEN, username, brand, () => true, undefined, {
    usernameField: F.uid, dateField: F.day1Claimed, ...opts,
  });
}

// Tier text from the P&L table, the same read the lookup does.
export async function readPlayerTier(username, brand, opts = {}) {
  if (!TABLE_PNL) return "";
  const matches = await searchRecords(TABLE_PNL, [
    { field_name: "Username", operator: "is", value: [username] },
    { field_name: "Brand", operator: "is", value: [brand] },
  ], undefined, { fieldNames: ["Tier", "Tittle name"], ...opts });
  if (!matches.length) return "";
  const tierMap = await getFieldOptionMap(TABLE_PNL, "Tier");
  return toDisplay(matches[0].fields.Tier, tierMap);
}
