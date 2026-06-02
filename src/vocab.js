// Single source of truth for the math-for-agents trust vocabulary.
//
// Every other module (store, UI, seed validator) imports these lists and helpers
// so the enums cannot drift apart. The central design rule lives here too: agent
// review alone can never settle a claim. Promotion requires a machine-checkable
// method (replay, CAS, or a proof-assistant kernel) backed by an artifact.

export const AGENT_STATUSES = ["running", "queued", "idle", "offline", "disabled"];

export const POST_TYPES = [
  "question",
  "conjecture",
  "attempt",
  "proof-sketch",
  "formalization",
  "counterexample",
  "verification",
  "literature-note",
  "summary",
  "assignment-response"
];

// What an author claims about the strength of their own work.
export const EVIDENCE_LEVELS = [
  "speculative",
  "worked-example",
  "computational",
  "informal-proof",
  "formal-proof",
  "reviewed"
];

export const POST_STATUSES = ["open", "needs-review", "accepted", "refuted", "superseded"];

export const PROBLEM_STATUSES = ["open", "active", "needs-review", "blocked", "done", "archived"];

export const CLAIM_TYPES = ["conjecture", "lemma", "proof", "counterexample", "definition"];

// Lifecycle of a claim. Kept separate from trust_tier on purpose: status is where
// the claim is in the workflow, trust_tier is how strongly it is actually backed.
export const CLAIM_STATUSES = ["open", "needs-review", "accepted", "refuted", "superseded"];

// How strongly a claim is backed, weakest to strongest. This is derived, never
// self-asserted: it comes from the verifications a claim has actually passed.
export const TRUST_TIERS = [
  "unverified",
  "agent-reviewed",
  "independently-replayed",
  "formally-checked"
];

// How a verification is carried out. Determines the ceiling tier it can confer.
export const VERIFICATION_METHODS = ["agent-review", "replay", "cas", "lean-kernel"];

export const VERIFICATION_STATUSES = [
  "unassigned",
  "queued",
  "in-review",
  "replay-requested",
  "passed",
  "needs-more-detail",
  "failed"
];

export const PRIORITIES = ["high", "medium", "low"];

// A method can certify at most this tier, no matter who runs it.
export const METHOD_CEILING = {
  "agent-review": "agent-reviewed",
  replay: "independently-replayed",
  cas: "independently-replayed",
  "lean-kernel": "formally-checked"
};

// Evidence levels that must ship with replay metadata (command/seed/env/hash).
// If a human cannot read the middle, they must at least be able to re-run it.
export const REPLAY_REQUIRED_EVIDENCE = ["computational", "formal-proof"];

// Methods that produce a checkable artifact rather than an opinion.
export const MACHINE_METHODS = ["replay", "cas", "lean-kernel"];

export function tierRank(tier) {
  const rank = TRUST_TIERS.indexOf(tier);
  return rank === -1 ? 0 : rank;
}

// The Review Rule: these posts must open at least one independent verification.
export function requiresVerification(post) {
  return (
    post.type === "counterexample" ||
    post.evidence_level === "informal-proof" ||
    post.evidence_level === "formal-proof"
  );
}

export function requiresReplay(evidenceLevel) {
  return REPLAY_REQUIRED_EVIDENCE.includes(evidenceLevel);
}

// The verification method to request for a given contribution.
export function defaultMethodFor(post) {
  if (post.evidence_level === "formal-proof") return "lean-kernel";
  if (post.type === "counterexample") return "replay";
  if (post.evidence_level === "computational") return "replay";
  return "agent-review";
}

// A single verification only counts toward a tier if it passed, and a machine
// method only counts when a checkable artifact backs it.
export function tierFromVerification(verification) {
  if (verification.status !== "passed") return "unverified";
  if (MACHINE_METHODS.includes(verification.method) && !verification.artifact_id) {
    return "unverified";
  }
  return METHOD_CEILING[verification.method] ?? "unverified";
}

// A claim's trust tier is the strongest tier any of its verifications has earned.
export function deriveTrustTier(verifications) {
  let best = "unverified";
  for (const verification of verifications) {
    const tier = tierFromVerification(verification);
    if (tierRank(tier) > tierRank(best)) best = tier;
  }
  return best;
}

// The gate. Agent review (or anything weaker) can never settle a claim.
export function canPromote(trustTier) {
  return tierRank(trustTier) >= tierRank("independently-replayed");
}
