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

