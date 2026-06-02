import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { materializeArtifactContent, openArtifactFile } from "../server/artifact-storage.js";
import { generateSessionToken, hashPassword, verifyPassword } from "../server/auth.js";
import { assertWebRuntimeConfig, assertWorkerRuntimeConfig, secureCookiesEnabled } from "../server/config.js";
import { applyVerificationPatch, buildContribution } from "../server/domain.js";
import { requestBodyLimitBytes, resolveStaticFilePath } from "../server/http.js";
import { generateAgentApiKey, stableKeyHash } from "../server/ids.js";
import { clientIp } from "../server/ops.js";
import { assertProblemInput } from "../server/validation.js";
import { evaluateExecution, stdoutHash } from "../server/verification-worker.js";

const generatedKey = generateAgentApiKey();
assert.match(generatedKey, /^mfa_[A-Za-z0-9_-]{32}$/);
assert.match(stableKeyHash(generatedKey), /^[a-f0-9]{64}$/);

const passwordHash = hashPassword("correct horse battery staple");
assert.equal(verifyPassword("correct horse battery staple", passwordHash), true);
assert.equal(verifyPassword("wrong password", passwordHash), false);
assert.match(generateSessionToken(), /^mfa_session_[A-Za-z0-9_-]{43}$/);

assert.doesNotThrow(() =>
  assertWebRuntimeConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://math_for_agents:strong-password@db:5432/math_for_agents",
    ARTIFACT_STORAGE_DIR: "/data/artifacts",
    ARTIFACT_MAX_BYTES: "10000000",
    MFA_COOKIE_SECURE: "true",
    MFA_HUMAN_KEY: "mfa_private_beta_key_32_chars",
    MFA_HUMAN_PASSWORD: "long-private-beta-password"
  })
);

assert.throws(
  () =>
    assertWebRuntimeConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://math_for_agents:math_for_agents@127.0.0.1:55432/math_for_agents",
      ARTIFACT_STORAGE_DIR: "artifacts",
      ARTIFACT_MAX_BYTES: "10000000",
      MFA_COOKIE_SECURE: "false",
      MFA_HUMAN_KEY: "mfa_dev_human_key",
      MFA_HUMAN_PASSWORD: "mfa_dev_password"
    }),
  /Runtime config is invalid/
);

assert.doesNotThrow(() =>
  assertWorkerRuntimeConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://math_for_agents:strong-password@db:5432/math_for_agents",
    ARTIFACT_STORAGE_DIR: "/data/artifacts",
    ARTIFACT_MAX_BYTES: "10000000",
    MFA_WORKER_RUNNER: "docker"
  })
);

assert.throws(
  () =>
    assertWorkerRuntimeConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://math_for_agents:strong-password@db:5432/math_for_agents",
      ARTIFACT_STORAGE_DIR: "/data/artifacts",
      ARTIFACT_MAX_BYTES: "10000000",
      MFA_WORKER_RUNNER: "disabled"
    }),
  /must not be disabled/
);

assert.equal(secureCookiesEnabled({ NODE_ENV: "production", MFA_COOKIE_SECURE: "true" }), true);
assert.equal(secureCookiesEnabled({ NODE_ENV: "production", MFA_ALLOW_INSECURE_COOKIES: "true" }), false);
assert.equal(secureCookiesEnabled({ NODE_ENV: "development" }), false);

const forwardedRequest = {
  headers: { "x-forwarded-for": "203.0.113.8, 10.0.0.1" },
  socket: { remoteAddress: "198.51.100.4" }
};
assert.equal(clientIp(forwardedRequest, { MFA_TRUST_PROXY: "false" }), "198.51.100.4");
assert.equal(clientIp(forwardedRequest, { MFA_TRUST_PROXY: "true" }), "203.0.113.8");

const staticRoot = path.join(os.tmpdir(), "math-for-agents-static-root");
assert.equal(resolveStaticFilePath("/", staticRoot), path.join(staticRoot, "index.html"));
assert.equal(resolveStaticFilePath("/src/app.js", staticRoot), path.join(staticRoot, "src/app.js"));
assert.equal(resolveStaticFilePath("/openapi.json", staticRoot), path.join(staticRoot, "openapi.json"));
assert.throws(() => resolveStaticFilePath("/.env", staticRoot), /not found/);
assert.throws(() => resolveStaticFilePath("/server/db.js", staticRoot), /not found/);
assert.throws(() => resolveStaticFilePath("/docs/.env", staticRoot), /not found/);
assert.throws(() => resolveStaticFilePath("/%2e%2e/math-for-agents-evil/.env", staticRoot), /forbidden/);

assert.equal(requestBodyLimitBytes({ MAX_JSON_BYTES: "12345", ARTIFACT_MAX_BYTES: "1000" }), 12_345);
assert.equal(requestBodyLimitBytes({ ARTIFACT_MAX_BYTES: "1000" }), 67_036);
assert.throws(() => requestBodyLimitBytes({ MAX_JSON_BYTES: "0" }), /MAX_JSON_BYTES/);

assert.doesNotThrow(() =>
  assertProblemInput({
    title: "New search target",
    area: "Finite algebra",
    summary: "Find a small witness or prove none exists.",
    priority: "high",
    tags: ["magma", "search"]
  })
);
assert.throws(
  () =>
    assertProblemInput({
      title: "Bad target",
      area: "Finite algebra",
      summary: "This should fail.",
      priority: "urgent"
    }),
  /priority must be one of/
);
assert.throws(() => assertProblemInput(null), /request body must be a JSON object/);

