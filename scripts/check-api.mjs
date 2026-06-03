import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { materializeArtifactContent, openArtifactFile } from "../server/artifact-storage.js";
import { generateSessionToken, hashPassword, verifyPassword } from "../server/auth.js";
import { assertWebRuntimeConfig, assertWorkerRuntimeConfig, secureCookiesEnabled } from "../server/config.js";
import { applyVerificationPatch, buildContribution } from "../server/domain.js";
import {
  allowedSessionOrigins,
  responseHeaders,
  requestBodyLimitBytes,
  resolveStaticFilePath,
  sessionWriteOriginCheck
} from "../server/http.js";
import { generateAgentApiKey, stableKeyHash } from "../server/ids.js";
import { buildErrorLogEntry, clientIp, logErrorEvent } from "../server/ops.js";
import { formatProblemExport, problemExportFormats } from "../server/problem-export.js";
import { assertAgentInput, assertAgentPatch, assertAssignmentPatch, assertProblemInput } from "../server/validation.js";
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
    ARTIFACT_STORAGE_DRIVER: "local-file",
    ARTIFACT_STORAGE_DIR: "/data/artifacts",
    ARTIFACT_MAX_BYTES: "10000000",
    MFA_COOKIE_SECURE: "true",
    MFA_HUMAN_KEY: "mfa_private_beta_key_32_chars",
    MFA_HUMAN_PASSWORD: "long-private-beta-password",
    MFA_DEFAULT_VERIFIER_AGENT_ID: "agent:verifier"
  })
);

assert.doesNotThrow(() =>
  assertWebRuntimeConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://math_for_agents:strong-password@db:5432/math_for_agents",
    ARTIFACT_STORAGE_DRIVER: "vercel-blob",
    BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_private_beta_token",
    ARTIFACT_MAX_BYTES: "10000000",
    MFA_COOKIE_SECURE: "true",
    MFA_HUMAN_KEY: "mfa_private_beta_key_32_chars",
    MFA_HUMAN_PASSWORD: "long-private-beta-password",
    MFA_DEFAULT_VERIFIER_AGENT_ID: "agent:verifier"
  })
);

assert.throws(
  () =>
    assertWebRuntimeConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://math_for_agents:strong-password@db:5432/math_for_agents",
      ARTIFACT_STORAGE_DRIVER: "vercel-blob",
      ARTIFACT_MAX_BYTES: "10000000",
      MFA_COOKIE_SECURE: "true",
      MFA_DEFAULT_VERIFIER_AGENT_ID: "agent:verifier"
    }),
  /BLOB_READ_WRITE_TOKEN/
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
    MFA_DEFAULT_VERIFIER_AGENT_ID: "agent:verifier",
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

const errorContext = {
  request_id: "req-error-test",
  started_at: Date.parse("2026-06-02T00:00:00.000Z"),
  method: "POST",
  path: "/api/contributions",
  principal: {
    kind: "agent",
    id: "agent:finite-model-searcher",
    workspace_id: "workspace:default",
    auth_method: "agent-key",
    secret: "must-not-log"
  }
};
const internalError = Object.assign(new Error("database connection refused"), { code: "ECONNREFUSED" });
const errorEntry = buildErrorLogEntry(errorContext, internalError, 500, "internal server error", {
  now: "2026-06-02T00:00:01.250Z"
});
assert.deepEqual(errorEntry, {
  at: "2026-06-02T00:00:01.250Z",
  level: "error",
  event: "http_error",
  request_id: "req-error-test",
  method: "POST",
  path: "/api/contributions",
  status: 500,
  duration_ms: 1250,
  public_error: "internal server error",
  error: {
    name: "Error",
    message: "database connection refused",
    code: "ECONNREFUSED"
  },
  principal: {
    kind: "agent",
    id: "agent:finite-model-searcher",
    workspace_id: "workspace:default",
    auth_method: "agent-key"
  }
});

const emittedErrorLogs = [];
assert.equal(
  logErrorEvent(errorContext, internalError, 500, "internal server error", {
    env: {},
    now: "2026-06-02T00:00:01.250Z",
    sink: (line) => emittedErrorLogs.push(JSON.parse(line))
  }).request_id,
  "req-error-test"
);
assert.equal(emittedErrorLogs.length, 1);
assert.equal(logErrorEvent(errorContext, internalError, 500, "internal server error", { env: { MFA_LOG_ERRORS: "false" } }), null);
assert.equal(logErrorEvent(errorContext, new Error("bad request"), 400, "bad request", { env: {} }), null);

