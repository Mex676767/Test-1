const DEFAULT_BASE_URL = "https://tickets.96ghq.com/api/v1";

function config(env = {}) {
  const apiKey = String(env.TICKETS_API_KEY || "").trim();
  const baseUrl = String(env.TICKETS_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  return { apiKey, baseUrl };
}

export function ticketSettings(env = {}) {
  const { apiKey } = config(env);
  const departmentId = Number(env.TICKETS_TO_DEPARTMENT_ID);
  const marketId = env.TICKETS_MARKET_ID === undefined || env.TICKETS_MARKET_ID === ""
    ? null
    : Number(env.TICKETS_MARKET_ID);

  return {
    configured: Boolean(apiKey),
    departmentId: Number.isInteger(departmentId) && departmentId > 0 ? departmentId : null,
    marketId: Number.isInteger(marketId) && marketId > 0 ? marketId : null,
  };
}

export async function ticketRequest(env, path, options = {}) {
  const { apiKey, baseUrl } = config(env);
  if (!apiKey) throw new Error("Ticket API key is not configured");

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });

  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error(`Ticket service returned HTTP ${response.status}`);
  }

  if (!response.ok || !data.ok) {
    const error = new Error(data.error || `Ticket service returned HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

export function json(statusCode, body) {
  return { statusCode, body: JSON.stringify(body) };
}

export function ticketError(err) {
  const status = Number(err.statusCode);
  return json(status >= 400 && status < 500 ? status : 500, { ok: false, error: err.message });
}
