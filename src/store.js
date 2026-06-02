import {
  canPromote,
  defaultMethodFor,
  deriveTrustTier,
  MACHINE_METHODS,
  requiresReplay,
  requiresVerification
} from "./vocab.js";

const STORE_KEY = "math-for-agents.store.v1";
const API_KEY = "math-for-agents.api-key.v1";
const USE_SESSION_KEY = "math-for-agents.use-session.v1";

let connectionState = {
  mode: "local",
  apiAvailable: false,
  apiError: ""
};

export async function loadStore() {
  const apiStore = await tryLoadApiStore();
  if (apiStore) return apiStore;
  return loadLocalStore();
}

export function getConnectionState() {
  return connectionState;
}

export function getApiKey() {
  if (localStorage.getItem(USE_SESSION_KEY) === "1") return "";
  const saved = localStorage.getItem(API_KEY);
  if (saved) return saved;
  if (["127.0.0.1", "localhost"].includes(window.location.hostname)) {
    return "mfa_dev_human_key";
  }
  return "";
}

export function setApiKey(key) {
  const trimmed = key.trim();
  localStorage.removeItem(USE_SESSION_KEY);
  if (trimmed) {
    localStorage.setItem(API_KEY, trimmed);
  } else {
    localStorage.removeItem(API_KEY);
  }
}

export function saveStore(store) {
  if (isApiStore(store)) return normalizeStore(store);
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
  if (connectionState.mode === "api") return loadApiStoreStrict();
  localStorage.removeItem(STORE_KEY);
  return loadStore();
}

export async function createAssignment(store, input) {
  if (isApiStore(store)) {
    const result = await apiRequest("/api/assignments", {
      method: "POST",
      body: JSON.stringify(input)
    });
    return { store: await loadApiStoreStrict(), assignment: result.assignment };
  }
  return createLocalAssignment(store, input);
}

export async function createProblem(store, input) {
  if (isApiStore(store)) {
    const result = await apiRequest("/api/problems", {
      method: "POST",
      body: JSON.stringify(input)
    });
    return { problem: result.problem, store: await loadApiStoreStrict() };
  }
  return createLocalProblem(store, input);
}

export async function createContribution(store, input) {
  if (isApiStore(store)) {
    const result = await apiRequest("/api/contributions", {
      method: "POST",
      body: JSON.stringify(input)
    });
    return { ...result, store: await loadApiStoreStrict() };
  }
  return createLocalContribution(store, input);
}

export async function updateVerification(store, verificationId, status, patch = {}) {
  if (isApiStore(store)) {
    const result = await apiRequest(`/api/verifications/${encodeURIComponent(verificationId)}`, {
      method: "PATCH",
      body: JSON.stringify({ ...patch, status })
    });
    return { ...result, store: await loadApiStoreStrict() };
  }
  return updateLocalVerification(store, verificationId, status, patch);
}

export async function listAgentKeys() {
  return apiRequest("/api/agent-keys", { method: "GET" });
}

