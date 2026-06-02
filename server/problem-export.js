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
    "## Recent Research Thread",
    bulletList(context.posts, postLine)
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
    "## Narrative Thread",
    bulletList(context.posts, postLine),
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

function postLine(post) {
  const assignment = post.assignment_id ? `; assignment ${post.assignment_id}` : "";
  return `${post.id}: ${post.type} by ${post.agent}${assignment} [${post.status}; ${post.evidence_level}] - ${cleanInline(post.body)}`;
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
