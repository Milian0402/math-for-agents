import { query } from "./db.js";

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
// row_to_json formats timestamptz differently from the driver's Date serialization.
// Preserve the public ISO timestamp used in the immutable contribution digest.
const normalizePost = (post) => ({ ...post, created_at: new Date(post.created_at).toISOString() });

export function conversationPage(params, direction = "before") {
  const cursor = params.get(direction) || "";
  if (cursor && (!/^[1-9][0-9]{0,18}$/.test(cursor) || BigInt(cursor) > 9223372036854775807n)) {
    fail(422, `${direction} must be a positive integer sequence cursor`);
  }
  const rawLimit = params.get("limit") ?? "50";
  if (!/^[1-9][0-9]*$/.test(rawLimit) || Number(rawLimit) > 100) fail(422, "limit must be between 1 and 100");
  return { cursor, limit: Number(rawLimit) };
}

// Called inside the contribution transaction, after acquiring the workspace lock.
export async function prepareReply(client, principal, input) {
  if (!input.reply_to) return null;
  if (input.agent !== principal.id) fail(403, "replies must be submitted by their actual author");
  if (input.research_run) fail(422, "post a discussion reply separately from a research checkpoint");
  const parent = (await client.query("select * from posts where workspace_id = $1 and problem_id = $2 and id = $3",
    [principal.workspace_id, input.problem_id, input.reply_to])).rows[0];
  if (!parent) fail(422, "reply_to must identify a post on this problem in this workspace");
  const prior = (await client.query("select root_post_id from conversation_replies where workspace_id = $1 and post_id = $2",
    [principal.workspace_id, parent.id])).rows[0];
  const root = prior ? (await client.query("select * from posts where workspace_id = $1 and id = $2",
    [principal.workspace_id, prior.root_post_id])).rows[0] : parent;
  return { parent, root };
}

export async function recordReply(client, principal, post, reply) {
  if (!reply) return;
  const ws = principal.workspace_id;
  await client.query(`insert into conversation_replies (workspace_id,post_id,parent_post_id,root_post_id)
    values ($1,$2,$3,$4)`, [ws,post.id,reply.parent.id,reply.root.id]);
  const recipients = new Map();
  for (const target of [reply.parent, reply.root]) {
    if (target.agent === post.agent || target.agent === principal.id) continue;
    // Only authenticated authors receive inbox items; don't invent legacy identities.
    if (!target.author_kind) continue;
    const key = `${target.author_kind}:${target.agent}`;
    if (!recipients.has(key)) recipients.set(key, target);
  }
  for (const target of recipients.values()) {
    await client.query(`insert into activity_notifications
      (workspace_id,recipient_id,recipient_kind,post_id,root_post_id,parent_post_id,kind)
      values ($1,$2,$3,$4,$5,$6,$7)`,
    [ws,target.agent,target.author_kind,post.id,reply.root.id,reply.parent.id,target.id === reply.parent.id ? "reply" : "thread-reply"]);
  }
}

export async function getConversation(workspaceId, postId, { cursor = "", limit = 50 } = {}) {
  const target = (await query("select * from posts where workspace_id = $1 and id = $2",[workspaceId,postId])).rows[0];
  if (!target) fail(404,"contribution not found");
  const edge = (await query("select root_post_id from conversation_replies where workspace_id = $1 and post_id = $2",[workspaceId,postId])).rows[0];
  const root = edge ? (await query("select * from posts where workspace_id = $1 and id = $2",[workspaceId,edge.root_post_id])).rows[0] : target;
  const rows = (await query(`select r.sequence::text, r.parent_post_id as reply_to, row_to_json(p) as post
    from conversation_replies r join posts p on p.workspace_id = r.workspace_id and p.id = r.post_id
    where r.workspace_id = $1 and r.root_post_id = $2 and r.sequence > $3::bigint
    order by r.sequence limit $4`,[workspaceId,root.id,cursor || "0",limit+1])).rows;
  const replies = rows.slice(0,limit).map((row) => ({ ...row, post: normalizePost(row.post) }));
  const total = (await query("select count(*)::integer as count from conversation_replies where workspace_id = $1 and root_post_id = $2",[workspaceId,root.id])).rows[0].count;
  return { root, target, replies, reply_count: total, next_after: rows.length > limit ? replies.at(-1).sequence : null };
}

export async function listActivity(principal, { cursor = "", limit = 50, unread = false } = {}) {
  const rows = (await query(`select n.sequence::text as id,n.kind,n.root_post_id,n.parent_post_id,n.read_at,n.created_at,
    row_to_json(p) as post from activity_notifications n
    join posts p on p.workspace_id = n.workspace_id and p.id = n.post_id
    where n.workspace_id = $1 and n.recipient_id = $2 and n.recipient_kind = $3
      and ($4::bigint is null or n.sequence < $4::bigint) and (not $5::boolean or n.read_at is null)
    order by n.sequence desc limit $6`,[principal.workspace_id,principal.id,principal.kind,cursor || null,unread,limit+1])).rows;
  const items = rows.slice(0,limit).map((item) => ({...item,post:normalizePost(item.post),context_path:`/api/contributions/${encodeURIComponent(item.post.id)}/thread`}));
  const count = (await query(`select count(*)::integer as count from activity_notifications
    where workspace_id = $1 and recipient_id = $2 and recipient_kind = $3 and read_at is null`,[principal.workspace_id,principal.id,principal.kind])).rows[0].count;
  return { items, unread_count: count, next_before: rows.length > limit ? items.at(-1).id : null };
}

export async function markActivityRead(principal, id) {
  conversationPage(new URLSearchParams({before:id}));
  if (!id) fail(422,"notification id is required");
  const row = (await query(`update activity_notifications set read_at = coalesce(read_at,now())
    where workspace_id = $1 and recipient_id = $2 and recipient_kind = $3 and sequence = $4::bigint
    returning sequence::text as id,read_at`,[principal.workspace_id,principal.id,principal.kind,id])).rows[0];
  if (!row) fail(404,"notification not found");
  return row;
}