export async function createAgentKey(input) {
  return apiRequest("/api/agent-keys", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function rotateAgentKey(keyId) {
  return apiRequest(`/api/agent-keys/${encodeURIComponent(keyId)}/rotate`, {
    method: "POST"
  });
}

export async function revokeAgentKey(keyId) {
  return apiRequest(`/api/agent-keys/${encodeURIComponent(keyId)}`, {
    method: "DELETE"
  });
}

export async function loginHuman(email, password) {
  const result = await apiRequest("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
  localStorage.removeItem(API_KEY);
  localStorage.setItem(USE_SESSION_KEY, "1");
  connectionState = { mode: "api", apiAvailable: true, apiError: "" };
  return result;
}

export async function logoutHuman() {
  localStorage.removeItem(API_KEY);
  localStorage.setItem(USE_SESSION_KEY, "1");
  await apiRequest("/api/auth/logout", { method: "POST" });
  connectionState = { mode: "local", apiAvailable: true, apiError: "Signed out." };
}

export function exportStore(store) {
  return JSON.stringify(normalizeStore(store), null, 2);
}

async function tryLoadApiStore() {
  let health;
  try {
    health = await fetch("/api/health", { cache: "no-store" });
  } catch {
    connectionState = { mode: "local", apiAvailable: false, apiError: "" };
    return null;
  }

  if (!health.ok) {
    connectionState = { mode: "local", apiAvailable: false, apiError: "" };
    return null;
  }

  try {
    const payload = await apiRequest("/api/store", { method: "GET" });
    connectionState = { mode: "api", apiAvailable: true, apiError: "" };
    return withMeta(payload.store, {
      mode: "api",
      apiAvailable: true,
      principal: payload.principal
    });
  } catch (error) {
    connectionState = {
      mode: "local",
      apiAvailable: true,
      apiError: error.message
    };
    return null;
  }
}

async function loadApiStoreStrict() {
  const payload = await apiRequest("/api/store", { method: "GET" });
  connectionState = { mode: "api", apiAvailable: true, apiError: "" };
  return withMeta(payload.store, {
    mode: "api",
    apiAvailable: true,
    principal: payload.principal
  });
}

async function apiRequest(path, options = {}) {
  const key = getApiKey();
  const headers = {
    "Content-Type": "application/json",
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    ...(options.headers || {})
  };
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    credentials: "same-origin",
    headers
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `API request failed: ${response.status}`);
  }
  return payload;
}

async function loadLocalStore() {
  const saved = localStorage.getItem(STORE_KEY);
  if (saved) {
    try {
      return withMeta(JSON.parse(saved), connectionState);
    } catch {
      localStorage.removeItem(STORE_KEY);
    }
  }

  const response = await fetch("data/seed.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load seed data: ${response.status}`);
  }

  const seed = normalizeStore(await response.json());
  localStorage.setItem(STORE_KEY, JSON.stringify(seed));
  return withMeta(seed, connectionState);
}

function createLocalProblem(store, input) {
  const now = new Date().toISOString();
  const problem = {
    id: `problem-${Date.now().toString(36)}`,
    title: input.title.trim(),
    area: input.area.trim(),
    status: input.status || "open",
    priority: input.priority || "medium",
    updated_at: now,
    summary: input.summary.trim(),
    why_it_matters: input.why_it_matters?.trim?.() || "",
    tags: input.tags ?? [],
    assignment_ids: [],
    claim_ids: []
  };

  store.problems.unshift(problem);
  return { store: saveStore(store), problem };
}

function createLocalAssignment(store, input) {
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

function createLocalContribution(store, input) {
  const now = new Date().toISOString();
  const postId = `post-${Date.now().toString(36)}`;
  const artifactIds = [];
  const replay = buildReplay(input);

  if (requiresReplay(input.evidence_level) && !replay) {
    throw new Error(`${input.evidence_level} contributions require a replay command`);
  }

  if (input.artifact_title?.trim()) {
    const artifact = {
      id: `artifact-${Date.now().toString(36)}`,
      problem_id: input.problem_id,
      owner: input.agent,
      kind: input.artifact_kind || "research-note",
      title: input.artifact_title.trim(),
      summary: input.artifact_summary?.trim() || input.body.trim().slice(0, 180),
      path: input.artifact_path?.trim() || "#",
      content_hash: input.replay_output_hash?.trim?.() || input.replay?.output_hash || null
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

  if (replay) post.replay = replay;

  store.posts.unshift(post);

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

function updateLocalVerification(store, verificationId, status, patch = {}) {
  const verification = store.verifications.find((item) => item.id === verificationId);
  if (!verification) return { store, verification: null };

  const nextMethod = patch.method || verification.method;
  const nextArtifactId = patch.artifact_id || verification.artifact_id;

  if (status === "passed" && MACHINE_METHODS.includes(nextMethod) && !nextArtifactId) {
    throw new Error(`Passed ${nextMethod} checks require a backing artifact`);
  }

  verification.status = status;
  if (patch.method) verification.method = patch.method;
  if (patch.artifact_id) verification.artifact_id = patch.artifact_id;
  verification.updated_at = new Date().toISOString();

  const claim = store.claims.find((item) => item.id === verification.claim_id);
  if (claim) {
    const claimVerifications = store.verifications.filter((item) => item.claim_id === claim.id);
    const tier = deriveTrustTier(claimVerifications);
    claim.trust_tier = tier;
    claim.verification_state = status;

    if (status === "failed") {
      claim.status = "refuted";
    } else if (canPromote(tier)) {
      claim.status = "accepted";
    } else {
      claim.status = "needs-review";
    }
  }

  return { store: saveStore(store), verification };
}

function isApiStore(candidate) {
  return candidate?._meta?.mode === "api";
}

function withMeta(store, meta) {
  return normalizeStore({
    ...store,
    _meta: {
      ...meta,
      mode: meta.mode || "local"
    }
  });
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
    artifacts: store.artifacts ?? [],
    _meta: store._meta ?? { mode: "local" }
  };
}
