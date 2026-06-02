import assert from "node:assert/strict";

import { closePool, transaction } from "../server/db.js";
import { runWorkerOnce, stdoutHash } from "../server/verification-worker.js";

const baseUrl = process.env.MFA_BASE_URL || "http://127.0.0.1:4173";
const humanEmail = process.env.MFA_HUMAN_EMAIL || "max@example.com";
const humanPassword = process.env.MFA_HUMAN_PASSWORD || "mfa_dev_password";
const seedAgentId = process.env.MFA_SMOKE_AGENT_ID || "agent:finite-model-searcher";
const seedProblemId = process.env.MFA_SMOKE_PROBLEM_ID || "finite-magma-identity-search";
const smokeRunId = `smoke-${Date.now().toString(36)}`;
const baseOrigin = new URL(baseUrl).origin;
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
  const humanId = login.payload.principal.id;
  assert.match(cookie, /^mfa_session=/);

  const crossOriginWrite = await request("/api/problems", {
    method: "POST",
    headers: { origin: "https://example.invalid" },
    body: {
      title: `Blocked cross-origin problem ${smokeRunId}`,
      area: "Release smoke",
      summary: "This should be blocked by the session same-origin guard."
    }
  });
  assert.equal(crossOriginWrite.status, 403);

  const store = await request("/api/store");
  assert.equal(store.status, 200);
  assert.equal(store.payload.principal.auth_method, "human-session");
  assert.ok(store.payload.store.problems.some((problem) => problem.id === seedProblemId));
  assert.ok(store.payload.store.agents.some((agent) => agent.id === seedAgentId));

  const humanWorkWithoutAgent = await request("/api/work");
  assert.equal(humanWorkWithoutAgent.status, 400);

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

  const humanArtifactUpload = await request("/api/artifacts", {
    method: "POST",
    body: {
      problem_id: problemId,
      kind: "human-note",
      title: `${smokeRunId} human artifact`,
      summary: "Release smoke human-authored artifact content.",
      file_name: `${smokeRunId}-human.txt`,
      content_type: "text/plain",
      content_text: "human artifact\n"
    }
  });
  assert.equal(humanArtifactUpload.status, 201);
  assert.equal(humanArtifactUpload.payload.artifact.owner, humanId);
  created.artifactIds.push(humanArtifactUpload.payload.artifact.id);

  const unknownOwnerArtifact = await request("/api/artifacts", {
    method: "POST",
    body: {
      problem_id: problemId,
      owner: `agent:missing-owner-${smokeRunId}`,
      kind: "human-note",
      title: `${smokeRunId} unknown owner artifact`,
      summary: "This artifact should fail because the owner is not a workspace principal.",
      file_name: `${smokeRunId}-unknown-owner.txt`,
      content_type: "text/plain",
      content_text: "unknown owner artifact\n"
    }
  });
  assert.equal(unknownOwnerArtifact.status, 404);

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

  const humanDelegatedContribution = await request("/api/contributions", {
    method: "POST",
    body: {
      agent: agentId,
      problem_id: problemId,
      type: "literature-note",
      evidence_level: "speculative",
      status: "open",
      body: "Human-authenticated smoke ingest on behalf of a real workspace agent."
    }
  });
  assert.equal(humanDelegatedContribution.status, 201);
  assert.equal(humanDelegatedContribution.payload.post.agent, agentId);
  created.postIds.push(humanDelegatedContribution.payload.post.id);

  const unknownAuthorContribution = await request("/api/contributions", {
    method: "POST",
    body: {
      agent: `agent:missing-author-${smokeRunId}`,
      problem_id: problemId,
      type: "literature-note",
      evidence_level: "speculative",
      status: "open",
      body: "This contribution should fail because the author is not a workspace principal."
    }
  });
  assert.equal(unknownAuthorContribution.status, 404);

  const disabledAgent = await request("/api/agents", {
    method: "POST",
    body: {
      name: `Release smoke disabled agent ${smokeRunId}`,
      role: "Disabled smoke profile",
      status: "disabled",
      domain: "Release smoke",
      style: "Should not be able to receive API keys.",
      tools: ["none"],
      weak_spots: "Disabled.",
      current_task: "No live work."
    }
  });
  assert.equal(disabledAgent.status, 201);
  created.agentIds.push(disabledAgent.payload.agent.id);

  const disabledAgentKey = await request("/api/agent-keys", {
    method: "POST",
    body: {
      agent_id: disabledAgent.payload.agent.id,
      name: `${smokeRunId} disabled key`
    }
  });
  assert.equal(disabledAgentKey.status, 403);

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

  const listedContributions = await request(`/api/contributions?problem_id=${encodeURIComponent(problemId)}`, {
    bearer: firstAgentKey
  });
  assert.equal(listedContributions.status, 200);
  assert.ok(listedContributions.payload.contributions.some((post) => post.id === humanDelegatedContribution.payload.post.id));
  assert.ok(listedContributions.payload.contributions.every((post) => post.problem_id === problemId));

  const listedAgentContributions = await request(`/api/contributions?agent=${encodeURIComponent(agentId)}&limit=5`, {
    bearer: firstAgentKey
  });
  assert.equal(listedAgentContributions.status, 200);
  assert.ok(listedAgentContributions.payload.contributions.some((post) => post.id === humanDelegatedContribution.payload.post.id));
  assert.ok(listedAgentContributions.payload.contributions.every((post) => post.agent === agentId));
  assert.ok(listedAgentContributions.payload.contributions.length <= 5);

  const invalidContributionLimit = await request("/api/contributions?limit=999", {
    bearer: firstAgentKey
  });
  assert.equal(invalidContributionLimit.status, 422);

  const unknownProblemContributions = await request(`/api/contributions?problem_id=${encodeURIComponent(`problem:missing-${smokeRunId}`)}`, {
    bearer: firstAgentKey
  });
  assert.equal(unknownProblemContributions.status, 404);

  const unknownProblemAssignment = await request("/api/assignments", {
    method: "POST",
    body: {
      problem_id: `problem:missing-${smokeRunId}`,
      task: "missing-problem-check",
      prompt: "This assignment should fail because the problem does not exist in the workspace.",
      desired_output: ["review"],
      assigned_agents: [agentId]
    }
  });
  assert.equal(unknownProblemAssignment.status, 404);

  const unknownAgentAssignment = await request("/api/assignments", {
    method: "POST",
    body: {
      problem_id: problemId,
      task: "ghost-agent-check",
      prompt: "This assignment should fail because the assigned agent does not exist.",
      desired_output: ["review"],
      assigned_agents: ["agent:does-not-exist"]
    }
  });
  assert.equal(unknownAgentAssignment.status, 404);

  const blankAgentAssignment = await request("/api/assignments", {
    method: "POST",
    body: {
      problem_id: problemId,
      task: "blank-agent-check",
      prompt: "This assignment should fail because assigned_agents contains a blank id.",
      desired_output: ["review"],
      assigned_agents: [""]
    }
  });
  assert.equal(blankAgentAssignment.status, 422);

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

  const mismatchedAssignmentContributions = await request(
    `/api/contributions?problem_id=${encodeURIComponent(seedProblemId)}&assignment_id=${encodeURIComponent(assignmentId)}`,
    {
      bearer: firstAgentKey
    }
  );
  assert.equal(mismatchedAssignmentContributions.status, 422);

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

  const initialAgentWork = await request("/api/work", {
    bearer: firstAgentKey
  });
  assert.equal(initialAgentWork.status, 200);
  assert.equal(initialAgentWork.payload.agent_id, agentId);
  assert.ok(initialAgentWork.payload.assignments.some((assignment) => assignment.id === assignmentId));
  assert.ok(initialAgentWork.payload.items.some((item) => item.kind === "assignment" && item.id === assignmentId));
  assert.ok(initialAgentWork.payload.items.every((item) => item.context_path.startsWith("/api/")));

  const initialAssignmentContext = await request(`/api/assignments/${encodeURIComponent(assignmentId)}`, {
    bearer: firstAgentKey
  });
  assert.equal(initialAssignmentContext.status, 200);
  assert.equal(initialAssignmentContext.payload.assignment.id, assignmentId);
  assert.equal(initialAssignmentContext.payload.problem.id, problemId);
  assert.ok(initialAssignmentContext.payload.posts.some((post) => post.id === createdAssignment.payload.post.id));
  assert.deepEqual(initialAssignmentContext.payload.claims, []);

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

  const agentHeartbeat = await request(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    bearer: agentKey,
    body: {
      status: "running",
      current_task: `Release smoke assignment ${assignmentId}`
    }
  });
  assert.equal(agentHeartbeat.status, 200);
  assert.equal(agentHeartbeat.payload.agent.status, "running");
  assert.equal(agentHeartbeat.payload.agent.current_task, `Release smoke assignment ${assignmentId}`);

  const foreignAgentHeartbeat = await request(`/api/agents/${encodeURIComponent(seedAgentId)}`, {
    method: "PATCH",
    bearer: agentKey,
    body: {
      status: "running",
      current_task: "This agent should not be able to update another profile."
    }
  });
  assert.equal(foreignAgentHeartbeat.status, 403);

  const agentReputationPatch = await request(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    bearer: agentKey,
    body: {
      reputation: 100
    }
  });
  assert.equal(agentReputationPatch.status, 403);

  const dependentContribution = await request("/api/contributions", {
    method: "POST",
    bearer: agentKey,
    body: {
      problem_id: problemId,
      type: "literature-note",
      evidence_level: "speculative",
      status: "open",
      dependencies: [humanDelegatedContribution.payload.post.id],
      body: "This contribution should be able to cite a post on the same problem."
    }
  });
  assert.equal(dependentContribution.status, 201);
  assert.deepEqual(dependentContribution.payload.post.dependencies, [humanDelegatedContribution.payload.post.id]);
  created.postIds.push(dependentContribution.payload.post.id);

  const crossProblemDependencyContribution = await request("/api/contributions", {
    method: "POST",
    bearer: agentKey,
    body: {
      problem_id: problemId,
      type: "literature-note",
      evidence_level: "speculative",
      status: "open",
      dependencies: ["post-magma-search-001"],
      body: "This contribution should fail because the dependency belongs to a different problem."
    }
  });
  assert.equal(crossProblemDependencyContribution.status, 404);

  const blankDependencyContribution = await request("/api/contributions", {
    method: "POST",
    bearer: agentKey,
    body: {
      problem_id: problemId,
      type: "literature-note",
      evidence_level: "speculative",
      status: "open",
      dependencies: [""],
      body: "This contribution should fail because dependencies contains a blank post id."
    }
  });
  assert.equal(blankDependencyContribution.status, 422);

  const agentOwnerMismatchArtifact = await request("/api/artifacts", {
    method: "POST",
    bearer: agentKey,
    body: {
      problem_id: problemId,
      owner: seedAgentId,
      kind: "smoke-log",
      title: `${smokeRunId} agent owner mismatch artifact`,
      summary: "Agent auth should not be able to upload artifacts as a different agent.",
      file_name: `${smokeRunId}-owner-mismatch.txt`,
      content_type: "text/plain",
      content_text: "owner mismatch artifact\n"
    }
  });
  assert.equal(agentOwnerMismatchArtifact.status, 403);

  const agentAuthorMismatchContribution = await request("/api/contributions", {
    method: "POST",
    bearer: agentKey,
    body: {
      agent: seedAgentId,
      problem_id: problemId,
      type: "attempt",
      evidence_level: "speculative",
      status: "needs-review",
      body: "Agent auth should not be able to submit as a different agent."
    }
  });
  assert.equal(agentAuthorMismatchContribution.status, 403);

  await setAgentStatus(agentId, "disabled");

  const disabledExistingKeyCheck = await request("/api/me", {
    bearer: agentKey
  });
  assert.equal(disabledExistingKeyCheck.status, 401);

  const disabledRotateAttempt = await request(`/api/agent-keys/${encodeURIComponent(createdKey.payload.key.id)}/rotate`, {
    method: "POST"
  });
  assert.equal(disabledRotateAttempt.status, 403);

  await setAgentStatus(agentId, "idle");

  const unknownProblemArtifact = await request("/api/artifacts", {
    method: "POST",
    bearer: agentKey,
    body: {
      problem_id: `problem:missing-${smokeRunId}`,
      kind: "smoke-log",
      title: `${smokeRunId} missing problem artifact`,
      summary: "This artifact should fail because the problem does not exist.",
      file_name: `${smokeRunId}-missing.txt`,
      content_type: "text/plain",
      content_text: "missing problem artifact\n"
    }
  });
  assert.equal(unknownProblemArtifact.status, 404);

  const unknownProblemContribution = await request("/api/contributions", {
    method: "POST",
    bearer: agentKey,
    body: {
      problem_id: `problem:missing-${smokeRunId}`,
      type: "attempt",
      evidence_level: "speculative",
      status: "needs-review",
      body: "This contribution should fail because the problem does not exist in the workspace."
    }
  });
  assert.equal(unknownProblemContribution.status, 404);

  const foreignAssignment = await request("/api/assignments", {
    method: "POST",
    body: {
      problem_id: problemId,
      task: "independent-review",
      prompt: "Assignment owned by a different seeded agent.",
      desired_output: ["review"],
      assigned_agents: [seedAgentId]
    }
  });
  assert.equal(foreignAssignment.status, 201);
  created.assignmentIds.push(foreignAssignment.payload.assignment.id);
  created.postIds.push(foreignAssignment.payload.post.id);

  const foreignAssignmentContext = await request(
    `/api/assignments/${encodeURIComponent(foreignAssignment.payload.assignment.id)}`,
    {
      bearer: agentKey
    }
  );
  assert.equal(foreignAssignmentContext.status, 403);

  const foreignAssignmentContribution = await request("/api/contributions", {
    method: "POST",
    bearer: agentKey,
    body: {
      problem_id: problemId,
      assignment_id: foreignAssignment.payload.assignment.id,
      type: "attempt",
      evidence_level: "speculative",
      status: "needs-review",
      body: "This agent should not be able to attach work to another agent's assignment."
    }
  });
  assert.equal(foreignAssignmentContribution.status, 403);

  const mismatchedAssignmentContribution = await request("/api/contributions", {
    method: "POST",
    bearer: agentKey,
    body: {
      problem_id: seedProblemId,
      assignment_id: assignmentId,
      type: "attempt",
      evidence_level: "speculative",
      status: "needs-review",
      body: "Assignment and problem mismatch should be rejected."
    }
  });
  assert.equal(mismatchedAssignmentContribution.status, 422);

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

  const listedArtifacts = await request("/api/artifacts", {
    bearer: agentKey
  });
  assert.equal(listedArtifacts.status, 200);
  assert.ok(listedArtifacts.payload.artifacts.some((artifact) => artifact.id === artifactUpload.payload.artifact.id));

  const listedProblemArtifacts = await request(`/api/artifacts?problem_id=${encodeURIComponent(problemId)}`, {
    bearer: agentKey
  });
  assert.equal(listedProblemArtifacts.status, 200);
  assert.ok(listedProblemArtifacts.payload.artifacts.every((artifact) => artifact.problem_id === problemId));
  assert.ok(listedProblemArtifacts.payload.artifacts.some((artifact) => artifact.id === artifactUpload.payload.artifact.id));

  const unknownProblemArtifacts = await request(`/api/artifacts?problem_id=${encodeURIComponent(`problem:missing-${smokeRunId}`)}`, {
    bearer: agentKey
  });
  assert.equal(unknownProblemArtifacts.status, 404);

  const artifactDownload = await request(`/api/artifacts/${encodeURIComponent(artifactUpload.payload.artifact.id)}/file`, {
    bearer: agentKey,
    parseJson: false
  });
  assert.equal(artifactDownload.status, 200);
  assert.equal(await artifactDownload.response.text(), "release smoke artifact\n");

  const wrongProblemArtifactContribution = await request("/api/contributions", {
    method: "POST",
    bearer: agentKey,
    body: {
      problem_id: seedProblemId,
      assignment_id: "",
      type: "attempt",
      evidence_level: "speculative",
      status: "needs-review",
      body: "This should not be able to cite an artifact from another problem.",
      artifact_id: artifactUpload.payload.artifact.id
    }
  });
  assert.equal(wrongProblemArtifactContribution.status, 422);

  const unknownVerifierContribution = await request("/api/contributions", {
    method: "POST",
    bearer: agentKey,
    body: {
      problem_id: problemId,
      assignment_id: assignmentId,
      type: "attempt",
      evidence_level: "speculative",
      status: "needs-review",
      body: "This claim should not be queued to a missing verifier.",
      claim_type: "lemma",
      claim_statement: "A missing verifier should be rejected.",
      verifier: "agent:missing-verifier"
    }
  });
  assert.equal(unknownVerifierContribution.status, 404);

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

  const reviewAgentWork = await request("/api/work", {
    bearer: agentKey
  });
  assert.equal(reviewAgentWork.status, 200);
  assert.ok(reviewAgentWork.payload.verifications.some((verification) => verification.id === reviewContribution.payload.verification.id));
  assert.ok(
    reviewAgentWork.payload.items.some(
      (item) => item.kind === "verification" && item.id === reviewContribution.payload.verification.id
    )
  );

  const reviewContext = await request(
    `/api/verifications/${encodeURIComponent(reviewContribution.payload.verification.id)}`,
    {
      bearer: agentKey
    }
  );
  assert.equal(reviewContext.status, 200);
  assert.equal(reviewContext.payload.verification.id, reviewContribution.payload.verification.id);
  assert.equal(reviewContext.payload.claim.id, reviewContribution.payload.claim.id);
  assert.equal(reviewContext.payload.problem.id, problemId);
  assert.ok(reviewContext.payload.linked_posts.some((post) => post.id === reviewContribution.payload.post.id));
  assert.ok(reviewContext.payload.assignments.some((assignment) => assignment.id === assignmentId));
  assert.ok(reviewContext.payload.verification_jobs.some((job) => job.id === reviewContribution.payload.verificationJob.id));

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

  const wrongProblemVerificationArtifact = await request(
    `/api/verifications/${encodeURIComponent(reviewContribution.payload.verification.id)}`,
    {
      method: "PATCH",
      bearer: agentKey,
      body: {
        status: "passed",
        artifact_id: "artifact-magma-order5-log"
      }
    }
  );
  assert.equal(wrongProblemVerificationArtifact.status, 422);

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

  const contributedAssignmentContext = await request(`/api/assignments/${encodeURIComponent(assignmentId)}`, {
    bearer: agentKey
  });
  assert.equal(contributedAssignmentContext.status, 200);
  assert.ok(contributedAssignmentContext.payload.posts.some((post) => post.id === contribution.payload.post.id));
  assert.ok(contributedAssignmentContext.payload.claims.some((claim) => claim.id === contribution.payload.claim.id));
  assert.ok(
    contributedAssignmentContext.payload.verifications.some(
      (verification) => verification.id === contribution.payload.verification.id
    )
  );
  assert.ok(
    contributedAssignmentContext.payload.verification_jobs.some(
      (job) => job.id === contribution.payload.verificationJob.id
    )
  );

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

  const unauthorizedVerificationContext = await request(
    `/api/verifications/${encodeURIComponent(contribution.payload.verification.id)}`,
    {
      bearer: agentKey
    }
  );
  assert.equal(unauthorizedVerificationContext.status, 403);

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
      "human session same-origin writes",
      "problem creation",
      "problem context fetch",
      "agent profile creation",
      "agent status heartbeat",
      "agent key create/rotate/revoke",
      "disabled agent key lockout",
      "principal attribution provenance",
      "assignment creation",
      "blank id validation",
      "problem reference existence",
      "assignment agent existence",
      "agent assignment fetch",
      "agent work inbox",
      "focused assignment context",
      "agent assignment status updates",
      "human assignment closeout",
      "contribution assignment access",
      "contribution dependency provenance",
      "contribution feed discovery",
      "artifact reference provenance",
      "verifier agent existence",
      "artifact discovery",
      "artifact upload/download",
      "agent contribution",
      "verification assignment authorization",
      "focused verification context",
      "assigned verifier result update",
      "agent-review trust gate",
      "verification worker promotion",
      "problem exports"
    ]
  }, null, 2));
}

async function request(path, options = {}) {
  const method = options.method || "GET";
  const sessionWriteOrigin =
    cookie && options.auth !== false && !options.bearer && !["GET", "HEAD", "OPTIONS"].includes(method)
      ? { origin: baseOrigin }
      : {};
  const headers = {
    ...(options.body ? { "content-type": "application/json" } : {}),
    ...(cookie && options.auth !== false && !options.bearer ? { cookie } : {}),
    ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
    ...sessionWriteOrigin,
    ...(options.headers || {})
  };
  const response = await fetch(`${baseUrl}${path}`, {
    method,
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

async function setAgentStatus(targetAgentId, status) {
  await transaction(async (client) => {
    await client.query("update agents set status = $2 where id = $1", [targetAgentId, status]);
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
