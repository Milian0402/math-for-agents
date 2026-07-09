const FORMATS = new Set(["markdown", "lean-issue", "paper-notes"]);

export function problemExportFormats() {
  return [...FORMATS];
}

export function formatProblemExport(context, format = "markdown") {
  if (!FORMATS.has(format)) {
    const error = new Error(`format must be one of: ${problemExportFormats().join(", ")}`);
    error.statusCode = 422;
    throw error;
  }

  if (format === "lean-issue") return formatLeanIssue(context);
  if (format === "paper-notes") return formatPaperNotes(context);
  return formatMarkdownBrief(context);
}

export function buildResearchTrail(context = {}) {
  const posts = [...(context.posts || [])].sort(comparePosts);
  const postById = new Map(posts.map((post) => [post.id, post]));
  const claimsByPost = new Map();
  const supersededBy = new Map();

  for (const claim of context.claims || []) {
    for (const postId of claim.linked_posts || []) {
      const linked = claimsByPost.get(postId) || [];
      linked.push(claim);
      claimsByPost.set(postId, linked);
    }
  }

  for (const post of posts) {
    if (!post.supersedes_post_id) continue;
    const successors = supersededBy.get(post.supersedes_post_id) || [];
    successors.push(post);
    supersededBy.set(post.supersedes_post_id, successors);
  }

  const nodes = posts.map((post) => {
    const dependencyIds = [...new Set(post.dependencies || [])];
    const linkedClaims = claimsByPost.get(post.id) || [];
    return {
      id: post.id,
      created_at: post.created_at,
      agent: post.agent,
      problem_id: post.problem_id,
      assignment_id: post.assignment_id || null,
      type: post.type,
      body: post.body,
      evidence_level: post.evidence_level,
      status: post.status,
      artifacts: post.artifacts || [],
      replay: post.replay || null,
      dependency_ids: dependencyIds,
      dependencies: dependencyIds.map((id) => resolvePostReference(id, postById)),
      supersedes_post_id: post.supersedes_post_id || null,
      supersedes: post.supersedes_post_id ? resolvePostReference(post.supersedes_post_id, postById) : null,
      superseded_by: (supersededBy.get(post.id) || []).map(postReference),
      linked_claim_ids: linkedClaims.map((claim) => claim.id),
      linked_claims: linkedClaims.map(claimReference)
    };
  });

  const inactiveIds = new Set();
  for (const node of nodes) {
    if (["refuted", "superseded"].includes(node.status)) inactiveIds.add(node.id);
    if (node.superseded_by.length) inactiveIds.add(node.id);
  }
  for (const node of nodes) {
    if (inactiveIds.has(node.id)) continue;
    for (const dependencyId of node.dependency_ids) inactiveIds.add(dependencyId);
  }

  return {
    problem: context.problem
      ? {
          id: context.problem.id,
          title: context.problem.title,
          status: context.problem.status,
          updated_at: context.problem.updated_at
        }
      : null,
    nodes,
    active_frontier: nodes.filter((node) => !inactiveIds.has(node.id)).map(frontierReference)
  };
}

function formatMarkdownBrief(context) {
  const { problem } = context;
  return [
    `# ${problem.title}`,
    "",
    metadataLine(problem),
    "",
    "## Summary",
    clean(problem.summary),
    "",
    "## Why It Matters",
    clean(problem.why_it_matters) || "Not specified.",
    "",
    "## Current Assignments",
    bulletList(context.assignments, assignmentLine),
    "",
    "## Claims",
    bulletList(context.claims, claimLine),
    "",
    "## Verification State",
    bulletList(context.verifications, verificationLine),
    "",
    "## Artifacts",
    bulletList(context.artifacts, artifactLine),
    "",
    ...researchTrailSection(context)
  ].join("\n");
}

function formatLeanIssue(context) {
  const { problem } = context;
  const acceptedClaims = context.claims.filter((claim) => claim.status === "accepted");
  const openClaims = context.claims.filter((claim) => claim.status !== "accepted");
  return [
    `# Lean task: ${problem.title}`,
    "",
    "## Problem",
    clean(problem.summary),
    "",
    "## Target Statement",
    codeBlock("lean", leanSkeleton(problem, acceptedClaims)),
    "",
    "## Accepted Inputs",
    bulletList(acceptedClaims, claimLine),
    "",
    "## Open Gaps",
    bulletList(openClaims, claimLine),
    "",
    "## Verification Requests",
    bulletList(context.verifications.filter((item) => item.status !== "passed"), verificationLine),
    "",
    "## Useful Artifacts",
    bulletList(context.artifacts, artifactLine),
    "",
    ...researchTrailSection(context),
    "",
    "## Notes For The Formalizer",
    "- Keep computational evidence as comments unless it has a theorem-level proof.",
    "- Link each theorem attempt back to the claim id and artifact id it depends on."
  ].join("\n");
}

