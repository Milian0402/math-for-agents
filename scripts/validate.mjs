// Dependency-free validator for data/seed.json.
//
// Keeps the seed honest against the shared vocabulary in src/vocab.js and against
// the two trust rules that the docs promise: replay metadata for computational and
// formal work, and a machine-checkable artifact behind any passed machine check.
// Runs as part of `npm run check` and exits non-zero on any problem.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  AGENT_STATUSES,
  ASSIGNMENT_STATUSES,
  POST_TYPES,
  EVIDENCE_LEVELS,
  POST_STATUSES,
  PROBLEM_STATUSES,
  CLAIM_TYPES,
  CLAIM_STATUSES,
  TRUST_TIERS,
  VERIFICATION_METHODS,
  VERIFICATION_STATUSES,
  PRIORITIES,
  MACHINE_METHODS,
  requiresReplay,
  tierRank
} from "../src/vocab.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function check(condition, message) {
  if (!condition) errors.push(message);
}

function inEnum(value, list, label) {
  check(list.includes(value), `${label}: ${JSON.stringify(value)} is not one of [${list.join(", ")}]`);
}

async function readJson(relPath) {
  return JSON.parse(await readFile(path.join(root, relPath), "utf8"));
}

// Schema files must at least be valid JSON.
for (const file of [
  "schemas/research-post.schema.json",
  "schemas/agent.schema.json",
  "schemas/problem.schema.json",
  "schemas/assignment.schema.json",
  "schemas/claim.schema.json",
  "schemas/verification.schema.json"
]) {
  try {
    await readJson(file);
  } catch (error) {
    errors.push(`${file}: invalid JSON (${error.message})`);
  }
}

const seed = await readJson("data/seed.json");

const problemIds = new Set(seed.problems.map((problem) => problem.id));
const claimIds = new Set(seed.claims.map((claim) => claim.id));
const postIds = new Set(seed.posts.map((post) => post.id));
const artifactIds = new Set(seed.artifacts.map((artifact) => artifact.id));

for (const agent of seed.agents) {
  const where = `agent ${agent.id}`;
  inEnum(agent.status, AGENT_STATUSES, `${where}.status`);
  check(Array.isArray(agent.tools), `${where}.tools must be an array`);
  check(Number.isInteger(agent.reputation), `${where}.reputation must be an integer`);
  check(agent.reputation >= 0 && agent.reputation <= 100, `${where}.reputation must be between 0 and 100`);
}

for (const problem of seed.problems) {
  const where = `problem ${problem.id}`;
  inEnum(problem.status, PROBLEM_STATUSES, `${where}.status`);
  inEnum(problem.priority, PRIORITIES, `${where}.priority`);
  check(Array.isArray(problem.tags), `${where}.tags must be an array`);
}

for (const assignment of seed.assignments) {
  const where = `assignment ${assignment.id}`;
  inEnum(assignment.status, ASSIGNMENT_STATUSES, `${where}.status`);
  check(problemIds.has(assignment.problem_id), `${where}: unknown problem_id ${assignment.problem_id}`);
  check(Array.isArray(assignment.assigned_agents), `${where}.assigned_agents must be an array`);
  check(Array.isArray(assignment.desired_output), `${where}.desired_output must be an array`);
}

for (const post of seed.posts) {
  const where = `post ${post.id}`;
  inEnum(post.type, POST_TYPES, `${where}.type`);
  inEnum(post.evidence_level, EVIDENCE_LEVELS, `${where}.evidence_level`);
  inEnum(post.status, POST_STATUSES, `${where}.status`);
  check(problemIds.has(post.problem_id), `${where}: unknown problem_id ${post.problem_id}`);
  for (const artifact of post.artifacts ?? []) {
    check(artifactIds.has(artifact), `${where}: unknown artifact ${artifact}`);
  }
  if (requiresReplay(post.evidence_level)) {
    check(
      Boolean(post.replay) && typeof post.replay.command === "string" && post.replay.command.length > 0,
      `${where}: evidence_level "${post.evidence_level}" requires replay.command`
    );
  }
}

for (const claim of seed.claims) {
  const where = `claim ${claim.id}`;
  inEnum(claim.type, CLAIM_TYPES, `${where}.type`);
  inEnum(claim.status, CLAIM_STATUSES, `${where}.status`);
  inEnum(claim.evidence_level, EVIDENCE_LEVELS, `${where}.evidence_level`);
  inEnum(claim.trust_tier, TRUST_TIERS, `${where}.trust_tier`);
  inEnum(claim.verification_state, VERIFICATION_STATUSES, `${where}.verification_state`);
  check(problemIds.has(claim.problem_id), `${where}: unknown problem_id ${claim.problem_id}`);
  for (const postId of claim.linked_posts ?? []) {
    check(postIds.has(postId), `${where}: unknown linked post ${postId}`);
  }
  // The gate, checked statically: a settled claim must be replayed or stronger.
  if (claim.status === "accepted") {
    check(
      tierRank(claim.trust_tier) >= tierRank("independently-replayed"),
      `${where}: status "accepted" needs trust_tier independently-replayed or stronger, has "${claim.trust_tier}"`
    );
  }
}

for (const verification of seed.verifications) {
  const where = `verification ${verification.id}`;
  inEnum(verification.method, VERIFICATION_METHODS, `${where}.method`);
  inEnum(verification.status, VERIFICATION_STATUSES, `${where}.status`);
  inEnum(verification.priority, PRIORITIES, `${where}.priority`);
  check(claimIds.has(verification.claim_id), `${where}: unknown claim_id ${verification.claim_id}`);
  if (verification.artifact_id) {
    check(artifactIds.has(verification.artifact_id), `${where}: unknown artifact_id ${verification.artifact_id}`);
  }
  // A passed machine check must cite the artifact that backs it.
  if (verification.status === "passed" && MACHINE_METHODS.includes(verification.method)) {
    check(
      typeof verification.artifact_id === "string" && verification.artifact_id.length > 0,
      `${where}: a passed "${verification.method}" check must cite an artifact_id`
    );
  }
}

if (errors.length) {
  console.error(`seed validation FAILED (${errors.length} issue${errors.length === 1 ? "" : "s"}):`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(
  `seed validation passed: ${seed.posts.length} posts, ${seed.claims.length} claims, ${seed.verifications.length} verifications.`
);
