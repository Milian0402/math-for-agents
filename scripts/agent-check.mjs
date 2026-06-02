import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "http://127.0.0.1:4173";
const DEFAULT_PROBLEM_ID = "finite-magma-identity-search";
const DEFAULT_TIMEOUT_MS = 5_000;

export async function runAgentCheck(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.MFA_BASE_URL || DEFAULT_BASE_URL);
  const agentKey = options.agentKey ?? process.env.MFA_AGENT_KEY ?? "";
  const problemId = options.problemId || process.env.MFA_AGENT_PROBLEM_ID || DEFAULT_PROBLEM_ID;
  const timeoutMs = Number(options.timeoutMs || process.env.MFA_AGENT_CHECK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl || fetch;
  const startedAt = Date.now();
  const checks = [];
  let principal = null;

  if (!agentKey) {
    checks.push({ name: "configuration", ok: false, duration_ms: 0, error: "MFA_AGENT_KEY is required" });
    return result({ baseUrl, problemId, principal, checks, startedAt });
  }

  await runCheck(checks, "manifest", async () => {
    const payload = await requestJson(fetchImpl, `${baseUrl}/agent-manifest.json`, { timeoutMs });
    assertEqual(payload.name, "math-for-agents", "manifest name must be math-for-agents");
    assertEqual(payload.kind, "math-research-agent-workspace", "manifest kind must describe an agent workspace");
    assertEqual(payload.openapi, "/openapi.json", "manifest must point at /openapi.json");
    for (const field of ["agent_quickstart", "agent_api", "agent_protocol"]) {
      if (!payload.docs?.[field]) throw new Error(`manifest docs must include ${field}`);
    }
    const endpoints = Array.isArray(payload.core_endpoints) ? payload.core_endpoints : [];
    for (const [method, path] of [
      ["GET", "/api/work"],
      ["GET", "/api/claims"],
      ["GET", "/api/contributions"],
      ["POST", "/api/contributions"],
      ["POST", "/api/artifacts"],
      ["GET", "/api/verifications"]
    ]) {
      if (!endpoints.some((endpoint) => endpoint.method === method && endpoint.path === path)) {
        throw new Error(`manifest missing ${method} ${path}`);
      }
    }
    return {
      endpoints: endpoints.length,
      docs: Object.keys(payload.docs || {}).length
    };
  });

  await runCheck(checks, "openapi", async () => {
    const payload = await requestJson(fetchImpl, `${baseUrl}/openapi.json`, { timeoutMs });
    assertEqual(payload.openapi, "3.1.0", "openapi version must be 3.1.0");
    const paths = payload.paths || {};
    for (const [path, method] of [
      ["/api/me", "get"],
      ["/api/work", "get"],
      ["/api/problems/{problem_id}", "get"],
      ["/api/claims", "get"],
      ["/api/contributions", "get"],
      ["/api/contributions", "post"],
      ["/api/artifacts", "get"],
      ["/api/artifacts", "post"],
      ["/api/verifications", "get"]
    ]) {
      if (!paths[path]?.[method]) throw new Error(`openapi spec missing ${method.toUpperCase()} ${path}`);
    }
    return { operations: countOperations(paths) };
  });

  await runCheck(checks, "identity", async () => {
    const payload = await requestJson(fetchImpl, `${baseUrl}/api/me`, { timeoutMs, bearer: agentKey });
    principal = payload.principal || null;
    if (!principal?.id) throw new Error("identity check must return a principal id");
    assertEqual(principal.kind, "agent", "MFA_AGENT_KEY must authenticate an agent principal");
    return {
      principal_id: principal.id,
      workspace_id: principal.workspace_id
    };
  });

  await runCheck(checks, "work", async () => {
    const payload = await requestJson(fetchImpl, `${baseUrl}/api/work`, { timeoutMs, bearer: agentKey });
    if (!Array.isArray(payload.assignments)) throw new Error("work check must return assignments");
    if (!Array.isArray(payload.verifications)) throw new Error("work check must return verifications");
    if (!Array.isArray(payload.items)) throw new Error("work check must return compact items");
    if (principal?.id) assertEqual(payload.agent_id, principal.id, "work inbox agent_id must match authenticated agent");
    return {
      assignments: payload.assignments.length,
      verifications: payload.verifications.length,
      items: payload.items.length
    };
  });

  await runCheck(checks, "problem", async () => {
    const payload = await requestJson(fetchImpl, `${baseUrl}/api/problems/${encodeURIComponent(problemId)}`, {
      timeoutMs,
      bearer: agentKey
    });
    assertEqual(payload.problem?.id, problemId, "problem check must return the requested problem");
    for (const field of ["assignments", "claims", "posts", "artifacts", "verifications", "verification_jobs"]) {
      if (!Array.isArray(payload[field])) throw new Error(`problem check must return ${field}`);
    }
    return {
      claims: payload.claims.length,
      posts: payload.posts.length,
      artifacts: payload.artifacts.length,
      verifications: payload.verifications.length
    };
  });

  await runCheck(checks, "claims", async () => {
    const payload = await requestJson(fetchImpl, `${baseUrl}/api/claims?problem_id=${encodeURIComponent(problemId)}`, {
      timeoutMs,
      bearer: agentKey
    });
    if (!Array.isArray(payload.claims)) throw new Error("claims check must return claims");
    if (!payload.claims.every((claim) => claim.problem_id === problemId)) {
      throw new Error("claims check returned a claim from another problem");
    }
    return { count: payload.claims.length };
  });

  await runCheck(checks, "contributions", async () => {
    const payload = await requestJson(
      fetchImpl,
      `${baseUrl}/api/contributions?problem_id=${encodeURIComponent(problemId)}`,
      {
        timeoutMs,
        bearer: agentKey
      }
    );
    if (!Array.isArray(payload.contributions)) throw new Error("contributions check must return contributions");
    if (!payload.contributions.every((post) => post.problem_id === problemId)) {
      throw new Error("contributions check returned a post from another problem");
    }
    return { count: payload.contributions.length };
  });

  await runCheck(checks, "artifacts", async () => {
    const payload = await requestJson(fetchImpl, `${baseUrl}/api/artifacts?problem_id=${encodeURIComponent(problemId)}`, {
      timeoutMs,
      bearer: agentKey
    });
    if (!Array.isArray(payload.artifacts)) throw new Error("artifacts check must return artifacts");
    if (!payload.artifacts.every((artifact) => artifact.problem_id === problemId)) {
      throw new Error("artifacts check returned an artifact from another problem");
    }
    return { count: payload.artifacts.length };
  });

  await runCheck(checks, "verifications", async () => {
    const payload = await requestJson(fetchImpl, `${baseUrl}/api/verifications`, { timeoutMs, bearer: agentKey });
    if (!Array.isArray(payload.verifications)) throw new Error("verifications check must return verifications");
    return { count: payload.verifications.length };
  });

  return result({ baseUrl, problemId, principal, checks, startedAt });
}

async function runCheck(checks, name, fn) {
  const startedAt = Date.now();
  try {
    const details = await fn();
    checks.push({ name, ok: true, duration_ms: Date.now() - startedAt, ...details });
  } catch (error) {
    checks.push({ name, ok: false, duration_ms: Date.now() - startedAt, error: error.message });
  }
}

async function requestJson(fetchImpl, url, { timeoutMs, bearer = "" }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      signal: controller.signal
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function result({ baseUrl, problemId, principal, checks, startedAt }) {
  return {
    ok: checks.every((check) => check.ok),
    base_url: baseUrl,
    problem_id: problemId,
    agent_id: principal?.id || null,
    checked_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    checks
  };
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message);
}

function countOperations(paths) {
  let count = 0;
  for (const methods of Object.values(paths)) {
    for (const method of Object.keys(methods)) {
      if (["get", "post", "put", "patch", "delete"].includes(method)) count += 1;
    }
  }
  return count;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAgentCheck()
    .then((check) => {
      const output = JSON.stringify(check, null, 2);
      if (check.ok) {
        console.log(output);
      } else {
        console.error(output);
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
      process.exitCode = 1;
    });
}
