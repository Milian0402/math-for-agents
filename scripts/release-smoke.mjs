import assert from "node:assert/strict";

import { closePool, transaction } from "../server/db.js";
import { runWorkerOnce, stdoutHash } from "../server/verification-worker.js";

const baseUrl = process.env.MFA_BASE_URL || "http://127.0.0.1:4173";
const humanEmail = process.env.MFA_HUMAN_EMAIL || "max@example.com";
const humanPassword = process.env.MFA_HUMAN_PASSWORD || "mfa_dev_password";
const seedAgentId = process.env.MFA_SMOKE_AGENT_ID || "agent:finite-model-searcher";
const seedProblemId = process.env.MFA_SMOKE_PROBLEM_ID || "finite-magma-identity-search";
const smokeRunId = `smoke-${Date.now().toString(36)}`;
let problemId = seedProblemId;
let agentId = seedAgentId;
let assignmentId = "";

const created = {
  keyIds: [],
  agentIds: [],
  problemIds: [],
  assignmentIds: [],
  postIds: [],
  claimIds: [],
  verificationIds: [],
  verificationJobIds: [],
  artifactIds: []
};

let cookie = "";

async function main() {
  const health = await request("/api/health", {
    headers: { "x-request-id": `${smokeRunId}-health` },
    auth: false
  });
  assert.equal(health.status, 200);
  assert.equal(health.payload.database, "ok");
  assert.equal(health.headers.get("x-request-id"), `${smokeRunId}-health`);

  const missing = await request("/api/store", {
    headers: { "x-request-id": `${smokeRunId}-missing` },
    auth: false
  });
  assert.equal(missing.status, 401);
  assert.equal(missing.payload.request_id, `${smokeRunId}-missing`);

  const login = await request("/api/auth/login", {
    method: "POST",
    auth: false,
    body: {
      email: humanEmail,
      password: humanPassword
    }
  });
  assert.equal(login.status, 200);
  assert.equal(login.payload.principal.kind, "human");
  assert.match(cookie, /^mfa_session=/);

  const store = await request("/api/store");
  assert.equal(store.status, 200);
  assert.equal(store.payload.principal.auth_method, "human-session");
  assert.ok(store.payload.store.problems.some((problem) => problem.id === seedProblemId));
  assert.ok(store.payload.store.agents.some((agent) => agent.id === seedAgentId));

  const createdProblem = await request("/api/problems", {
    method: "POST",
    body: {
      title: `Release smoke problem ${smokeRunId}`,
      area: "Release smoke",
      priority: "high",
      summary: "Temporary problem opened by the release smoke test.",
      why_it_matters: "Proves humans can open a fresh research target online before sending agents to work.",
      tags: ["smoke", "release"]
    }
  });
  assert.equal(createdProblem.status, 201);
  assert.equal(createdProblem.payload.problem.title, `Release smoke problem ${smokeRunId}`);
  problemId = createdProblem.payload.problem.id;
  created.problemIds.push(problemId);

  const createdAgent = await request("/api/agents", {
    method: "POST",
    body: {
      name: `Release smoke agent ${smokeRunId}`,
      role: "Replay smoke runner",
      status: "idle",
      domain: "Release smoke",
      style: "Posts replayable command output for smoke verification.",
      tools: ["node", "printf"],
      weak_spots: "Temporary test profile.",
      current_task: "Run one release smoke assignment."
    }
  });
  assert.equal(createdAgent.status, 201);
  assert.equal(createdAgent.payload.agent.name, `Release smoke agent ${smokeRunId}`);
  agentId = createdAgent.payload.agent.id;
  created.agentIds.push(agentId);

  const listedAgents = await request("/api/agents");
  assert.equal(listedAgents.status, 200);
  assert.ok(listedAgents.payload.agents.some((agent) => agent.id === agentId));

  const createdKey = await request("/api/agent-keys", {
    method: "POST",
    body: {
      agent_id: agentId,
      name: smokeRunId
    }
  });
  assert.equal(createdKey.status, 201);
  created.keyIds.push(createdKey.payload.key.id);
  const firstAgentKey = createdKey.payload.api_key;
  assert.match(firstAgentKey, /^mfa_/);

  const createdAssignment = await request("/api/assignments", {
    method: "POST",
    body: {
      problem_id: problemId,
      task: "search",
      prompt: "Run a small replayable smoke search and report the exact command.",
      desired_output: ["computation-log", "human-summary"],
      assigned_agents: [agentId]
    }
  });
  assert.equal(createdAssignment.status, 201);
  assignmentId = createdAssignment.payload.assignment.id;
  created.assignmentIds.push(assignmentId);
  created.postIds.push(createdAssignment.payload.post.id);

  const initialProblemContext = await request(`/api/problems/${encodeURIComponent(problemId)}`, {
    bearer: firstAgentKey
  });
  assert.equal(initialProblemContext.status, 200);
  assert.equal(initialProblemContext.payload.problem.id, problemId);
  assert.ok(initialProblemContext.payload.assignments.some((assignment) => assignment.id === assignmentId));
  assert.ok(initialProblemContext.payload.posts.some((post) => post.id === createdAssignment.payload.post.id));
  assert.deepEqual(initialProblemContext.payload.claims, []);

  const agentAssignments = await request("/api/assignments", {
    bearer: firstAgentKey
  });
  assert.equal(agentAssignments.status, 200);
  assert.ok(agentAssignments.payload.assignments.some((assignment) => assignment.id === assignmentId));

  const claimedAssignment = await request(`/api/assignments/${encodeURIComponent(assignmentId)}`, {
    method: "PATCH",
    bearer: firstAgentKey,
    body: { status: "claimed" }
  });
  assert.equal(claimedAssignment.status, 200);
  assert.equal(claimedAssignment.payload.assignment.status, "claimed");

  const runningAssignment = await request(`/api/assignments/${encodeURIComponent(assignmentId)}`, {
    method: "PATCH",
    bearer: firstAgentKey,
    body: { status: "running" }
  });
  assert.equal(runningAssignment.status, 200);
  assert.equal(runningAssignment.payload.assignment.status, "running");

  const agentDoneAttempt = await request(`/api/assignments/${encodeURIComponent(assignmentId)}`, {
    method: "PATCH",
    bearer: firstAgentKey,
    body: { status: "done" }
  });
  assert.equal(agentDoneAttempt.status, 403);

  const rotatedKey = await request(`/api/agent-keys/${encodeURIComponent(createdKey.payload.key.id)}/rotate`, {
    method: "POST"
  });
  assert.equal(rotatedKey.status, 200);
  const agentKey = rotatedKey.payload.api_key;

  const oldKeyCheck = await request("/api/me", {
    bearer: firstAgentKey
  });
  assert.equal(oldKeyCheck.status, 401);

  const newKeyCheck = await request("/api/me", {
    bearer: agentKey
  });
  assert.equal(newKeyCheck.status, 200);
  assert.equal(newKeyCheck.payload.principal.id, agentId);

  const artifactUpload = await request("/api/artifacts", {
    method: "POST",
    bearer: agentKey,
    body: {
      problem_id: problemId,
      kind: "smoke-log",
      title: `${smokeRunId} uploaded artifact`,
      summary: "Release smoke uploaded artifact content.",
      file_name: `${smokeRunId}.txt`,
      content_type: "text/plain",
      content_text: "release smoke artifact\n"
    }
  });
  assert.equal(artifactUpload.status, 201);
  created.artifactIds.push(artifactUpload.payload.artifact.id);

  const artifactDownload = await request(`/api/artifacts/${encodeURIComponent(artifactUpload.payload.artifact.id)}/file`, {
    bearer: agentKey,
    parseJson: false
  });
  assert.equal(artifactDownload.status, 200);
  assert.equal(await artifactDownload.response.text(), "release smoke artifact\n");

  const reviewContribution = await request("/api/contributions", {
    method: "POST",
    bearer: agentKey,
    body: {
      problem_id: problemId,
      assignment_id: assignmentId,
      type: "attempt",
      evidence_level: "speculative",
      status: "needs-review",
      body: `Release smoke review-only claim for ${smokeRunId}.`,
      claim_type: "lemma",
      claim_statement: `Release smoke review-only claim ${smokeRunId}.`,
      priority: "medium",
      verifier: agentId
    }
  });
  assert.equal(reviewContribution.status, 201);
  assert.equal(reviewContribution.payload.verification.method, "agent-review");
  assert.equal(reviewContribution.payload.verification.assigned_agent, agentId);
  created.postIds.push(reviewContribution.payload.post.id);
  created.claimIds.push(reviewContribution.payload.claim.id);
  created.verificationIds.push(reviewContribution.payload.verification.id);
  created.verificationJobIds.push(reviewContribution.payload.verificationJob.id);

  const agentReviewPatch = await request(
    `/api/verifications/${encodeURIComponent(reviewContribution.payload.verification.id)}`,
    {
      method: "PATCH",
      bearer: agentKey,
      body: {
        status: "passed",
        notes: "Agent review smoke pass. This should not settle the claim."
      }
    }
  );
  assert.equal(agentReviewPatch.status, 200);
  assert.equal(agentReviewPatch.payload.verification.status, "passed");
  assert.equal(agentReviewPatch.payload.claimPatch.status, "needs-review");
  assert.equal(agentReviewPatch.payload.claimPatch.trust_tier, "agent-reviewed");

  const agentReviewState = await readVerificationState(reviewContribution.payload.verificationJob.id);
  assert.equal(agentReviewState.job_status, "passed");
  assert.equal(agentReviewState.verification_status, "passed");
  assert.equal(agentReviewState.claim_status, "needs-review");
  assert.equal(agentReviewState.trust_tier, "agent-reviewed");

  const stdout = `${smokeRunId}\n`;
  const contribution = await request("/api/contributions", {
    method: "POST",
    bearer: agentKey,
    body: {
      problem_id: problemId,
      assignment_id: assignmentId,
      type: "attempt",
      evidence_level: "computational",
      status: "needs-review",
      body: `Release smoke replay for ${smokeRunId}.`,
      claim_type: "lemma",
      claim_statement: `Release smoke claim ${smokeRunId}.`,
      priority: "high",
      replay: {
        command: `printf '${stdout.replace("\n", "\\n")}'`,
        seed: smokeRunId,
        env: "local release smoke",
        output_hash: stdoutHash(stdout)
      }
    }
  });
  assert.equal(contribution.status, 201);
  created.postIds.push(contribution.payload.post.id);
  created.claimIds.push(contribution.payload.claim.id);
  created.verificationIds.push(contribution.payload.verification.id);
  created.verificationJobIds.push(contribution.payload.verificationJob.id);

  const contributedProblemContext = await request(`/api/problems/${encodeURIComponent(problemId)}`, {
    bearer: agentKey
  });
  assert.equal(contributedProblemContext.status, 200);
  assert.ok(contributedProblemContext.payload.posts.some((post) => post.id === contribution.payload.post.id));
  assert.ok(contributedProblemContext.payload.claims.some((claim) => claim.id === contribution.payload.claim.id));
  assert.ok(
    contributedProblemContext.payload.verifications.some(
      (verification) => verification.id === contribution.payload.verification.id
    )
  );
  assert.ok(
    contributedProblemContext.payload.verification_jobs.some(
      (job) => job.id === contribution.payload.verificationJob.id
    )
  );

  const unauthorizedVerificationPatch = await request(
    `/api/verifications/${encodeURIComponent(contribution.payload.verification.id)}`,
    {
      method: "PATCH",
      bearer: agentKey,
      body: {
        status: "in-review",
        notes: "Contributor agent should not be able to claim verifier work."
      }
    }
  );
  assert.equal(unauthorizedVerificationPatch.status, 403);

  const worker = await runWorkerOnce({
    runner: "local",
    allowLocal: true,
    timeoutMs: 5_000,
    maxOutputBytes: 64_000,
    jobId: contribution.payload.verificationJob.id
  });
  assert.equal(worker.claimed, true);
  assert.equal(worker.status, "passed");
  created.artifactIds.push(worker.artifact_id);

  const verificationState = await readVerificationState(contribution.payload.verificationJob.id);
  assert.equal(verificationState.job_status, "passed");
  assert.equal(verificationState.verification_status, "passed");
  assert.equal(verificationState.claim_status, "accepted");
  assert.equal(verificationState.trust_tier, "independently-replayed");
  assert.equal(verificationState.assignment_status, "needs-human-review");
  assert.ok(verificationState.artifact_id);

  const markdownExport = await request(
    `/api/problems/${encodeURIComponent(problemId)}/export?format=markdown`,
    {
      bearer: agentKey,
      parseJson: false
    }
  );
  assert.equal(markdownExport.status, 200);
  assert.match(markdownExport.headers.get("content-type") || "", /text\/markdown/);
  assert.match(await markdownExport.response.text(), new RegExp(`Release smoke problem ${smokeRunId}`));

  const leanExport = await request(
    `/api/problems/${encodeURIComponent(problemId)}/export?format=lean-issue`,
    {
      bearer: agentKey,
      parseJson: false
    }
  );
  assert.equal(leanExport.status, 200);
  assert.match(await leanExport.response.text(), /```lean/);

  const paperNotesExport = await request(
    `/api/problems/${encodeURIComponent(problemId)}/export?format=paper-notes`,
    {
      bearer: agentKey,
      parseJson: false
    }
  );
  assert.equal(paperNotesExport.status, 200);
  assert.match(await paperNotesExport.response.text(), /## Results Ledger/);

  const completedAssignment = await request(`/api/assignments/${encodeURIComponent(assignmentId)}`, {
    method: "PATCH",
    body: { status: "done" }
  });
  assert.equal(completedAssignment.status, 200);
  assert.equal(completedAssignment.payload.assignment.status, "done");

  const revoked = await request(`/api/agent-keys/${encodeURIComponent(createdKey.payload.key.id)}`, {
    method: "DELETE"
  });
  assert.equal(revoked.status, 200);

  const revokedCheck = await request("/api/me", {
    bearer: agentKey
  });
  assert.equal(revokedCheck.status, 401);

  console.log(JSON.stringify({
    ok: true,
    base_url: baseUrl,
    smoke_run_id: smokeRunId,
    worker_artifact_id: worker.artifact_id,
    verified: [
      "health",
      "request-id errors",
      "human session login",
      "problem creation",
      "problem context fetch",
      "agent profile creation",
      "agent key create/rotate/revoke",
      "assignment creation",
      "agent assignment fetch",
      "agent assignment status updates",
      "human assignment closeout",
      "artifact upload/download",
      "agent contribution",
      "verification assignment authorization",
      "assigned verifier result update",
      "agent-review trust gate",
      "verification worker promotion",
      "problem exports"
    ]
  }, null, 2));
}

async function request(path, options = {}) {
  const headers = {
    ...(options.body ? { "content-type": "application/json" } : {}),
    ...(cookie && options.auth !== false && !options.bearer ? { cookie } : {}),
    ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
    ...(options.headers || {})
  };
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const payload = options.parseJson === false ? null : await response.json().catch(() => ({}));
  return {
    status: response.status,
    headers: response.headers,
    payload,
    response
  };
}

async function readVerificationState(jobId) {
  return transaction(async (client) => {
    const result = await client.query(
      `select verification_jobs.status as job_status,
              verifications.status as verification_status,
              verifications.artifact_id,
              claims.status as claim_status,
              claims.trust_tier,
              assignments.status as assignment_status
         from verification_jobs
         join verifications on verifications.id = verification_jobs.verification_id
          and verifications.workspace_id = verification_jobs.workspace_id
         join claims on claims.id = verifications.claim_id
          and claims.workspace_id = verification_jobs.workspace_id
         left join posts on posts.id = (verification_jobs.payload->>'post_id')
          and posts.workspace_id = verification_jobs.workspace_id
         left join assignments on assignments.id = posts.assignment_id
          and assignments.workspace_id = verification_jobs.workspace_id
        where verification_jobs.id = $1`,
      [jobId]
    );
    return result.rows[0] || {};
  });
}

async function cleanup() {
  await transaction(async (client) => {
    if (created.verificationJobIds.length) {
      await client.query("delete from verification_jobs where id = any($1)", [created.verificationJobIds]);
    }
    if (created.verificationIds.length) {
      await client.query("delete from verifications where id = any($1)", [created.verificationIds]);
    }
    if (created.claimIds.length) {
      for (const claimId of created.claimIds) {
        await client.query(
          `update problems
              set claim_ids = coalesce(claim_ids, '[]'::jsonb) - $1
            where claim_ids ? $1`,
          [claimId]
        );
      }
      await client.query("delete from claims where id = any($1)", [created.claimIds]);
    }
    if (created.postIds.length) {
      await client.query("delete from posts where id = any($1)", [created.postIds]);
    }
    if (created.artifactIds.length) {
      await client.query("delete from artifacts where id = any($1)", [created.artifactIds]);
    }
    if (created.assignmentIds.length) {
      await client.query("delete from assignments where id = any($1)", [created.assignmentIds]);
    }
    if (created.keyIds.length) {
      await client.query("delete from agent_api_keys where id = any($1)", [created.keyIds]);
    }
    if (created.agentIds.length) {
      await client.query("delete from agents where id = any($1)", [created.agentIds]);
    }
    if (created.problemIds.length) {
      await client.query("delete from problems where id = any($1)", [created.problemIds]);
    }
  });
}

main()
  .finally(async () => {
    await logout().catch((error) => {
      console.error("release smoke logout failed", error);
      process.exitCode = 1;
    });
    await cleanup().catch((error) => {
      console.error("release smoke cleanup failed", error);
      process.exitCode = 1;
    });
    await closePool();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

async function logout() {
  if (!cookie) return;
  await request("/api/auth/logout", {
    method: "POST"
  });
  cookie = "";
}
