import { adapt } from "./_lib/adapt.js";
import { personalFailure, ticketAccess } from "./_lib/ticket-connection.js";
import { cleanComment, json, ticketError, ticketRequest } from "./_lib/tickets.js";

export async function handler(event) {
  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed" });
  const ref = String(event.queryStringParameters?.ref || "").trim().toUpperCase();
  if (!/^TK\d{10}$/.test(ref)) {
    return json(400, { ok: false, error: "Enter a ticket reference such as TK2609210007" });
  }

  try {
    const access = await ticketAccess(event);
    if (access.failure) return access.failure;
    let data;
    try {
      data = await ticketRequest(access.env, `/tickets/${encodeURIComponent(ref)}`);
    } catch (err) {
      const failure = personalFailure(access, err);
      if (failure) return failure;
      throw err;
    }
    // The current API wraps a single record as { ticket, fields }, where
    // top-level fields is the field catalog. Older deployments returned the
    // ticket directly. Support both shapes and never mistake the catalog
    // array for the ticket's field-value object.
    const record = data.ticket || data.record || data;
    const recordFields = record.fields && !Array.isArray(record.fields) ? record.fields : {};
    return json(200, {
      ok: true,
      ticket: {
        ref: record.ref,
        fields: recordFields,
        currentDepartment: record.currentDepartment || null,
        raisedByDepartment: record.raisedByDepartment || null,
        market: record.market || null,
        raisedBy: record.raisedBy ? { id: record.raisedBy.id, name: record.raisedBy.name, email: record.raisedBy.email } : null,
        assignees: Array.isArray(record.assignees)
          ? record.assignees.map(({ id, name, email }) => ({ id, name, email }))
          : [],
        createdAt: record.createdAt || null,
        updatedAt: record.updatedAt || null,
        commentCount: Number(record.commentCount || 0),
        attachmentCount: Number(record.attachmentCount || 0),
        comments: Array.isArray(record.comments) ? record.comments.map((comment) => cleanComment(comment)) : [],
      },
    });
  } catch (err) {
    return ticketError(err);
  }
}

export const onRequest = adapt(handler);
