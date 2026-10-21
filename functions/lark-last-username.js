import { adapt } from "./_lib/adapt.js";
import { searchRecords, toDisplay, TABLE_PNL } from "./_lib/lark.js";

const F = { username: "Username", brand: "Brand", lastLink: "Live Chat link", lastTelegramLink: "Telegram" };

export async function findLastUsername(chatId, brand = "") {
  if (!TABLE_PNL) return null;
  const inBrand = brand ? [{ field_name: F.brand, operator: "is", value: [brand] }] : [];
  const [liveChatMatches, telegramMatches] = await Promise.all([
    searchRecords(TABLE_PNL, [
      ...inBrand,
      { field_name: F.lastLink, operator: "contains", value: [chatId] },
    ], undefined, { maxRows: 1, fieldNames: [F.username, F.lastLink, F.brand] }),
    searchRecords(TABLE_PNL, [
      ...inBrand,
      { field_name: F.lastTelegramLink, operator: "contains", value: [chatId] },
    ], undefined, { maxRows: 1, fieldNames: [F.username, F.lastTelegramLink, F.brand] }).catch(() => []),
  ]);
  const match = liveChatMatches[0] || telegramMatches[0];
  return match ? { username: toDisplay(match.fields[F.username]), brand: toDisplay(match.fields[F.brand]) } : null;
}

export async function handler(event) {
  try {
    const { chatId, brand } = JSON.parse(event.body || "{}");
    if (!chatId || !brand) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "chatId and brand are required" }) };
    }
    if (!TABLE_PNL) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, found: false }) };
    }

    const match = await findLastUsername(chatId, brand);
    if (!match) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, found: false }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, found: true, username: match.username }),
    };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, found: false, error: err.message }) };
  }
}

export const onRequest = adapt(handler);