function formatPaperNotes(context) {
  const { problem } = context;
  return [
    `# Paper Notes: ${problem.title}`,
    "",
    "## Abstract Draft",
    clean(problem.summary),
    "",
    "## Research Position",
    clean(problem.why_it_matters) || "The motivation still needs to be written.",
    "",
    "## Results Ledger",
    bulletList(context.claims, claimLine),
    "",
    "## Evidence And Reproducibility",
    bulletList(context.verifications, verificationLine),
    "",
    "## Computation And Source Artifacts",
    bulletList(context.artifacts, artifactLine),
    "",
    ...researchTrailSection(context),
    "",
    "## Remaining Paper Gaps",
    bulletList(
      context.claims.filter((claim) => claim.status !== "accepted"),
      (claim) => `${claim.id}: ${cleanInline(claim.statement)} (${claim.verification_state})`
    )
  ].join("\n");
}

function metadataLine(problem) {
  const tags = Array.isArray(problem.tags) && problem.tags.length ? `; tags: ${problem.tags.join(", ")}` : "";
  return `Area: ${problem.area}; status: ${problem.status}; priority: ${problem.priority}${tags}`;
}

function assignmentLine(assignment) {
  return `${assignment.id}: ${assignment.task} (${assignment.status}) assigned to ${listText(assignment.assigned_agents)}`;
}

function claimLine(claim) {
  return `${claim.id}: ${cleanInline(claim.statement)} [${claim.status}; ${claim.trust_tier}; ${claim.verification_state}]`;
}

function verificationLine(verification) {
  const artifact = verification.artifact_id ? `; artifact ${verification.artifact_id}` : "";
  return `${verification.id}: ${verification.method} for ${verification.claim_id} assigned to ${verification.assigned_agent} [${verification.status}${artifact}]`;
}

function artifactLine(artifact) {
  return `${artifact.id}: ${artifact.title} (${artifact.kind}) by ${artifact.owner}; ${artifact.path}`;
}

function researchTrailSection(context) {
  const trail = buildResearchTrail(context);
  return [
    "## Research Trail",
    trail.nodes.length ? trail.nodes.map(trailNodeBlock).join("\n") : "- None.",
    "",
    "### Active Frontier",
    trail.active_frontier.length
      ? trail.active_frontier.map((item) => `- ${item.id}: ${item.type} by ${item.agent} [${item.status}] - ${cleanInline(item.body)}`).join("\n")
      : "- None."
  ];
}

function trailNodeBlock(node) {
  const lines = [
    `- ${node.id}: ${node.type} by ${node.agent} [${node.status}; ${node.evidence_level}] - ${cleanInline(node.body)}`
  ];
  if (node.dependency_ids.length) lines.push(`  - Depends on: ${node.dependency_ids.join(", ")}`);
  if (node.supersedes_post_id) lines.push(`  - Supersedes: ${node.supersedes_post_id}`);
  if (node.superseded_by.length) lines.push(`  - Superseded by: ${node.superseded_by.map((post) => post.id).join(", ")}`);
  if (node.linked_claims.length) {
    lines.push(
      `  - Linked claims: ${node.linked_claims
        .map((claim) => `${claim.id} [${claim.status}; ${claim.trust_tier}; ${claim.verification_state}] ${cleanInline(claim.statement)}`)
        .join(" | ")}`
    );
  }
  return lines.join("\n");
}

function resolvePostReference(id, postById) {
  const post = postById.get(id);
  return post ? postReference(post) : { id, missing: true };
}

function postReference(post) {
  return {
    id: post.id,
    created_at: post.created_at,
    agent: post.agent,
    type: post.type,
    status: post.status,
    body: post.body
  };
}

function claimReference(claim) {
  return {
    id: claim.id,
    type: claim.type,
    statement: claim.statement,
    status: claim.status,
    evidence_level: claim.evidence_level,
    trust_tier: claim.trust_tier,
    verification_state: claim.verification_state
  };
}

function frontierReference(node) {
  return {
    id: node.id,
    created_at: node.created_at,
    agent: node.agent,
    type: node.type,
    status: node.status,
    body: node.body,
    linked_claim_ids: node.linked_claim_ids
  };
}

function comparePosts(left, right) {
  const leftTime = Date.parse(left.created_at || "") || 0;
  const rightTime = Date.parse(right.created_at || "") || 0;
  return leftTime - rightTime || String(left.id || "").localeCompare(String(right.id || ""));
}

function bulletList(items, formatter) {
  if (!items?.length) return "- None.";
  return items.map((item) => `- ${formatter(item)}`).join("\n");
}

function clean(value) {
  return String(value || "").trim();
}

function cleanInline(value) {
  return clean(value).replace(/\s+/g, " ");
}

function listText(value) {
  return Array.isArray(value) && value.length ? value.join(", ") : "any available agent";
}

function codeBlock(language, body) {
  return ["```" + language, body, "```"].join("\n");
}

function leanSkeleton(problem, claims) {
  const namespace = leanName(problem.id || problem.title);
  const theoremLines = claims.length
    ? claims.map((claim) => `theorem ${leanName(claim.id)} : True := by\n  trivial`).join("\n\n")
    : "-- Add a precise theorem statement after translating the accepted claim ledger.";
  return [`namespace ${namespace}`, "", theoremLines, "", `end ${namespace}`].join("\n");
}

function leanName(value) {
  const cleaned = String(value || "Problem")
    .replace(/^agent:/, "agent_")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const safe = cleaned || "Problem";
  return /^[A-Za-z_]/.test(safe) ? safe : `n_${safe}`;
}
