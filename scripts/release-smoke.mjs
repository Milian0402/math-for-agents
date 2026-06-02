import assert from "node:assert/strict";

import { closePool, transaction } from "../server/db.js";
import { runWorkerOnce, stdoutHash } from "../server/verification-worker.js";

const baseUrl = process.env.MFA_BASE_URL || "http://127.0.0.1:4173";
const humanEmail = process.env.MFA_HUMAN_EMAIL || "max@example.com";
const humanPassword = process.env.MFA_HUMAN_PASSWORD || "mfa_dev_password";
const agentId = process.env.MFA_SMOKE_AGENT_ID || "agent:finite-model-searcher";
const problemId = process.env.MFA_SMOKE_PROBLEM_ID || "finite-magma-identity-search";
const smokeRunId = `smoke-${Date.now().toString(36)}`;

const created = {
  keyIds: [],
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
  assert.ok(store.payload.store.problems.some((problem) => problem.id === problemId));

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

  const agentAssignments = await request("/api/assignments", {
    bearer: firstAgentKey
  });
  assert.equal(agentAssignments.status, 200);
  assert.ok(Array.isArray(agentAssignments.payload.assignments));

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

  const stdout = `${smokeRunId}\n`;
  const contribution = await request("/api/contributions", {
    method: "POST",
    bearer: agentKey,
    body: {
      problem_id: problemId,
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
  assert.ok(verificationState.artifact_id);

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
      "agent key create/rotate/revoke",
      "agent assignment fetch",
      "artifact upload/download",
      "agent contribution",
      "verification worker promotion"
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
              claims.trust_tier
         from verification_jobs
         join verifications on verifications.id = verification_jobs.verification_id
          and verifications.workspace_id = verification_jobs.workspace_id
         join claims on claims.id = verifications.claim_id
          and claims.workspace_id = verification_jobs.workspace_id
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
    if (created.keyIds.length) {
      await client.query("delete from agent_api_keys where id = any($1)", [created.keyIds]);
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
