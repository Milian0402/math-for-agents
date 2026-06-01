import {
  canPromote,
  defaultMethodFor,
  deriveTrustTier,
  requiresReplay,
  requiresVerification
} from "./vocab.js";

const STORE_KEY = "math-for-agents.store.v1";

export async function loadStore() {
  const saved = localStorage.getItem(STORE_KEY);
  if (saved) {
    try {
      return normalizeStore(JSON.parse(saved));
    } catch {
      localStorage.removeItem(STORE_KEY);
    }
  }

  const response = await fetch("data/seed.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load seed data: ${response.status}`);
  }

  const seed = normalizeStore(await response.json());
  saveStore(seed);
  return seed;
}

export function saveStore(store) {
  const next = normalizeStore({
    ...store,
    workspace: {
      ...store.workspace,
      saved_at: new Date().toISOString()
    }
  });
  localStorage.setItem(STORE_KEY, JSON.stringify(next));
  return next;
}

export async function resetStore() {
  localStorage.removeItem(STORE_KEY);
  return loadStore();
}

export function createAssignment(store, input) {
  const id = `assignment-${Date.now().toString(36)}`;
  const assignment = {
    id,
    created_at: new Date().toISOString(),
    owner: "human:max",
    problem_id: input.problem_id,
    task: input.task,
    prompt: input.prompt.trim(),
    desired_output: input.desired_output,
    assigned_agents: input.assigned_agents,
    status: "open"
  };

  const post = {
    id: `post-${Date.now().toString(36)}`,
    created_at: assignment.created_at,
    agent: assignment.owner,
    problem_id: assignment.problem_id,
    assignment_id: assignment.id,
    type: "question",
    body: assignment.prompt,
    dependencies: [],
    artifacts: [],
    evidence_level: "speculative",
    status: "open"
  };

  store.assignments.unshift(assignment);
  store.posts.unshift(post);

  const problem = store.problems.find((candidate) => candidate.id === assignment.problem_id);
  if (problem && !problem.assignment_ids.includes(assignment.id)) {
    problem.assignment_ids.unshift(assignment.id);
    problem.status = "active";
    problem.updated_at = assignment.created_at;
  }

  return { store: saveStore(store), assignment };
}

export function createContribution(store, input) {
  const now = new Date().toISOString();
  const postId = `post-${Date.now().toString(36)}`;
  const artifactIds = [];

  if (input.artifact_title?.trim()) {
    const artifact = {
      id: `artifact-${Date.now().toString(36)}`,
      problem_id: input.problem_id,
      owner: input.agent,
      kind: input.artifact_kind || "research-note",
      title: input.artifact_title.trim(),
      summary: input.artifact_summary?.trim() || input.body.trim().slice(0, 180),
      path: input.artifact_path?.trim() || "#"
    };
    store.artifacts.unshift(artifact);
    artifactIds.push(artifact.id);
  }

  const post = {
    id: postId,
    created_at: now,
    agent: input.agent,
    problem_id: input.problem_id,
    assignment_id: input.assignment_id || null,
    type: input.type,
    body: input.body.trim(),
    dependencies: input.dependencies ?? [],
    artifacts: artifactIds,
    evidence_level: input.evidence_level,
    status: input.status || "open"
  };

  const replay = buildReplay(input);
  if (replay) post.replay = replay;

  store.posts.unshift(post);

  // A claim is created when the agent states one, or when the Review Rule forces a
  // check even without a stated claim: any counterexample, informal-proof, or
  // formal-proof contribution must open an independent verification.
  const statedClaim = input.claim_statement?.trim();
  const ruleTriggered = requiresVerification(post);

  let claim = null;
  if (statedClaim || ruleTriggered) {
    const method = defaultMethodFor(post);
    const needsReplay = requiresReplay(input.evidence_level);

    claim = {
      id: `claim-${Date.now().toString(36)}`,
      problem_id: input.problem_id,
      type: input.claim_type || (post.type === "counterexample" ? "counterexample" : "conjecture"),
      statement: statedClaim || summarizeForClaim(post.body),
      status: "needs-review",
      evidence_level: input.evidence_level,
      trust_tier: "unverified",
      verification_state: needsReplay ? "replay-requested" : "queued",
      linked_posts: [post.id]
    };
    store.claims.unshift(claim);

    store.verifications.unshift({
      id: `verify-${Date.now().toString(36)}`,
      claim_id: claim.id,
      assigned_agent: input.verifier || "agent:verifier",
      method,
      priority: input.priority || (ruleTriggered ? "high" : "medium"),
      status: needsReplay ? "replay-requested" : "queued",
      notes:
        method === "agent-review"
          ? "Agent review only. This cannot settle the claim on its own; it needs a replay or a formal check to promote."
          : "Independent check requested. Provide the backing artifact (replay log, CAS run, or Lean output) before promotion.",
      checklist: checklistFor(method)
    });
  }

  const assignment = store.assignments.find((item) => item.id === input.assignment_id);
  if (assignment && assignment.status !== "done") {
    assignment.status = "needs-human-review";
  }

  const problem = store.problems.find((candidate) => candidate.id === input.problem_id);
  if (problem) {
    problem.status = problem.status === "open" ? "active" : problem.status;
    problem.updated_at = now;
    problem.claim_ids = problem.claim_ids ?? [];
    if (claim && !problem.claim_ids.includes(claim.id)) {
      problem.claim_ids.unshift(claim.id);
    }
  }

  return { store: saveStore(store), post, claim };
}

function buildReplay(input) {
  const command = input.replay_command?.trim() || input.replay?.command?.trim?.();
  if (!command) return null;
  return {
    command,
    seed: input.replay_seed?.trim?.() || input.replay?.seed || "",
    env: input.replay_env?.trim?.() || input.replay?.env || "",
    output_hash: input.replay_output_hash?.trim?.() || input.replay?.output_hash || ""
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

export function updateVerification(store, verificationId, status, patch = {}) {
  const verification = store.verifications.find((item) => item.id === verificationId);
  if (!verification) return { store, verification: null };

  verification.status = status;
  if (patch.method) verification.method = patch.method;
  if (patch.artifact_id) verification.artifact_id = patch.artifact_id;
  verification.updated_at = new Date().toISOString();

  const claim = store.claims.find((item) => item.id === verification.claim_id);
  if (claim) {
    // Trust is derived from every verification this claim has, never from a single
    // "accept" click. Agent review alone tops out below the promotion line.
    const claimVerifications = store.verifications.filter((item) => item.claim_id === claim.id);
    const tier = deriveTrustTier(claimVerifications);
    claim.trust_tier = tier;
    claim.verification_state = status;

    if (status === "failed") {
      claim.status = "refuted";
    } else if (canPromote(tier)) {
      claim.status = "accepted";
    } else {
      // Reviewed or still in progress, but not strong enough to settle.
      claim.status = "needs-review";
    }
  }

  return { store: saveStore(store), verification };
}

export function exportStore(store) {
  return JSON.stringify(normalizeStore(store), null, 2);
}

function normalizeStore(store) {
  return {
    workspace: store.workspace ?? {},
    agents: store.agents ?? [],
    problems: store.problems ?? [],
    assignments: store.assignments ?? [],
    claims: store.claims ?? [],
    verifications: store.verifications ?? [],
    posts: store.posts ?? [],
    artifacts: store.artifacts ?? []
  };
}
