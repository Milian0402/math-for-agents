import { query, transaction } from "./db.js";
import { makeId, stableKeyHash } from "./ids.js";
import { applyVerificationPatch, buildContribution } from "./domain.js";

export async function authenticateAgent(apiKey) {
  const keyHash = stableKeyHash(apiKey);
  if (!keyHash) return null;

  const result = await query(
    `select agents.*, agent_api_keys.id as api_key_id
       from agent_api_keys
       join agents on agents.id = agent_api_keys.agent_id
      where agent_api_keys.key_hash = $1
      limit 1`,
    [keyHash]
  );

  const agent = result.rows[0] || null;
  if (agent) {
    await query("update agent_api_keys set last_used_at = now() where id = $1", [agent.api_key_id]);
  }
  return agent;
}

export async function getWorkspace(workspaceId) {
  const result = await query("select * from workspaces where id = $1", [workspaceId]);
  return result.rows[0] || null;
}

export async function getWorkspaceStore(workspaceId) {
  const [workspace, agents, problems, assignments, claims, verifications, posts, artifacts] = await Promise.all([
    query("select * from workspaces where id = $1", [workspaceId]),
    query("select * from agents where workspace_id = $1 order by reputation desc, name asc", [workspaceId]),
    query("select * from problems where workspace_id = $1 order by updated_at desc nulls last, id asc", [workspaceId]),
    query("select * from assignments where workspace_id = $1 order by created_at desc", [workspaceId]),
    query("select * from claims where workspace_id = $1 order by id asc", [workspaceId]),
    query("select * from verifications where workspace_id = $1 order by created_at desc", [workspaceId]),
    query("select * from posts where workspace_id = $1 order by created_at desc", [workspaceId]),
    query("select * from artifacts where workspace_id = $1 order by created_at desc, id asc", [workspaceId])
  ]);

  return {
    workspace: workspace.rows[0] || {},
    agents: agents.rows,
    problems: problems.rows,
    assignments: assignments.rows,
    claims: claims.rows,
    verifications: verifications.rows,
    posts: posts.rows,
    artifacts: artifacts.rows
  };
}

export async function listAssignmentsForAgent(workspaceId, agentId) {
  const result = await query(
    `select *
       from assignments
      where workspace_id = $1
        and (assigned_agents ? $2 or jsonb_array_length(assigned_agents) = 0)
      order by created_at desc`,
    [workspaceId, agentId]
  );
  return result.rows;
}

export async function listProblems(workspaceId) {
  const result = await query(
    "select * from problems where workspace_id = $1 order by updated_at desc nulls last, id asc",
    [workspaceId]
  );
  return result.rows;
}

export async function listVerificationQueue(workspaceId, assignedAgent = "") {
  const params = [workspaceId];
  let assignedSql = "";
  if (assignedAgent) {
    params.push(assignedAgent);
    assignedSql = ` and assigned_agent = $${params.length}`;
  }

  const result = await query(
    `select verifications.*, claims.statement as claim_statement, claims.problem_id
       from verifications
       join claims on claims.id = verifications.claim_id
      where verifications.workspace_id = $1
        and verifications.status not in ('passed', 'failed')
        ${assignedSql}
      order by
        case verifications.priority when 'high' then 1 when 'medium' then 2 else 3 end,
        verifications.created_at asc`,
    params
  );
  return result.rows;
}

export async function createArtifact(workspaceId, input) {
  const artifact = {
    id: input.id,
    created_at: input.created_at || new Date().toISOString(),
    problem_id: input.problem_id,
    owner: input.owner,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    path: input.path,
    content_hash: input.content_hash || null,
    metadata: input.metadata || {}
  };

  await query(
    `insert into artifacts
      (id, workspace_id, created_at, problem_id, owner, kind, title, summary, path, content_hash, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      artifact.id,
      workspaceId,
      artifact.created_at,
      artifact.problem_id,
      artifact.owner,
      artifact.kind,
      artifact.title,
      artifact.summary,
      artifact.path,
      artifact.content_hash,
      JSON.stringify(artifact.metadata)
    ]
  );
  return artifact;
}

export async function createAssignment(workspaceId, owner, input) {
  const now = new Date().toISOString();
  const assignment = {
    id: makeId("assignment"),
    created_at: now,
    owner,
    problem_id: input.problem_id,
    task: input.task,
    prompt: input.prompt.trim(),
    desired_output: input.desired_output,
    assigned_agents: input.assigned_agents,
    status: input.status || "open"
  };
  const post = {
    id: makeId("post"),
    created_at: now,
    agent: owner,
    problem_id: assignment.problem_id,
    assignment_id: assignment.id,
    type: "question",
    body: assignment.prompt,
    dependencies: [],
    artifacts: [],
    evidence_level: "speculative",
    status: "open"
  };

  await transaction(async (client) => {
    await client.query(
      `insert into assignments
        (id, workspace_id, created_at, owner, problem_id, task, prompt, desired_output, assigned_agents, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        assignment.id,
        workspaceId,
        assignment.created_at,
        assignment.owner,
        assignment.problem_id,
        assignment.task,
        assignment.prompt,
        JSON.stringify(assignment.desired_output),
        JSON.stringify(assignment.assigned_agents),
        assignment.status
      ]
    );
    await insertPost(client, workspaceId, post);
    await client.query(
      `update problems
          set assignment_ids = coalesce(assignment_ids, '[]'::jsonb) || to_jsonb($3::text),
              status = case when status = 'open' then 'active' else status end,
              updated_at = now()
        where workspace_id = $1 and id = $2 and not (coalesce(assignment_ids, '[]'::jsonb) ? $3)`,
      [workspaceId, assignment.problem_id, assignment.id]
    );
  });

  return { assignment, post };
}

