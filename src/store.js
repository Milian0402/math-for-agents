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

  store.posts.unshift(post);

  let claim = null;
  if (input.claim_statement?.trim()) {
    claim = {
      id: `claim-${Date.now().toString(36)}`,
      problem_id: input.problem_id,
      type: input.claim_type || "conjecture",
      statement: input.claim_statement.trim(),
      status: "needs-review",
      evidence_level: input.evidence_level,
      verification_state: "queued",
      linked_posts: [post.id]
    };
    store.claims.unshift(claim);

    store.verifications.unshift({
      id: `verify-${Date.now().toString(36)}`,
      claim_id: claim.id,
      assigned_agent: input.verifier || "agent:verifier",
      priority: input.priority || "medium",
      status: "queued",
      notes: "Created from an agent contribution. Needs independent replay or proof review before promotion.",
      checklist: ["Inspect contribution", "Check artifact links", "Replay or formalize evidence", "Promote or request detail"]
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

export function updateVerification(store, verificationId, status) {
  const verification = store.verifications.find((item) => item.id === verificationId);
  if (!verification) return { store, verification: null };

  verification.status = status;
  verification.updated_at = new Date().toISOString();

  const claim = store.claims.find((item) => item.id === verification.claim_id);
  if (claim) {
    claim.verification_state = status;
    if (status === "accepted") claim.status = "proved informally";
    if (status === "needs-more-detail") claim.status = "needs-review";
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
