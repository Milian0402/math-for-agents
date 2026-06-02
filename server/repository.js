import { query, transaction } from "./db.js";
import { generateSessionToken, verifyPassword } from "./auth.js";
import { generateAgentApiKey, makeId, stableKeyHash } from "./ids.js";
import { applyVerificationPatch, buildContribution } from "./domain.js";

export async function authenticateAgent(apiKey) {
  const keyHash = stableKeyHash(apiKey);
  if (!keyHash) return null;

  const result = await query(
    `select agents.*, agent_api_keys.id as api_key_id
      from agent_api_keys
      join agents on agents.id = agent_api_keys.agent_id
      where agent_api_keys.key_hash = $1
        and agents.status <> 'disabled'
      limit 1`,
    [keyHash]
  );

  const agent = result.rows[0] || null;
  if (agent) {
    await query("update agent_api_keys set last_used_at = now() where id = $1", [agent.api_key_id]);
  }
  return agent;
}

export async function authenticateHumanSession(sessionToken) {
  const sessionHash = stableKeyHash(sessionToken);
  if (!sessionHash) return null;

  const result = await query(
    `select human_users.id,
            human_users.email,
            human_users.name,
            workspace_members.workspace_id,
            workspace_members.role,
            human_sessions.id as session_id,
            human_sessions.expires_at
       from human_sessions
       join human_users on human_users.id = human_sessions.human_id
       join workspace_members on workspace_members.human_id = human_users.id
      where human_sessions.session_hash = $1
        and human_sessions.expires_at > now()
      order by workspace_members.created_at asc
      limit 1`,
    [sessionHash]
  );

  const human = result.rows[0] || null;
  if (human) {
    await query("update human_sessions set last_used_at = now() where id = $1", [human.session_id]);
  }
  return human;
}

export async function loginHuman(email, password) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const result = await query("select * from human_users where email = $1 limit 1", [normalizedEmail]);
  const human = result.rows[0] || null;
  if (!human || !verifyPassword(password, human.password_hash)) return null;

  const membershipResult = await query(
    `select workspace_id, role
       from workspace_members
      where human_id = $1
      order by created_at asc
      limit 1`,
    [human.id]
  );
  const membership = membershipResult.rows[0] || null;
  if (!membership) return null;

  const sessionToken = generateSessionToken();
  const sessionDays = Number(process.env.MFA_SESSION_DAYS || 14);
  const expiresAt = new Date(Date.now() + Math.max(1, sessionDays) * 24 * 60 * 60 * 1000);
  await query(
    `insert into human_sessions (id, human_id, session_hash, expires_at)
     values ($1,$2,$3,$4)`,
    [makeId("session"), human.id, stableKeyHash(sessionToken), expiresAt.toISOString()]
  );

  return {
    sessionToken,
    expiresAt,
    principal: {
      kind: "human",
      id: human.id,
      email: human.email,
      name: human.name,
      workspace_id: membership.workspace_id,
      role: membership.role,
      auth_method: "human-session"
    }
  };
}

export async function revokeHumanSession(sessionToken) {
  const sessionHash = stableKeyHash(sessionToken);
  if (!sessionHash) return false;
  const result = await query("delete from human_sessions where session_hash = $1", [sessionHash]);
  return result.rowCount > 0;
}

export async function getWorkspace(workspaceId) {
  const result = await query("select * from workspaces where id = $1", [workspaceId]);
  return result.rows[0] || null;
}

