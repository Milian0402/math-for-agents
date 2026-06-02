import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "http://127.0.0.1:4173";
const DEFAULT_TIMEOUT_MS = 5_000;

export async function runHealthcheck(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.MFA_BASE_URL || DEFAULT_BASE_URL);
  const timeoutMs = Number(options.timeoutMs || process.env.MFA_HEALTHCHECK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const bearer = options.bearer ?? process.env.MFA_HEALTHCHECK_BEARER ?? "";
  const checkAssignments =
    options.checkAssignments ?? process.env.MFA_HEALTHCHECK_ASSIGNMENTS === "true";
  const fetchImpl = options.fetchImpl || fetch;
  const startedAt = Date.now();
  const checks = [];

  await runCheck(checks, "health", async () => {
    const payload = await requestJson(fetchImpl, `${baseUrl}/api/health`, { timeoutMs });
    assertEqual(payload.ok, true, "health.ok must be true");
    assertEqual(payload.service, "math-for-agents", "health.service must be math-for-agents");
    assertEqual(payload.database, "ok", "health.database must be ok");
    return { database: payload.database };
  });

  await runCheck(checks, "manifest", async () => {
    const payload = await requestJson(fetchImpl, `${baseUrl}/agent-manifest.json`, { timeoutMs });
    assertEqual(payload.name, "math-for-agents", "manifest.name must be math-for-agents");
    assertEqual(payload.kind, "math-research-agent-workspace", "manifest.kind must be math-research-agent-workspace");
    assertEqual(payload.openapi, "/openapi.json", "manifest.openapi must point to /openapi.json");
    assertManifestDocs(payload.docs);
    assertManifestEndpoints(payload.core_endpoints);
    return {
      openapi: payload.openapi,
      endpoints: payload.core_endpoints.length
    };
  });

  await runCheck(checks, "openapi", async () => {
    const payload = await requestJson(fetchImpl, `${baseUrl}/openapi.json`, { timeoutMs });
    assertEqual(payload.openapi, "3.1.0", "openapi version must be 3.1.0");
    if (!payload.paths?.["/api/contributions"]?.post) {
      throw new Error("openapi spec must include POST /api/contributions");
    }
    return { operations: countOperations(payload.paths || {}) };
  });

  if (bearer) {
    await runCheck(checks, "auth", async () => {
      const payload = await requestJson(fetchImpl, `${baseUrl}/api/me`, { timeoutMs, bearer });
      if (!payload.principal?.id) throw new Error("auth check must return a principal id");
      return {
        principal_id: payload.principal.id,
        kind: payload.principal.kind,
        workspace_id: payload.principal.workspace_id
      };
    });

    if (checkAssignments) {
      await runCheck(checks, "assignments", async () => {
        const payload = await requestJson(fetchImpl, `${baseUrl}/api/assignments`, { timeoutMs, bearer });
        if (!Array.isArray(payload.assignments)) {
          throw new Error("assignments check must return an assignments array");
        }
        return { count: payload.assignments.length };
      });
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    base_url: baseUrl,
    checked_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    checks
  };
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
      const message = payload.error || `HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message);
}

function assertManifestDocs(docs) {
  for (const key of ["agent_quickstart", "agent_api", "agent_protocol"]) {
    if (typeof docs?.[key] !== "string" || !docs[key].startsWith("/docs/")) {
      throw new Error(`manifest docs must include ${key}`);
    }
  }
}

function assertManifestEndpoints(endpoints) {
  if (!Array.isArray(endpoints)) throw new Error("manifest core_endpoints must be an array");
  const required = [
    ["GET", "/api/work"],
    ["GET", "/api/claims"],
    ["GET", "/api/contributions"],
    ["POST", "/api/contributions"],
    ["POST", "/api/artifacts"],
    ["GET", "/api/verifications"]
  ];
  for (const [method, path] of required) {
    if (!endpoints.some((endpoint) => endpoint.method === method && endpoint.path === path)) {
      throw new Error(`manifest core_endpoints must include ${method} ${path}`);
    }
  }
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
  runHealthcheck()
    .then((result) => {
      const output = JSON.stringify(result, null, 2);
      if (result.ok) {
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
