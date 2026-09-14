import { query, transaction } from "./db.js";
import { makeId } from "./ids.js";
import { researchHash } from "./research.js";

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };

function text(value, name, max = 10000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail(422, `${name} is required (at most ${max} characters)`);
  return value.trim();
}
function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > 1000000000) fail(422, `${name} must be an integer between ${minimum} and 1000000000`);
  return value;
}
function fields(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(422, "expected an object");
  for (const key of Object.keys(input)) if (!allowed.includes(key)) fail(422, `unknown field: ${key}`);
}
async function postInWorkspace(client, workspaceId, id, problemId) {
  const post = (await client.query("select * from posts where workspace_id = $1 and id = $2", [workspaceId, id])).rows[0];
  if (!post || (problemId && post.problem_id !== problemId)) fail(422, "checkpoint must belong to this problem and workspace");
  if (!post.content_hash) fail(422, "checkpoint needs a versioned contribution; import legacy work as a new attributed contribution first");
  return post;
}

async function assertNoOtherArm(client, workspaceId, candidateIds, pilotId, runId) {
  if (!candidateIds.length) return;
  const contaminated = (await client.query(`with recursive ancestors(id) as (
    select unnest($2::text[]) union select e.parent_post_id from contribution_edges e join ancestors a on e.post_id = a.id where e.workspace_id = $1
  ) select c.post_id from research_checkpoints c join research_runs r on r.id = c.run_id
    where c.workspace_id = $1 and c.post_id in (select id from ancestors) and r.pilot_id = $3 and r.id <> $4 limit 1`,
  [workspaceId,candidateIds,pilotId,runId])).rows[0];
  if (contaminated) fail(422,"cannot use the other comparison arm's checkpoints, including through dependencies");
}
export async function getResearchRun(workspaceId, id, client = { query }) {
  const run = (await client.query("select * from research_runs where workspace_id = $1 and id = $2", [workspaceId, id])).rows[0];
  if (!run) fail(404, "research run not found");
  return run;
}

