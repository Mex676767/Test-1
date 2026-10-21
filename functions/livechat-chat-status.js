import { adapt } from "./_lib/adapt.js";
import { LIVECHAT_PATS, LIVECHAT_ACCOUNTS, accountKeyForPat } from "./_lib/livechat.js";

function orderedPats(preferredAccountKey) {
  const preferred = LIVECHAT_ACCOUNTS.find((account) => account.key === preferredAccountKey);
  return preferred ? [preferred.pat, ...LIVECHAT_PATS.filter((pat) => pat !== preferred.pat)] : LIVECHAT_PATS;
}

async function listChatsFor(pat) {
  const res = await fetch("https://api.livechatinc.com/v3.6/agent/action/list_chats", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + pat },
    body: JSON.stringify({ limit: 100, sort_order: "desc" }),
  });
  const data = await res.json();
  if (data && data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  return data;
}

export async function getArchiveForThread(pat, threadId) {
  const res = await fetch("https://api.livechatinc.com/v3.6/agent/action/list_archives", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + pat },
    body: JSON.stringify({ filters: { thread_ids: [String(threadId)] } }),
  });
  const data = await res.json();
  if (data && data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  const match = (data?.chats || []).find(
    (chat) => chat?.thread && String(chat.thread.id) === String(threadId)
  ) || null;
  return { data, match };
}

async function getChatFor(pat, realChatId) {
  const res = await fetch("https://api.livechatinc.com/v3.6/agent/action/get_chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + pat },
    body: JSON.stringify({ chat_id: realChatId }),
  });
  const data = await res.json();
  if (data && data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  return data;
}

function detectTelegram(users) {
  const customer = (users || []).find((u) => u.type === "customer") || {};
  const sessionFields = customer.session_fields || [];
  return sessionFields.some((f) =>
    Object.entries(f).some(([k, v]) => /telegram/i.test(k) && !!v)
  );
}

export async function handler(event) {
  let threadId;
  try {
    if (!LIVECHAT_PATS.length) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, isTelegram: null, isActive: null, notConfigured: true }) };
    }
    const body = JSON.parse(event.body || "{}");
    const pats = orderedPats(typeof body.accountKey === "string" ? body.accountKey : "");
    const wantRaw = !!body.debug;
    threadId = body.chatId;
    if (!threadId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "chatId is required" }) };
    }

    if (body.realChatId) {
      for (const pat of pats) {
        try {
          const data = await getChatFor(pat, body.realChatId);
          if (!data || !data.thread) continue;
          const chatUrl = `https://my.livechatinc.com/chats/${body.realChatId}/${threadId}`;
          return {
            statusCode: 200,
            body: JSON.stringify({
              ok: true,
              isActive: typeof data.thread.active === "boolean" ? data.thread.active : null,
              isTelegram: detectTelegram(data.users),
              chatId: body.realChatId,
              threadId,
              chatUrl,
              accountKey: accountKeyForPat(pat),
              ...(wantRaw ? { raw: { id: data.id, thread: data.thread, users: data.users } } : {}),
            }),
          };
        } catch (_) { }
      }
    }

    let match = null;
    let lastData = null;
    let lastErr = null;
    let totalSearched = 0;
    let matchedPat = "";
    for (const pat of pats) {
      try {
        const data = await listChatsFor(pat);
        lastData = data;
        const chats = data.chats_summary || [];
        totalSearched += chats.length;
        match = chats.find((c) => c.last_thread_summary && String(c.last_thread_summary.id) === String(threadId));
        if (match) { matchedPat = pat; break; }
      } catch (err) {
        lastErr = err;
      }
    }

    if (!match) {
      let archiveData = null;
      for (const pat of pats) {
        try {
          const result = await getArchiveForThread(pat, threadId);
          archiveData = result.data;
          if (!result.match) continue;

          const archive = result.match;
          const archiveThread = archive.thread || {};
          return {
            statusCode: 200,
            body: JSON.stringify({
              ok: true,
              isActive: typeof archiveThread.active === "boolean" ? archiveThread.active : false,
              isTelegram: detectTelegram(archive.users),
              chatId: archive.id,
              threadId,
              chatUrl: `https://my.livechatinc.com/chats/${archive.id}/${threadId}`,
              accountKey: accountKeyForPat(pat),
              lookup: "archive",
              ...(wantRaw ? { raw: { id: archive.id, thread: archiveThread, users: archive.users } } : {}),
            }),
          };
        } catch (err) {
          lastErr = err;
        }
      }

      if (lastErr && !lastData && !archiveData) throw lastErr;
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          isActive: null,
          isTelegram: null,
          notFound: true,
          threadId,
          raw: { found_chats: lastData?.found_chats ?? archiveData?.found_chats ?? null, searched: totalSearched, accountsChecked: LIVECHAT_PATS.length },
        }),
      };
    }

    const realChatId = match.id;
    const thread = match.last_thread_summary || {};
    const chatUrl = `https://my.livechatinc.com/chats/${realChatId}/${threadId}`;

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        isActive: typeof thread.active === "boolean" ? thread.active : null,
        isTelegram: detectTelegram(match.users),
        chatId: realChatId,
        threadId,
        chatUrl,
        accountKey: accountKeyForPat(matchedPat),
        ...(wantRaw || typeof thread.active !== "boolean" ? { raw: { id: match.id, last_thread_summary: thread, users: match.users } } : {}),
      }),
    };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, isTelegram: null, isActive: null, threadId, error: err.message }) };
  }
}

export const onRequest = adapt(handler);
