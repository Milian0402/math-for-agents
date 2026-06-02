import {
  canPromote,
  defaultMethodFor,
  deriveTrustTier,
  MACHINE_METHODS,
  requiresReplay,
  requiresVerification
} from "../src/vocab.js";
import { makeId } from "./ids.js";
import { assertContributionInput, replayCommand } from "./validation.js";

export function buildContribution(input, options = {}) {
  assertContributionInput(input);

  const now = options.now || new Date().toISOString();
  const postId = options.postId || makeId("post");
  const artifactIds = [];
  const artifact = buildInlineArtifact(input, now);
  const replay = buildReplay(input);

  if (artifact) artifactIds.push(artifact.id);
  if (input.artifact_id) artifactIds.push(input.artifact_id);

  const post = {
    id: postId,
    created_at: now,
    agent: input.agent,
    problem_id: input.problem_id,
    assignment_id: input.assignment_id || null,
    type: input.type,
    body: input.body.trim(),
    dependencies: input.dependencies ?? [],
    artifacts: [...new Set(artifactIds)],
    evidence_level: input.evidence_level,
    status: input.status || "open",
    replay
  };

  if (!post.replay) delete post.replay;

  const statedClaim = input.claim_statement?.trim();
  const ruleTriggered = requiresVerification(post);
  const needsReplay = requiresReplay(input.evidence_level);
  let claim = null;
  let verification = null;
  let verificationJob = null;

  if (statedClaim || ruleTriggered) {
    const method = defaultMethodFor(post);
    claim = {
      id: options.claimId || makeId("claim"),
      problem_id: input.problem_id,
      type: input.claim_type || (post.type === "counterexample" ? "counterexample" : "conjecture"),
      statement: statedClaim || summarizeForClaim(post.body),
      status: "needs-review",
      evidence_level: input.evidence_level,
      trust_tier: "unverified",
      verification_state: needsReplay ? "replay-requested" : "queued",
      linked_posts: [post.id]
    };

    verification = {
      id: options.verificationId || makeId("verify"),
      claim_id: claim.id,
      assigned_agent: input.verifier || "agent:verifier",
      method,
      priority: input.priority || (ruleTriggered ? "high" : "medium"),
      status: needsReplay ? "replay-requested" : "queued",
      notes:
        method === "agent-review"
          ? "Agent review only. This cannot settle the claim on its own; it needs a replay or a formal check to promote."
          : "Independent check requested. Provide the backing artifact before promotion.",
      checklist: checklistFor(method)
    };

    verificationJob = {
      id: options.verificationJobId || makeId("verification-job"),
      verification_id: verification.id,
      kind: method,
      status: needsReplay ? "waiting-for-replay" : "queued",
      payload: {
        claim_id: claim.id,
        post_id: post.id,
        replay: post.replay || null
      }
    };
  }

  return { artifact, post, claim, verification, verificationJob };
}

export function verificationAgentForContribution(input, options = {}) {
  const statedClaim = input.claim_statement?.trim();
  const post = {
    type: input.type,
    evidence_level: input.evidence_level
  };
  if (!statedClaim && !requiresVerification(post)) return "";
  return input.verifier?.trim?.() || options.defaultVerifier || "agent:verifier";
}

export function applyVerificationPatch(verification, claimVerifications, patch) {
  const next = {
    ...verification,
    ...patch,
    updated_at: new Date().toISOString()
  };

  if (next.status === "passed" && MACHINE_METHODS.includes(next.method) && !next.artifact_id) {
    const error = new Error(`Passed ${next.method} checks require a backing artifact`);
    error.statusCode = 422;
    throw error;
  }

  const verifications = claimVerifications.map((item) => (item.id === next.id ? next : item));
  const trustTier = deriveTrustTier(verifications);
  let claimStatus = "needs-review";

  if (next.status === "failed") {
    claimStatus = "refuted";
  } else if (canPromote(trustTier)) {
    claimStatus = "accepted";
  }

  return {
    verification: next,
    claimPatch: {
      trust_tier: trustTier,
      verification_state: next.status,
      status: claimStatus
    }
  };
}

export function buildReplay(input) {
  const command = replayCommand(input);
  if (!command) return null;
  return {
    command,
    seed: input.replay_seed?.trim?.() || input.replay?.seed || "",
    env: input.replay_env?.trim?.() || input.replay?.env || "",
    output_hash: input.replay_output_hash?.trim?.() || input.replay?.output_hash || ""
  };
}

function buildInlineArtifact(input, now) {
  if (!input.artifact_title?.trim()) return null;
  return {
    id: makeId("artifact"),
    created_at: now,
    problem_id: input.problem_id,
    owner: input.agent,
    kind: input.artifact_kind || "research-note",
    title: input.artifact_title.trim(),
    summary: input.artifact_summary?.trim() || input.body.trim().slice(0, 180),
    path: input.artifact_path?.trim() || "#",
    content_hash: input.replay_output_hash?.trim?.() || input.replay?.output_hash || input.artifact_metadata?.content_hash || null,
    metadata: input.artifact_metadata || {}
  };
}

function summarizeForClaim(body) {
  const firstSentence = body.split(/(?<=[.!?])\s/)[0] ?? body;
  return firstSentence.trim().slice(0, 200);
}

function checklistFor(method) {
  if (method === "lean-kernel") {
    return ["Compile the Lean artifact", "Confirm no sorry or admit", "Match statement to claim", "Record the kernel result"];
  }
  if (method === "replay") {
    return ["Load the command and seed", "Reproduce the run", "Compare the output hash", "Confirm the result matches the claim"];
  }
  if (method === "cas") {
    return ["Re-run the CAS script", "Check the assumptions", "Compare the symbolic output", "Confirm the result matches the claim"];
  }
  return ["Read the argument", "Check the dependencies", "Probe the weak steps", "Decide pass or needs-more-detail"];
}