export async function createContribution(workspaceId, input) {
  const built = buildContribution(input);

  return transaction(async (client) => {
    if (built.artifact) {
      await insertArtifact(client, workspaceId, built.artifact);
    }
    await insertPost(client, workspaceId, built.post);

    if (built.claim) {
      await insertClaim(client, workspaceId, built.claim);
      await appendClaimToProblem(client, workspaceId, built.claim.problem_id, built.claim.id);
    }
    if (built.verification) {
      await insertVerification(client, workspaceId, built.verification);
    }
    if (built.verificationJob) {
      await insertVerificationJob(client, workspaceId, built.verificationJob);
    }

    if (input.assignment_id) {
      await client.query(
        "update assignments set status = 'needs-human-review' where workspace_id = $1 and id = $2 and status <> 'done'",
        [workspaceId, input.assignment_id]
      );
    }

    await client.query(
      `update problems
          set status = case when status = 'open' then 'active' else status end,
              updated_at = now()
        where workspace_id = $1 and id = $2`,
      [workspaceId, input.problem_id]
    );

    return built;
  });
}

export async function updateVerification(workspaceId, verificationId, patch) {
  return transaction(async (client) => {
    const currentResult = await client.query(
      "select * from verifications where workspace_id = $1 and id = $2",
      [workspaceId, verificationId]
    );
    const current = currentResult.rows[0];
    if (!current) return null;

    const claimVerificationsResult = await client.query(
      "select * from verifications where workspace_id = $1 and claim_id = $2",
      [workspaceId, current.claim_id]
    );
    const { verification, claimPatch } = applyVerificationPatch(current, claimVerificationsResult.rows, patch);

    await client.query(
      `update verifications
          set status = $3,
              method = $4,
              artifact_id = $5,
              notes = $6,
              checklist = $7,
              updated_at = $8
        where workspace_id = $1 and id = $2`,
      [
        workspaceId,
        verification.id,
        verification.status,
        verification.method,
        verification.artifact_id || null,
        verification.notes || "",
        JSON.stringify(verification.checklist || []),
        verification.updated_at
      ]
    );

    await client.query(
      `update claims
          set status = $3,
              trust_tier = $4,
              verification_state = $5
        where workspace_id = $1 and id = $2`,
      [
        workspaceId,
        current.claim_id,
        claimPatch.status,
        claimPatch.trust_tier,
        claimPatch.verification_state
      ]
    );

    if (verification.status === "passed" || verification.status === "failed") {
      await client.query(
        `update verification_jobs
            set status = $3,
                updated_at = now()
          where workspace_id = $1 and verification_id = $2 and status not in ('passed', 'failed')`,
        [workspaceId, verification.id, verification.status]
      );
    }

    return { verification, claimPatch };
  });
}

async function insertArtifact(client, workspaceId, artifact) {
  await client.query(
    `insert into artifacts
      (id, workspace_id, created_at, problem_id, owner, kind, title, summary, path, content_hash, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (id) do nothing`,
    [
      artifact.id,
      workspaceId,
      artifact.created_at,
      artifact.problem_id,
      artifact.owner,
      artifact.kind,
      artifact.title,
      artifact.summary,
      artifact.path,
      artifact.content_hash || null,
      JSON.stringify(artifact.metadata || {})
    ]
  );
}

async function insertPost(client, workspaceId, post) {
  await client.query(
    `insert into posts
      (id, workspace_id, created_at, agent, problem_id, assignment_id, type, body, dependencies, artifacts, evidence_level, status, replay)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      post.id,
      workspaceId,
      post.created_at,
      post.agent,
      post.problem_id,
      post.assignment_id,
      post.type,
      post.body,
      JSON.stringify(post.dependencies || []),
      JSON.stringify(post.artifacts || []),
      post.evidence_level,
      post.status,
      post.replay ? JSON.stringify(post.replay) : null
    ]
  );
}

async function insertClaim(client, workspaceId, claim) {
  await client.query(
    `insert into claims
      (id, workspace_id, problem_id, type, statement, status, evidence_level, trust_tier, verification_state, linked_posts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      claim.id,
      workspaceId,
      claim.problem_id,
      claim.type,
      claim.statement,
      claim.status,
      claim.evidence_level,
      claim.trust_tier,
      claim.verification_state,
      JSON.stringify(claim.linked_posts || [])
    ]
  );
}

async function insertVerification(client, workspaceId, verification) {
  await client.query(
    `insert into verifications
      (id, workspace_id, claim_id, assigned_agent, method, priority, status, notes, artifact_id, checklist)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      verification.id,
      workspaceId,
      verification.claim_id,
      verification.assigned_agent,
      verification.method,
      verification.priority,
      verification.status,
      verification.notes || "",
      verification.artifact_id || null,
      JSON.stringify(verification.checklist || [])
    ]
  );
}

async function insertVerificationJob(client, workspaceId, job) {
  await client.query(
    `insert into verification_jobs
      (id, workspace_id, verification_id, kind, status, payload)
     values ($1,$2,$3,$4,$5,$6)`,
    [job.id, workspaceId, job.verification_id, job.kind, job.status, JSON.stringify(job.payload || {})]
  );
}

async function appendClaimToProblem(client, workspaceId, problemId, claimId) {
  await client.query(
    `update problems
        set claim_ids = coalesce(claim_ids, '[]'::jsonb) || to_jsonb($3::text),
            updated_at = now()
      where workspace_id = $1 and id = $2 and not (coalesce(claim_ids, '[]'::jsonb) ? $3)`,
    [workspaceId, problemId, claimId]
  );
}