const staticRoot = path.join(os.tmpdir(), "math-for-agents-static-root");
assert.equal(resolveStaticFilePath("/", staticRoot), path.join(staticRoot, "index.html"));
assert.equal(resolveStaticFilePath("/src/app.js", staticRoot), path.join(staticRoot, "src/app.js"));
assert.equal(
  resolveStaticFilePath("/examples/logs/finite-magma-order5.txt", staticRoot),
  path.join(staticRoot, "examples/logs/finite-magma-order5.txt")
);
assert.equal(resolveStaticFilePath("/agent-manifest.json", staticRoot), path.join(staticRoot, "agent-manifest.json"));
assert.equal(resolveStaticFilePath("/.well-known/agent-manifest.json", staticRoot), path.join(staticRoot, "agent-manifest.json"));
assert.equal(resolveStaticFilePath("/.well-known/math-for-agents.json", staticRoot), path.join(staticRoot, "agent-manifest.json"));
assert.equal(resolveStaticFilePath("/openapi.json", staticRoot), path.join(staticRoot, "openapi.json"));
assert.equal(resolveStaticFilePath("/llms.txt", staticRoot), path.join(staticRoot, "llms.txt"));
assert.equal(resolveStaticFilePath("/.well-known/llms.txt", staticRoot), path.join(staticRoot, "llms.txt"));
assert.throws(() => resolveStaticFilePath("/.env", staticRoot), /not found/);
assert.throws(() => resolveStaticFilePath("/.well-known/.env", staticRoot), /not found/);
assert.throws(() => resolveStaticFilePath("/logs/finite-magma-order5.txt", staticRoot), /not found/);
assert.throws(() => resolveStaticFilePath("/server/db.js", staticRoot), /not found/);
assert.throws(() => resolveStaticFilePath("/docs/.env", staticRoot), /not found/);
assert.throws(() => resolveStaticFilePath("/%2e%2e/math-for-agents-evil/.env", staticRoot), /forbidden/);

const headers = responseHeaders({ "content-type": "application/json; charset=utf-8" });
assert.equal(headers["content-type"], "application/json; charset=utf-8");
assert.equal(headers["x-content-type-options"], "nosniff");
assert.equal(headers["x-frame-options"], "DENY");
assert.equal(headers["referrer-policy"], "no-referrer");
assert.equal(headers["cross-origin-opener-policy"], "same-origin");
assert.equal(headers["cross-origin-resource-policy"], "same-origin");
assert.match(headers["content-security-policy"], /default-src 'self'/);
assert.match(headers["content-security-policy"], /script-src 'self'/);
assert.match(headers["content-security-policy"], /object-src 'none'/);
assert.match(headers["content-security-policy"], /frame-ancestors 'none'/);

assert.equal(requestBodyLimitBytes({ MAX_JSON_BYTES: "12345", ARTIFACT_MAX_BYTES: "1000" }), 12_345);
assert.equal(requestBodyLimitBytes({ ARTIFACT_MAX_BYTES: "1000" }), 67_036);
assert.throws(() => requestBodyLimitBytes({ MAX_JSON_BYTES: "0" }), /MAX_JSON_BYTES/);

const sameOriginWrite = {
  headers: {
    host: "127.0.0.1:4173",
    origin: "http://127.0.0.1:4173"
  }
};
assert.deepEqual(allowedSessionOrigins(sameOriginWrite, { MFA_COOKIE_SECURE: "false" }), ["http://127.0.0.1:4173"]);
assert.equal(sessionWriteOriginCheck(sameOriginWrite, { MFA_COOKIE_SECURE: "false" }).ok, true);
assert.equal(
  sessionWriteOriginCheck(
    { headers: { host: "127.0.0.1:4173", origin: "https://evil.example" } },
    { MFA_COOKIE_SECURE: "false" }
  ).ok,
  false
);
assert.equal(
  sessionWriteOriginCheck(
    { headers: { host: "internal:4173", origin: "https://math-for-agents.example.com" } },
    { MFA_PUBLIC_ORIGIN: "https://math-for-agents.example.com", MFA_COOKIE_SECURE: "true" }
  ).ok,
  true
);
assert.equal(
  sessionWriteOriginCheck(
    { headers: { host: "math-for-agents.example.com", referer: "https://math-for-agents.example.com/#/keys" } },
    { MFA_COOKIE_SECURE: "true" }
  ).ok,
  true
);
assert.equal(sessionWriteOriginCheck({ headers: { host: "127.0.0.1:4173" } }, { MFA_COOKIE_SECURE: "false" }).ok, false);

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

assert.doesNotThrow(() =>
  assertAgentInput({
    name: "Verifier smoke",
    role: "Independent replay",
    status: "idle",
    domain: "Finite algebra",
    reputation: 0,
    tools: ["python", "lean"]
  })
);
assert.throws(
  () =>
    assertAgentInput({
      name: "Bad agent",
      role: "Invalid",
      status: "sleeping"
    }),
  /status must be one of/
);
assert.throws(
  () =>
    assertAgentInput({
      name: "Bad reputation",
      role: "Invalid",
      reputation: 101
    }),
  /reputation must be an integer from 0 to 100/
);
assert.doesNotThrow(() => assertAgentPatch({ status: "running", current_task: "Working assignment smoke" }));
assert.throws(() => assertAgentPatch({ status: "sleeping" }), /status must be one of/);
assert.throws(() => assertAgentPatch({ unknown: "field" }), /unknown field/);