const workerPass = evaluateExecution(
  { payload: { replay: { output_hash: stdoutHash("ok\n") } } },
  { exit_code: 0, timed_out: false, stdout: "ok\n" }
);
assert.equal(workerPass.verification_status, "passed");

const workerMismatch = evaluateExecution(
  { payload: { replay: { output_hash: stdoutHash("expected\n") } } },
  { exit_code: 0, timed_out: false, stdout: "actual\n" }
);
assert.equal(workerMismatch.verification_status, "failed");

const workerNeedsDetail = evaluateExecution(
  { payload: { replay: {} } },
  { exit_code: 2, timed_out: false, stdout: "" }
);
assert.equal(workerNeedsDetail.verification_status, "needs-more-detail");

assert.throws(
  () =>
    buildContribution({
      agent: "agent:finite-model-searcher",
      problem_id: "finite-magma-identity-search",
      type: "attempt",
      evidence_level: "computational",
      status: "open",
      body: "Search finished without a replay command."
    }),
  /require replay.command/
);

const contribution = buildContribution(
  {
    agent: "agent:finite-model-searcher",
    problem_id: "finite-magma-identity-search",
    assignment_id: "assignment-finite-magma-001",
    type: "counterexample",
    evidence_level: "computational",
    status: "needs-review",
    body: "Found a candidate counterexample under seed 7.",
    claim_statement: "A candidate counterexample exists under the replayed search.",
    artifact_kind: "computation-log",
    artifact_title: "seed 7 replay",
    artifact_path: "artifacts/seed-7.log",
    replay: {
      command: "python search.py --seed 7",
      seed: "7",
      env: "python 3.12",
      output_hash: "sha256:test"
    }
  },
  {
    postId: "post-test",
    claimId: "claim-test",
    verificationId: "verify-test",
    verificationJobId: "job-test",
    now: "2026-06-02T00:00:00.000Z"
  }
);

assert.equal(contribution.post.replay.command, "python search.py --seed 7");
assert.equal(contribution.artifact.content_hash, "sha256:test");
assert.equal(contribution.claim.status, "needs-review");
assert.equal(contribution.verification.method, "replay");
assert.equal(contribution.verificationJob.status, "waiting-for-replay");

assert.throws(
  () =>
    applyVerificationPatch(
      { id: "verify-test", claim_id: "claim-test", method: "replay", status: "queued", priority: "high" },
      [{ id: "verify-test", claim_id: "claim-test", method: "replay", status: "queued", priority: "high" }],
      { status: "passed" }
    ),
  /require a backing artifact/
);

const replayPass = applyVerificationPatch(
  { id: "verify-test", claim_id: "claim-test", method: "replay", status: "queued", priority: "high" },
  [{ id: "verify-test", claim_id: "claim-test", method: "replay", status: "queued", priority: "high" }],
  { status: "passed", artifact_id: "artifact-test" }
);

assert.equal(replayPass.claimPatch.status, "accepted");
assert.equal(replayPass.claimPatch.trust_tier, "independently-replayed");

const agentReviewPass = applyVerificationPatch(
  { id: "verify-agent", claim_id: "claim-agent", method: "agent-review", status: "queued", priority: "medium" },
  [{ id: "verify-agent", claim_id: "claim-agent", method: "agent-review", status: "queued", priority: "medium" }],
  { status: "passed" }
);

assert.equal(agentReviewPass.claimPatch.status, "needs-review");
assert.equal(agentReviewPass.claimPatch.trust_tier, "agent-reviewed");

const artifactStorageDir = await mkdtemp(path.join(os.tmpdir(), "mfa-artifacts-"));
process.env.ARTIFACT_STORAGE_DIR = artifactStorageDir;

const storedArtifact = await materializeArtifactContent(
  "workspace:default",
  {
    id: "artifact-storage-test",
    problem_id: "finite-magma-identity-search",
    owner: "agent:verifier",
    kind: "replay-log",
    title: "storage test",
    summary: "stored by check-api",
    path: "#",
    metadata: {}
  },
  {
    content_text: "proof trace bytes",
    file_name: "trace.txt",
    content_type: "text/plain"
  }
);

assert.equal(storedArtifact.path, "/api/artifacts/artifact-storage-test/file");
assert.match(storedArtifact.content_hash, /^sha256:/);
assert.equal(storedArtifact.metadata.storage.driver, "local-file");

const openedArtifact = await openArtifactFile(storedArtifact);
assert.equal(openedArtifact.contentType, "text/plain");
assert.equal(openedArtifact.fileName, "trace.txt");
assert.equal(await readStreamText(openedArtifact.stream), "proof trace bytes");

await assert.rejects(
  () =>
    materializeArtifactContent(
      "workspace:default",
      {
        id: "artifact-storage-bad-hash",
        problem_id: "finite-magma-identity-search",
        owner: "agent:verifier",
        kind: "replay-log",
        title: "storage bad hash",
        summary: "bad hash",
        path: "#",
        content_hash: "sha256:not-the-real-hash",
        metadata: {}
      },
      {
        content_text: "proof trace bytes",
        file_name: "bad-hash.txt"
      }
    ),
  /content_hash does not match/
);

await rm(artifactStorageDir, { recursive: true, force: true });

console.log("API contract checks passed.");

async function readStreamText(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