export async function getWorkspacePrincipal(workspaceId, principalId) {
  const result = await query(
    `select id, 'agent' as kind
       from agents
      where workspace_id = $1
        and id = $2
      union all
     select human_users.id, 'human' as kind
       from human_users
       join workspace_members on workspace_members.human_id = human_users.id
      where workspace_members.workspace_id = $1
        and human_users.id = $2
      limit 1`,
    [workspaceId, principalId]
  );
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

export async function listAgents(workspaceId) {
  const result = await query(
    "select * from agents where workspace_id = $1 order by reputation desc, name asc",
    [workspaceId]
  );
  return result.rows;
}

export async function getAgent(workspaceId, agentId) {
  const result = await query("select * from agents where workspace_id = $1 and id = $2", [workspaceId, agentId]);
  return result.rows[0] || null;
}

export async function findMissingAgentIds(workspaceId, agentIds) {
  const uniqueIds = [...new Set((agentIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!uniqueIds.length) return [];

  const result = await query(
    "select id from agents where workspace_id = $1 and id = any($2::text[])",
    [workspaceId, uniqueIds]
  );
  const found = new Set(result.rows.map((row) => row.id));
  return uniqueIds.filter((id) => !found.has(id));
}

export async function findMissingProblemPostIds(workspaceId, problemId, postIds) {
  const uniqueIds = [...new Set((postIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!uniqueIds.length) return [];

  const result = await query(
    `select id
       from posts
      where workspace_id = $1
        and problem_id = $2
        and id = any($3::text[])`,
    [workspaceId, problemId, uniqueIds]
  );
  const found = new Set(result.rows.map((row) => row.id));
  return uniqueIds.filter((id) => !found.has(id));
}

export async function listContributions(workspaceId, filters = {}) {
  const params = [workspaceId];
  const where = ["workspace_id = $1"];
  if (filters.problemId) {
    params.push(filters.problemId);
    where.push(`problem_id = $${params.length}`);
  }
  if (filters.agentId) {
    params.push(filters.agentId);
    where.push(`agent = $${params.length}`);
  }
  if (filters.assignmentId) {
    params.push(filters.assignmentId);
    where.push(`assignment_id = $${params.length}`);
  }
  params.push(filters.limit || 100);

  const result = await query(
    `select *
       from posts
      where ${where.join(" and ")}
      order by created_at desc, id desc
      limit $${params.length}`,
    params
  );
  return result.rows;
}

export async function createAgent(workspaceId, input) {
  const agent = {
    id: makeId(`agent:${slugForText(input.name)}`),
    workspace_id: workspaceId,
    name: input.name.trim(),
    role: input.role.trim(),
    status: input.status || "idle",
    domain: input.domain?.trim?.() || "",
    reputation: Number.isInteger(input.reputation) ? input.reputation : 0,
    style: input.style?.trim?.() || "",
    tools: input.tools || [],
    weak_spots: input.weak_spots?.trim?.() || "",
    current_task: input.current_task?.trim?.() || ""
  };

  await query(
    `insert into agents
      (id, workspace_id, name, role, status, domain, reputation, style, tools, weak_spots, current_task)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      agent.id,
      agent.workspace_id,
      agent.name,
      agent.role,
      agent.status,
      agent.domain,
      agent.reputation,
      agent.style,
      JSON.stringify(agent.tools),
      agent.weak_spots,
      agent.current_task
    ]
  );

  return agent;
}

export async function updateAgent(workspaceId, agentId, patch) {
  const current = await getAgent(workspaceId, agentId);
  if (!current) return null;

  const next = {
    ...current,
    name: patch.name !== undefined ? patch.name.trim() : current.name,
    role: patch.role !== undefined ? patch.role.trim() : current.role,
    status: patch.status !== undefined ? patch.status : current.status,
    domain: patch.domain !== undefined ? patch.domain.trim() : current.domain,
    reputation: patch.reputation !== undefined ? patch.reputation : current.reputation,
    style: patch.style !== undefined ? patch.style.trim() : current.style,
    tools: patch.tools !== undefined ? patch.tools : current.tools,
    weak_spots: patch.weak_spots !== undefined ? patch.weak_spots.trim() : current.weak_spots,
    current_task: patch.current_task !== undefined ? patch.current_task.trim() : current.current_task
  };

  const result = await query(
    `update agents
        set name = $3,
            role = $4,
            status = $5,
            domain = $6,
            reputation = $7,
            style = $8,
            tools = $9,
            weak_spots = $10,
            current_task = $11,
            updated_at = now()
      where workspace_id = $1
        and id = $2
      returning *`,
    [
      workspaceId,
      agentId,
      next.name,
      next.role,
      next.status,
      next.domain,
      next.reputation,
      next.style,
      JSON.stringify(next.tools || []),
      next.weak_spots,
      next.current_task
    ]
  );
  return result.rows[0] || null;
}

export async function listAgentApiKeys(workspaceId) {
  const result = await query(
    `select agent_api_keys.id,
            agent_api_keys.workspace_id,
            agent_api_keys.agent_id,
            agents.name as agent_name,
            agents.status as agent_status,
            agent_api_keys.name,
            agent_api_keys.created_at,
            agent_api_keys.last_used_at
       from agent_api_keys
       join agents on agents.id = agent_api_keys.agent_id
      where agent_api_keys.workspace_id = $1
      order by agent_api_keys.created_at desc, agents.name asc`,
    [workspaceId]
  );
  return result.rows;
}

export async function getAgentApiKey(workspaceId, keyId) {
  const result = await query(
    `select agent_api_keys.id,
            agent_api_keys.workspace_id,
            agent_api_keys.agent_id,
            agents.name as agent_name,
            agents.status as agent_status,
            agent_api_keys.name,
            agent_api_keys.created_at,
            agent_api_keys.last_used_at
       from agent_api_keys
       join agents on agents.id = agent_api_keys.agent_id
      where agent_api_keys.workspace_id = $1
        and agent_api_keys.id = $2
      limit 1`,
    [workspaceId, keyId]
  );
  return result.rows[0] || null;
}

export async function createAgentApiKey(workspaceId, input) {
  const apiKey = generateAgentApiKey();
  const result = await query(
    `with inserted as (
       insert into agent_api_keys (id, workspace_id, agent_id, name, key_hash)
       select $1, $2, agents.id, $4, $5
         from agents
        where agents.workspace_id = $2
          and agents.id = $3
       returning *
     )
     select inserted.id,
            inserted.workspace_id,
            inserted.agent_id,
            agents.name as agent_name,
            agents.status as agent_status,
            inserted.name,
            inserted.created_at,
            inserted.last_used_at
       from inserted
       join agents on agents.id = inserted.agent_id`,
    [makeId("key"), workspaceId, input.agent_id, input.name.trim(), stableKeyHash(apiKey)]
  );
  const key = result.rows[0] || null;
  if (!key) return null;
  return { key, api_key: apiKey };
}

export async function rotateAgentApiKey(workspaceId, keyId) {
  const apiKey = generateAgentApiKey();
  const result = await query(
    `with updated as (
       update agent_api_keys
          set key_hash = $3,
              last_used_at = null
        where workspace_id = $1
          and id = $2
       returning *
     )
     select updated.id,
            updated.workspace_id,
            updated.agent_id,
            agents.name as agent_name,
            agents.status as agent_status,
            updated.name,
            updated.created_at,
            updated.last_used_at
       from updated
       join agents on agents.id = updated.agent_id`,
    [workspaceId, keyId, stableKeyHash(apiKey)]
  );
  const key = result.rows[0] || null;
  if (!key) return null;
  return { key, api_key: apiKey };
}

export async function deleteAgentApiKey(workspaceId, keyId) {
  const result = await query(
    `with deleted as (
       delete from agent_api_keys
        where workspace_id = $1
          and id = $2
       returning *
     )
     select deleted.id,
            deleted.workspace_id,
            deleted.agent_id,
            agents.name as agent_name,
            agents.status as agent_status,
            deleted.name,
            deleted.created_at,
            deleted.last_used_at
       from deleted
       join agents on agents.id = deleted.agent_id`,
    [workspaceId, keyId]
  );
  return result.rows[0] || null;
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

export async function getAssignment(workspaceId, assignmentId) {
  const result = await query("select * from assignments where workspace_id = $1 and id = $2", [workspaceId, assignmentId]);
  return result.rows[0] || null;
}

export async function getAssignmentContext(workspaceId, assignmentId) {
  const assignmentResult = await query(
    "select * from assignments where workspace_id = $1 and id = $2",
    [workspaceId, assignmentId]
  );
  const assignment = assignmentResult.rows[0] || null;
  if (!assignment) return null;

  const [problemResult, postsResult] = await Promise.all([
    query("select * from problems where workspace_id = $1 and id = $2", [workspaceId, assignment.problem_id]),
    query(
      "select * from posts where workspace_id = $1 and assignment_id = $2 order by created_at asc, id asc",
      [workspaceId, assignment.id]
    )
  ]);
  const problem = problemResult.rows[0] || null;
  if (!problem) return null;

  const postIds = postsResult.rows.map((post) => post.id);
  const claimsResult = postIds.length
    ? await query(
        `select *
           from claims
          where workspace_id = $1
            and problem_id = $2
            and linked_posts ?| $3::text[]
          order by id asc`,
        [workspaceId, assignment.problem_id, postIds]
      )
    : { rows: [] };

  const claimIds = claimsResult.rows.map((claim) => claim.id);
  const verificationsResult = claimIds.length
    ? await query(
        `select *
           from verifications
          where workspace_id = $1
            and claim_id = any($2::text[])
          order by created_at desc, id asc`,
        [workspaceId, claimIds]
      )
    : { rows: [] };

  const verificationIds = verificationsResult.rows.map((verification) => verification.id);
  const jobsResult = verificationIds.length
    ? await query(
        `select *
           from verification_jobs
          where workspace_id = $1
            and verification_id = any($2::text[])
          order by created_at desc, id asc`,
        [workspaceId, verificationIds]
      )
    : { rows: [] };

  const artifactIds = new Set();
  for (const post of postsResult.rows) {
    for (const artifactId of Array.isArray(post.artifacts) ? post.artifacts : []) {
      if (artifactId) artifactIds.add(artifactId);
    }
  }
  for (const verification of verificationsResult.rows) {
    if (verification.artifact_id) artifactIds.add(verification.artifact_id);
  }

  const artifactsResult = artifactIds.size
    ? await query(
        `select *
           from artifacts
          where workspace_id = $1
            and problem_id = $2
            and id = any($3::text[])
          order by created_at desc, id asc`,
        [workspaceId, assignment.problem_id, [...artifactIds]]
      )
    : { rows: [] };

  return {
    assignment,
    problem,
    posts: postsResult.rows,
    claims: claimsResult.rows,
    verifications: verificationsResult.rows,
    verification_jobs: jobsResult.rows,
    artifacts: artifactsResult.rows
  };
}

export async function updateAssignment(workspaceId, assignmentId, patch) {
  const result = await query(
    `update assignments
        set status = $3
      where workspace_id = $1
        and id = $2
      returning *`,
    [workspaceId, assignmentId, patch.status]
  );
  return result.rows[0] || null;
}

export async function listProblems(workspaceId) {
  const result = await query(
    "select * from problems where workspace_id = $1 order by updated_at desc nulls last, id asc",
    [workspaceId]
  );
  return result.rows;
}

export async function getProblem(workspaceId, problemId) {
  const result = await query("select * from problems where workspace_id = $1 and id = $2", [workspaceId, problemId]);
  return result.rows[0] || null;
}

export async function getProblemContext(workspaceId, problemId) {
  const [problem, assignments, claims, posts, artifacts, verifications, verificationJobs] = await Promise.all([
    query("select * from problems where workspace_id = $1 and id = $2", [workspaceId, problemId]),
    query("select * from assignments where workspace_id = $1 and problem_id = $2 order by created_at desc", [workspaceId, problemId]),
    query("select * from claims where workspace_id = $1 and problem_id = $2 order by id asc", [workspaceId, problemId]),
    query("select * from posts where workspace_id = $1 and problem_id = $2 order by created_at desc", [workspaceId, problemId]),
    query("select * from artifacts where workspace_id = $1 and problem_id = $2 order by created_at desc, id asc", [workspaceId, problemId]),
    query(
      `select verifications.*, claims.statement as claim_statement
         from verifications
         join claims on claims.id = verifications.claim_id
          and claims.workspace_id = verifications.workspace_id
        where verifications.workspace_id = $1
          and claims.problem_id = $2
        order by verifications.created_at desc`,
      [workspaceId, problemId]
    ),
    query(
      `select verification_jobs.*
         from verification_jobs
         join verifications on verifications.id = verification_jobs.verification_id
          and verifications.workspace_id = verification_jobs.workspace_id
         join claims on claims.id = verifications.claim_id
          and claims.workspace_id = verifications.workspace_id
        where verification_jobs.workspace_id = $1
          and claims.problem_id = $2
        order by verification_jobs.created_at desc`,
      [workspaceId, problemId]
    )
  ]);

  if (!problem.rows[0]) return null;
  return {
    problem: problem.rows[0],
    assignments: assignments.rows,
    claims: claims.rows,
    posts: posts.rows,
    artifacts: artifacts.rows,
    verifications: verifications.rows,
    verification_jobs: verificationJobs.rows
  };
}

export async function createProblem(workspaceId, input) {
  const now = new Date().toISOString();
  const problem = {
    id: makeId("problem"),
    workspace_id: workspaceId,
    title: input.title.trim(),
    area: input.area.trim(),
    status: input.status || "open",
    priority: input.priority || "medium",
    updated_at: now,
    summary: input.summary.trim(),
    why_it_matters: input.why_it_matters?.trim?.() || "",
    tags: input.tags || [],
    assignment_ids: [],
    claim_ids: []
  };

  await query(
    `insert into problems
      (id, workspace_id, title, area, status, priority, updated_at, summary, why_it_matters, tags, assignment_ids, claim_ids)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      problem.id,
      problem.workspace_id,
      problem.title,
      problem.area,
      problem.status,
      problem.priority,
      problem.updated_at,
      problem.summary,
      problem.why_it_matters,
      JSON.stringify(problem.tags),
      JSON.stringify(problem.assignment_ids),
      JSON.stringify(problem.claim_ids)
    ]
  );

  return problem;
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

export async function listArtifacts(workspaceId, problemId = "") {
  const params = [workspaceId];
  let problemSql = "";
  if (problemId) {
    params.push(problemId);
    problemSql = ` and problem_id = $${params.length}`;
  }

  const result = await query(
    `select *
       from artifacts
      where workspace_id = $1
        ${problemSql}
      order by created_at desc, id asc`,
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

export async function getArtifact(workspaceId, artifactId) {
  const result = await query("select * from artifacts where workspace_id = $1 and id = $2", [workspaceId, artifactId]);
  return result.rows[0] || null;
}

export async function getClaim(workspaceId, claimId) {
  const result = await query("select * from claims where workspace_id = $1 and id = $2", [workspaceId, claimId]);
  return result.rows[0] || null;
}

export async function getVerification(workspaceId, verificationId) {
  const result = await query("select * from verifications where workspace_id = $1 and id = $2", [workspaceId, verificationId]);
  return result.rows[0] || null;
}

export async function getVerificationContext(workspaceId, verificationId) {
  const verificationResult = await query(
    "select * from verifications where workspace_id = $1 and id = $2",
    [workspaceId, verificationId]
  );
  const verification = verificationResult.rows[0] || null;
  if (!verification) return null;

  const claimResult = await query(
    "select * from claims where workspace_id = $1 and id = $2",
    [workspaceId, verification.claim_id]
  );
  const claim = claimResult.rows[0] || null;
  if (!claim) return null;

  const [problemResult, jobsResult] = await Promise.all([
    query("select * from problems where workspace_id = $1 and id = $2", [workspaceId, claim.problem_id]),
    query(
      "select * from verification_jobs where workspace_id = $1 and verification_id = $2 order by created_at desc, id asc",
      [workspaceId, verification.id]
    )
  ]);
  const problem = problemResult.rows[0] || null;
  if (!problem) return null;

  const postIds = new Set(Array.isArray(claim.linked_posts) ? claim.linked_posts : []);
  for (const job of jobsResult.rows) {
    const postId = job.payload?.post_id?.trim?.();
    if (postId) postIds.add(postId);
  }

  const postsResult = await query(
    `with focused_posts as (
       select *
         from posts
        where workspace_id = $1
          and problem_id = $2
          and id = any($3::text[])
     ),
     dependency_ids as (
       select distinct jsonb_array_elements_text(dependencies) as id
         from focused_posts
     )
     select *
       from posts
      where workspace_id = $1
        and problem_id = $2
        and (
          id = any($3::text[])
          or id in (select id from dependency_ids)
        )
      order by created_at asc, id asc`,
    [workspaceId, claim.problem_id, [...postIds]]
  );

  const assignmentIds = new Set();
  const artifactIds = new Set();
  if (verification.artifact_id) artifactIds.add(verification.artifact_id);
  for (const post of postsResult.rows) {
    if (post.assignment_id) assignmentIds.add(post.assignment_id);
    for (const artifactId of Array.isArray(post.artifacts) ? post.artifacts : []) {
      if (artifactId) artifactIds.add(artifactId);
    }
  }

  const [assignmentsResult, artifactsResult] = await Promise.all([
    assignmentIds.size
      ? query(
          "select * from assignments where workspace_id = $1 and problem_id = $2 and id = any($3::text[]) order by created_at desc, id asc",
          [workspaceId, claim.problem_id, [...assignmentIds]]
        )
      : { rows: [] },
    artifactIds.size
      ? query(
          "select * from artifacts where workspace_id = $1 and problem_id = $2 and id = any($3::text[]) order by created_at desc, id asc",
          [workspaceId, claim.problem_id, [...artifactIds]]
        )
      : { rows: [] }
  ]);

  return {
    verification,
    claim,
    problem,
    linked_posts: postsResult.rows,
    assignments: assignmentsResult.rows,
    artifacts: artifactsResult.rows,
    verification_jobs: jobsResult.rows
  };
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

function slugForText(value) {
  return String(value || "agent")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "agent";
}
