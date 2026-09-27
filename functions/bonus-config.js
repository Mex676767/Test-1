import { adapt } from "./_lib/adapt.js";
import { createRecord, updateRecord, TABLE_BONUS_CONFIG } from "./_lib/lark.js";
import {
  clearBonusConfigCache, configToFields, listBonusConfigs, normalizeBonusConfig,
} from "./_lib/bonus-config.js";

const RESERVED_KEYS = new Set([
  "riskplayer", "toppnl", "graceperiod", "ltvtest", "vipbooster", "mooncake", "vs96feedback",
  "telegram28", "redeemcode", "specialreload",
]);

function response(statusCode, body) {
  return { statusCode, body: JSON.stringify(body) };
}

function publicConfig(config) {
  return {
    key: config.key,
    label: config.label,
    inquiry: config.inquiry,
    amountEligible: config.amountEligible,
  };
}

export async function handler(event) {
  try {
    if (!TABLE_BONUS_CONFIG) {
      return response(200, { ok: true, configured: false, configs: [] });
    }

    if (event.httpMethod === "GET") {
      const wantsAll = event.queryStringParameters?.all === "1";
      const configs = await listBonusConfigs({ includeInactive: wantsAll, fresh: wantsAll });
      return response(200, {
        ok: true,
        configured: true,
        configs: wantsAll ? configs : configs.map(publicConfig),
      });
    }

    if (event.httpMethod !== "POST") return response(405, { ok: false, error: "Method not allowed" });

    const config = normalizeBonusConfig(JSON.parse(event.body || "{}"));
    if (RESERVED_KEYS.has(config.key.replace(/[-_]/g, ""))) {
      return response(409, { ok: false, error: `Bonus key "${config.key}" is reserved by a built-in program` });
    }
    const existing = await listBonusConfigs({ includeInactive: true, fresh: true });
    const original = config.recordId ? existing.find((item) => item.recordId === config.recordId) : null;
    if (config.recordId && !original) return response(404, { ok: false, error: "Bonus configuration not found" });
    if (original && original.key !== config.key) {
      return response(409, { ok: false, error: "An existing bonus key cannot be changed" });
    }
    const duplicate = existing.find((item) => item.key === config.key && item.recordId !== config.recordId);
    if (duplicate) return response(409, { ok: false, error: `Bonus key "${config.key}" already exists` });

    const record = config.recordId
      ? await updateRecord(TABLE_BONUS_CONFIG, config.recordId, configToFields(config))
      : await createRecord(TABLE_BONUS_CONFIG, configToFields(config));
    clearBonusConfigCache();
    return response(200, { ok: true, recordId: record.record_id, config: { ...config, recordId: record.record_id } });
  } catch (err) {
    return response(400, { ok: false, error: err.message });
  }
}

export const onRequest = adapt(handler);
