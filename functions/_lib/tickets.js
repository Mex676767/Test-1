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

// A hung ticket service must not hang the function. JSON calls get 15 s; multipart (attachment uploads) 30 s.
// A caller-provided signal is still honoured alongside the deadline.
const TICKET_TIMEOUT_MS = 15_000;
const TICKET_UPLOAD_TIMEOUT_MS = 30_000;

export async function ticketRequest(env, path, options = {}) {
  const { apiKey, baseUrl } = config(env);
  if (!apiKey) throw new Error("Ticket API key is not configured");
  const isMultipart = typeof FormData !== "undefined" && options.body instanceof FormData;
  const { timeoutMs, signal: callerSignal, ...fetchOptions } = options;
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : (isMultipart ? TICKET_UPLOAD_TIMEOUT_MS : TICKET_TIMEOUT_MS);
  const deadline = AbortSignal.timeout(limit);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;

  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...fetchOptions,
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(options.body && !isMultipart ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    if (deadline.aborted && !callerSignal?.aborted) {
      const timedOut = new Error(`Ticket service did not answer within ${Math.round(limit / 1000)} seconds`);
      timedOut.statusCode = 504;
      throw timedOut;
    }
    throw error;
  }

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

// One comment as the API returns it, cut down to what the widget shows (authors never include an email).
// A deleted comment that kept its place has body null; replies are one level deep.
export function cleanComment(comment, { withReplies = true } = {}) {
  const clean = {
    id: comment.id,
    author: comment.author ? { id: comment.author.id, name: comment.author.name } : null,
    body: comment.body === null || comment.body === undefined ? null : String(comment.body),
    mentions: Array.isArray(comment.mentions) ? comment.mentions.map(({ userId, name }) => ({ userId, name })) : [],
    createdAt: comment.createdAt || null,
    deleted: Boolean(comment.deleted),
    attachments: Array.isArray(comment.attachments)
      ? comment.attachments.map(({ path, originalName, mimeType, sizeBytes }) => ({ path, originalName, mimeType, sizeBytes }))
      : [],
  };
  if (withReplies) {
    clean.replies = Array.isArray(comment.replies)
      ? comment.replies.map((reply) => cleanComment(reply, { withReplies: false }))
      : [];
  }
  return clean;
}

export function json(statusCode, body) {
  return { statusCode, body: JSON.stringify(body) };
}

export function ticketError(err) {
  const status = Number(err.statusCode);
  return json(status >= 400 && status < 600 ? status : 500, { ok: false, error: err.message });
}