export async function createResearchPilot(principal, input) {
  fields(input, ["source_post_id", "goal", "model", "budget_tokens", "paired", "idempotency_key"]);
  const sourceId = text(input.source_post_id, "source_post_id", 200);
  const goal = text(input.goal, "goal");
  const model = text(input.model, "model and version", 200);
  const budget = integer(input.budget_tokens, "budget_tokens", 1);
  const requestKey = text(input.idempotency_key, "idempotency_key", 200);
  if (input.paired !== undefined && typeof input.paired !== "boolean") fail(422, "paired must be boolean");
  const requestHash = researchHash(input);
  return transaction(async (client) => {
    await client.query("select id from workspaces where id = $1 for update", [principal.workspace_id]);
    const prior = (await client.query("select * from research_pilots where workspace_id = $1 and created_by = $2 and idempotency_key = $3", [principal.workspace_id, principal.id, requestKey])).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) fail(409, "idempotency_key was used for another pilot");
      return pilotWithRuns(client, principal.workspace_id, prior);
    }
    const source = await postInWorkspace(client, principal.workspace_id, sourceId);
    const pilot = { id: makeId("pilot"), workspace_id: principal.workspace_id, problem_id: source.problem_id,
      created_by: principal.id, goal, goal_hash: researchHash({ goal, problem_id: source.problem_id }),
      model, budget_tokens: budget, source_post_id: source.id, source_hash: source.content_hash, paired: input.paired === true };
    await client.query(`insert into research_pilots
      (id,workspace_id,problem_id,created_by,goal,goal_hash,model,budget_tokens,source_post_id,source_hash,paired,idempotency_key,request_hash)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [pilot.id,pilot.workspace_id,pilot.problem_id,pilot.created_by,goal,pilot.goal_hash,model,budget,source.id,source.content_hash,pilot.paired,requestKey,requestHash]);
    for (const mode of pilot.paired ? ["independent", "shared"] : ["shared"]) {
      await client.query(`insert into research_runs (id,workspace_id,pilot_id,mode,checkpoint_post_id,status)
        values ($1,$2,$3,$4,$5,'paused')`, [makeId("run"),principal.workspace_id,pilot.id,mode,source.id]);
    }
    return pilotWithRuns(client, principal.workspace_id, pilot);
  });
}

async function pilotWithRuns(client, workspaceId, pilot) {
  const runs = (await client.query("select * from research_runs where workspace_id = $1 and pilot_id = $2 order by mode", [workspaceId, pilot.id])).rows;
  return { pilot, runs };
}

export async function listResearchPilots(workspaceId, before = "") {
  if (before && !/^\d{1,18}$/.test(before)) fail(422, "before must be a sequence cursor");
  const pilots = (await query(`select * from research_pilots where workspace_id = $1
    and (nullif($2,'') is null or sequence < nullif($2,'')::bigint) order by sequence desc limit 50`, [workspaceId,before])).rows;
  return { pilots: await Promise.all(pilots.map((pilot) => pilotWithRuns({ query },workspaceId,{ ...pilot, sequence: String(pilot.sequence) }))),
    next_before: pilots.length === 50 ? String(pilots.at(-1).sequence) : null };
}

export async function transitionResearchRun(principal, id, input) {
  fields(input, ["action", "expected_checkpoint_id"]);
  if (!["resume", "pause"].includes(input.action)) fail(422, "action must be resume or pause");
  text(input.expected_checkpoint_id,"expected_checkpoint_id",200);
  return transaction(async (client) => {
    await client.query("select id from research_runs where workspace_id = $1 and id = $2 for update", [principal.workspace_id,id]);
    const run = await getResearchRun(principal.workspace_id,id,client);
    if (run.checkpoint_post_id !== input.expected_checkpoint_id) fail(409,"checkpoint changed; reload the run before continuing");
    if (input.action === "resume") {
      if (run.status === "running" && run.holder_id === principal.id) return { run };
      if (run.status !== "paused") fail(409,"only a paused run can be resumed");
    } else if (run.status !== "running" || run.holder_id !== principal.id) {
      fail(403,"only the current researcher can pause this run");
    }
    const updated = (await client.query(`update research_runs set status = $3, holder_id = $4, updated_at = now()
      where workspace_id = $1 and id = $2 returning *`, [principal.workspace_id,id,input.action === "resume" ? "running" : "paused",input.action === "resume" ? principal.id : null])).rows[0];
    await client.query("insert into research_run_events (workspace_id,run_id,actor_id,action,checkpoint_post_id) values ($1,$2,$3,$4,$5)",
      [principal.workspace_id,id,principal.id,input.action,run.checkpoint_post_id]);
    return { run: updated };
  });
}

// Called inside the contribution transaction. No checkpoints, budgets or
// attribution are committed unless the new contribution itself commits.
export async function prepareResearchCheckpoint(client, principal, input, built) {
  if (input.research_run === undefined) return null;
  fields(input.research_run,["id","expected_checkpoint_id","status","tokens_used"]);
  const spec = input.research_run;
  text(spec.id,"research_run.id",200);
  text(spec.expected_checkpoint_id,"expected_checkpoint_id",200);
  if (!["running","paused","completed"].includes(spec.status)) fail(422,"checkpoint status must be running, paused or completed");
  const tokens = integer(spec.tokens_used,"tokens_used");
  if (tokens > 0) {
    if (!input.inference || !Number.isSafeInteger(input.inference.input_tokens) || !Number.isSafeInteger(input.inference.output_tokens)
      || input.inference.input_tokens + input.inference.output_tokens !== tokens) fail(422,"token usage must match the attached inference report's input plus output tokens");
  } else if (principal.kind === "agent" || input.inference) {
    fail(422,"agent checkpoints require positive, reported inference token usage");
  }
  if (input.agent !== principal.id) fail(403,"research checkpoints must be submitted by their actual author");
  await client.query("select id from research_runs where workspace_id = $1 and id = $2 for update", [principal.workspace_id,spec.id]);
  const run = await getResearchRun(principal.workspace_id,spec.id,client);
  const pilot = (await client.query("select * from research_pilots where workspace_id = $1 and id = $2", [principal.workspace_id,run.pilot_id])).rows[0];
  if (pilot.problem_id !== input.problem_id) fail(422,"run belongs to another problem");
  if (run.status !== "running" || run.holder_id !== principal.id) fail(403,"resume this run before contributing a checkpoint");
  if (run.checkpoint_post_id !== spec.expected_checkpoint_id) fail(409,"stale checkpoint; reload and resume from the latest contribution");
  if (input.inference && input.inference.model !== pilot.model) fail(422,"inference model must match the pilot's frozen model and version");
  if (run.tokens_used + tokens > pilot.budget_tokens) fail(422,"reported token budget exceeded");
  if (!input.progress?.changes?.trim() || !input.progress?.next_steps?.trim()) fail(422,"checkpoints require progress.changes and progress.next_steps (including a stopping explanation)");
  if (spec.status === "completed" && input.claim_statement?.trim() !== pilot.goal) fail(422,"a completed attempt must state the pilot's exact goal; completion does not imply proof");
  const previous = await postInWorkspace(client,principal.workspace_id,run.checkpoint_post_id,pilot.problem_id);
  const contextRows = (await client.query("select post_id from research_run_context where workspace_id = $1 and run_id = $2", [principal.workspace_id,run.id])).rows;
  const candidateIds = [...built.post.dependencies,input.revision_of,...contextRows.map((row) => row.post_id)].filter(Boolean);
  await assertNoOtherArm(client,principal.workspace_id,candidateIds,pilot.id,run.id);
  if (run.mode === "independent") {
    const own = (await client.query("select post_id from research_checkpoints where workspace_id = $1 and run_id = $2",[principal.workspace_id,run.id])).rows;
    const allowed = new Set([pilot.source_post_id,...own.map((row) => row.post_id)]);
    if ([...built.post.dependencies,input.revision_of].filter(Boolean).some((id) => !allowed.has(id))) fail(422,"independent runs may cite only their initial contribution and own checkpoints");
  }
  built.post.dependencies = [...new Set([...built.post.dependencies,previous.id,...contextRows.map((row) => row.post_id)])];
  if (built.post.dependencies.length > 50) fail(422,"checkpoint has too many dependencies");
  built.researchRun = { id: run.id, pilot_id: pilot.id, goal_hash: pilot.goal_hash, previous_post_id: previous.id,
    previous_hash: previous.content_hash, model: pilot.model, mode: run.mode };
  return { run, spec, tokens, budget: pilot.budget_tokens };
}

export async function finishResearchCheckpoint(client, principal, checkpoint, post) {
  if (!checkpoint) return;
  const { run, spec, tokens, budget } = checkpoint;
  const total = run.tokens_used + tokens;
  const status = spec.status === "completed" ? "completed" : total === budget ? "exhausted" : spec.status;
  await client.query(`insert into research_checkpoints (workspace_id,run_id,post_id,post_hash,author_id,tokens_used)
    values ($1,$2,$3,$4,$5,$6)`, [principal.workspace_id,run.id,post.id,post.content_hash,principal.id,tokens]);
  await client.query(`update research_runs set checkpoint_post_id = $3, tokens_used = $4, status = $5,
    holder_id = $6, updated_at = now() where workspace_id = $1 and id = $2`,
  [principal.workspace_id,run.id,post.id,total,status,status === "running" ? principal.id : null]);
}

export async function addResearchContext(principal,id,input) {
  fields(input,["post_id","expected_checkpoint_id"]);
  text(input.post_id,"post_id",200);
  return transaction(async (client) => {
    await client.query("select id from research_runs where workspace_id = $1 and id = $2 for update",[principal.workspace_id,id]);
    const run = await getResearchRun(principal.workspace_id,id,client);
    if (run.mode !== "shared") fail(422,"independent runs cannot import shared context");
    if (run.status !== "running" || run.holder_id !== principal.id) fail(403,"only the active researcher can add context");
    if (run.checkpoint_post_id !== input.expected_checkpoint_id) fail(409,"checkpoint changed");
    const pilot = (await client.query("select * from research_pilots where id = $1 and workspace_id = $2",[run.pilot_id,principal.workspace_id])).rows[0];
    const post = await postInWorkspace(client,principal.workspace_id,input.post_id,pilot.problem_id);
    // The two experiment arms must never feed answers to each other.
    await assertNoOtherArm(client,principal.workspace_id,[post.id],pilot.id,run.id);
    const count = (await client.query("select count(*)::integer as count from research_run_context where workspace_id = $1 and run_id = $2",[principal.workspace_id,id])).rows[0].count;
    if (count >= 40) fail(422,"at most 40 shared context contributions per run");
    await client.query(`insert into research_run_context (workspace_id,run_id,post_id,post_hash,added_by)
      values ($1,$2,$3,$4,$5) on conflict do nothing`,[principal.workspace_id,id,post.id,post.content_hash,principal.id]);
    return { post_id: post.id, content_hash: post.content_hash };
  });
}

export async function researchRunContext(workspaceId,id) {
  const run = await getResearchRun(workspaceId,id);
  const pilot = (await query("select * from research_pilots where workspace_id = $1 and id = $2",[workspaceId,run.pilot_id])).rows[0];
  const checkpoints = (await query("select * from research_checkpoints where workspace_id = $1 and run_id = $2 order by sequence",[workspaceId,id])).rows;
  const shared = (await query("select * from research_run_context where workspace_id = $1 and run_id = $2 order by created_at,post_id",[workspaceId,id])).rows;
  const ids = [pilot.source_post_id,...checkpoints.map((c) => c.post_id),...shared.map((c) => c.post_id)];
  const posts = (await query("select * from posts where workspace_id = $1 and id = any($2::text[]) order by created_at,id",[workspaceId,ids])).rows;
  const artifactIds = [...new Set(posts.flatMap((post) => post.artifacts || []))];
  const artifacts = artifactIds.length ? (await query("select * from artifacts where workspace_id = $1 and id = any($2::text[])",[workspaceId,artifactIds])).rows : [];
  const audits = (await query("select * from research_audits where workspace_id = $1 and run_id = $2 order by sequence",[workspaceId,id])).rows;
  const events = (await query("select * from research_run_events where workspace_id = $1 and run_id = $2 order by sequence",[workspaceId,id])).rows;
  return { run,pilot,checkpoints,posts,artifacts,audits,events,remaining_reported_tokens: pilot.budget_tokens-run.tokens_used,
    next_step: posts.find((post) => post.id === run.checkpoint_post_id)?.progress?.next_steps || "Read the starting contribution and choose the next step.",
    evidence_notice: "Context package, not an access sandbox. Token usage is self-reported. A completed run is an attempt, not a proved theorem." };
}

export async function auditResearchRun(principal,id,input) {
  fields(input,["goal_hash","checkpoint_hash","verdict","notes"]);
  if (principal.kind !== "human" || !["owner","admin","reviewer"].includes(principal.role)) fail(403,"an authorized human reviewer is required");
  if (!["supported","needs-work","refuted"].includes(input.verdict)) fail(422,"invalid review verdict");
  const notes = text(input.notes,"review explanation");
  return transaction(async (client) => {
    await client.query("select id from research_runs where workspace_id = $1 and id = $2 for update",[principal.workspace_id,id]);
    const run = await getResearchRun(principal.workspace_id,id,client);
    if (run.status !== "completed") fail(422,"finish the attempt before requesting a result review");
    const pilot = (await client.query("select * from research_pilots where workspace_id = $1 and id = $2",[principal.workspace_id,run.pilot_id])).rows[0];
    const checkpoint = await postInWorkspace(client,principal.workspace_id,run.checkpoint_post_id,pilot.problem_id);
    if (input.goal_hash !== pilot.goal_hash || input.checkpoint_hash !== checkpoint.content_hash) fail(409,"review does not match the exact goal and final checkpoint");
    const contributors = (await client.query(`with recursive used_posts(id) as (
      select unnest(array[$2::text,$3::text]) union
      select e.parent_post_id from contribution_edges e join used_posts u on e.post_id = u.id where e.workspace_id = $1
    ) select p.agent,p.submitted_by from posts p where p.workspace_id = $1 and p.id in (select id from used_posts)`,
    [principal.workspace_id,pilot.source_post_id,run.checkpoint_post_id])).rows;
    if (contributors.some((p) => [p.agent,p.submitted_by].includes(principal.id))) fail(403,"reviewer must be independent of the run's recorded contributors");
    const audit = (await client.query(`insert into research_audits (workspace_id,run_id,reviewer_id,goal_hash,checkpoint_hash,verdict,notes)
      values ($1,$2,$3,$4,$5,$6,$7) returning *`,[principal.workspace_id,id,principal.id,input.goal_hash,input.checkpoint_hash,input.verdict,notes])).rows[0];
    return { audit, evidence_status: "human-review", formal_proof: false };
  });
}

export async function researchPilotReport(workspaceId,id) {
  const pilot = (await query("select * from research_pilots where workspace_id = $1 and id = $2",[workspaceId,id])).rows[0];
  if (!pilot) fail(404,"research pilot not found");
  const { runs } = await pilotWithRuns({ query },workspaceId,pilot);
  const rows = [];
  for (const run of runs) {
    const context = await researchRunContext(workspaceId,run.id);
    const latest = new Map();
    for (const audit of context.audits) if (audit.checkpoint_hash === context.posts.find((p) => p.id === run.checkpoint_post_id)?.content_hash && audit.goal_hash === pilot.goal_hash) latest.set(audit.reviewer_id,audit);
    const verdicts = [...latest.values()].map((a) => a.verdict);
    const reviewStatus = !verdicts.length ? "unreviewed" : new Set(verdicts).size > 1 ? "disputed" : verdicts[0];
    rows.push({ run_id:run.id,mode:run.mode,status:run.status,budget_tokens:pilot.budget_tokens,reported_tokens:run.tokens_used,
      checkpoints:context.checkpoints.length,review_status:reviewStatus,independent_reviewers:latest.size,
      shared_context_count:context.posts.length-context.checkpoints.length-1,
      human_checkpoints:context.checkpoints.filter((c) => c.tokens_used === 0).length });
  }
  return { pilot, runs:rows, comparison_ready:pilot.paired && rows.every((row) => row.status === "completed" && ["supported","needs-work","refuted"].includes(row.review_status)),
    evidence_status:"observational-pilot", formal_proofs_certified:0,
    limitations:["Equal frozen model and token allowances, but usage is self-reported, not provider-metered.",
      "Shared workspace access does not prevent outside-context leakage or unreported work.",
      "Human reviews are attributable judgments, not kernel certificates. Human work is not measured by token counts.",
      "A single paired attempt does not establish a general improvement. Repeat with isolated workers and independently metered inference before drawing causal conclusions."] };
}
