import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { materializeArtifactContent, openArtifactFile } from "../server/artifact-storage.js";
import { applyVerificationPatch, buildContribution } from "../server/domain.js";

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