assert.doesNotThrow(() => assertAssignmentPatch({ status: "running" }));
assert.throws(() => assertAssignmentPatch({ status: "waiting" }), /status must be one of/);
assert.throws(() => assertAssignmentPatch({ status: "running", agent: "agent:test" }), /unknown field/);

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

assert.deepEqual(problemExportFormats(), ["markdown", "lean-issue", "paper-notes"]);
const exportContext = {
  problem: {
    id: "finite-magma-identity-search",
    title: "Finite magma identity search",
    area: "Finite algebra",
    status: "active",
    priority: "high",
    summary: "Find a small model or prove none exists.",
    why_it_matters: "It gives agents a concrete proof-search target.",
    tags: ["magma", "search"]
  },
  assignments: [
    {
      id: "assignment-test",
      task: "search",
      status: "running",
      assigned_agents: ["agent:finite-model-searcher"]
    }
  ],
  claims: [
    {
      id: "claim-test",
      statement: "No counterexample exists below order 5.",
      status: "accepted",
      trust_tier: "independently-replayed",
      verification_state: "passed"
    }
  ],
  posts: [
    {
      id: "post-test",
      type: "attempt",
      agent: "agent:finite-model-searcher",
      assignment_id: "assignment-test",
      status: "needs-review",
      evidence_level: "computational",
      body: "Search completed with replayable output."
    }
  ],
  artifacts: [
    {
      id: "artifact-test",
      title: "Replay log",
      kind: "replay-log",
      owner: "agent:verifier",
      path: "/api/artifacts/artifact-test/file"
    }
  ],
  verifications: [
    {
      id: "verify-test",
      claim_id: "claim-test",
      assigned_agent: "agent:verifier",
      method: "replay",
      status: "passed",
      artifact_id: "artifact-test"
    }
  ]
};
assert.match(formatProblemExport(exportContext, "markdown"), /# Finite magma identity search/);
assert.match(formatProblemExport(exportContext, "lean-issue"), /namespace finite_magma_identity_search/);
assert.match(formatProblemExport(exportContext, "paper-notes"), /## Results Ledger/);
assert.throws(() => formatProblemExport(exportContext, "pdf"), /format must be one of/);

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

const originalArtifactStorageDriver = process.env.ARTIFACT_STORAGE_DRIVER;
process.env.ARTIFACT_STORAGE_DRIVER = "vercel-blob";
const blobClientCalls = [];
const fakeBlobClient = {
  async put(pathname, body, options) {
    blobClientCalls.push({ type: "put", pathname, body: Buffer.from(body).toString("utf8"), options });
    return {
      pathname,
      contentType: options.contentType,
      etag: "\"blob-etag\""
    };
  },
  async get(pathname, options) {
    blobClientCalls.push({ type: "get", pathname, options });
    return {
      statusCode: 200,
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("blob proof bytes"));
          controller.close();
        }
      }),
      blob: {
        size: 16,
        contentType: "text/plain"
      }
    };
  }
};

const blobArtifact = await materializeArtifactContent(
  "workspace:default",
  {
    id: "artifact-blob-test",
    problem_id: "finite-magma-identity-search",
    owner: "agent:verifier",
    kind: "replay-log",
    title: "blob storage test",
    summary: "stored by check-api",
    path: "#",
    metadata: {}
  },
  {
    content_text: "blob proof bytes",
    file_name: "blob-trace.txt",
    content_type: "text/plain"
  },
  { blobClient: fakeBlobClient }
);

assert.equal(blobArtifact.path, "/api/artifacts/artifact-blob-test/file");
assert.equal(blobArtifact.metadata.storage.driver, "vercel-blob");
assert.equal(blobArtifact.metadata.storage.access, "private");
assert.equal(blobArtifact.metadata.storage.key, "workspace-default/artifact-blob-test-blob-trace.txt");
assert.equal(blobClientCalls[0].type, "put");
assert.equal(blobClientCalls[0].options.access, "private");
assert.equal(blobClientCalls[0].options.addRandomSuffix, false);

const openedBlobArtifact = await openArtifactFile(blobArtifact, { blobClient: fakeBlobClient });
assert.equal(openedBlobArtifact.contentType, "text/plain");
assert.equal(openedBlobArtifact.fileName, "blob-trace.txt");
assert.equal(await readStreamText(openedBlobArtifact.stream), "blob proof bytes");
assert.deepEqual(blobClientCalls[1], {
  type: "get",
  pathname: "workspace-default/artifact-blob-test-blob-trace.txt",
  options: { access: "private" }
});
if (originalArtifactStorageDriver === undefined) delete process.env.ARTIFACT_STORAGE_DRIVER;
else process.env.ARTIFACT_STORAGE_DRIVER = originalArtifactStorageDriver;

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
