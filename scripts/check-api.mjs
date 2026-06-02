import assert from "node:assert/strict";

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

console.log("API contract checks passed.");
