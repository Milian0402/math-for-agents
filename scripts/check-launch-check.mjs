import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildProductionEnv } from "./create-production-env.mjs";
import { runLaunchCheck } from "./launch-check.mjs";

let tokenIndex = 0;
const randomToken = () => `token${++tokenIndex}${"a".repeat(32)}`;
const tmp = await mkdtemp(path.join(os.tmpdir(), "mfa-launch-check-"));
const storedArtifact = {
  id: "artifact:test",
  problem_id: "problem:test",
  path: "/api/artifacts/artifact%3Atest/file"
};

try {
  const envFile = path.join(tmp, ".env.production");
  await writeFile(
    envFile,
    buildProductionEnv({
      origin: "https://math-for-agents.example.com",
      email: "max@example.com",
      backupRemoteHost: "/mnt/math-for-agents-backups",
      randomToken
    })
  );

  const success = await runLaunchCheck({
    envFile,
    baseEnv: {
      MFA_AGENT_KEY: "mfa_test_agent_key",
      MFA_AGENT_PROBLEM_ID: "problem:test"
    },
    fetchImpl,
    requestId: "launch-test-request"
  });

  assert.equal(success.ok, true);
  assert.equal(success.base_url, "https://math-for-agents.example.com");
  assert.deepEqual(
    success.checks.map((check) => [check.name, check.ok]),
    [
      ["production_env", true],
      ["public_healthcheck", true],
      ["request_id_probe", true],
      ["authenticated_healthcheck", true],
      ["agent_launch", true]
    ]
  );
  assert.equal(success.checks.find((check) => check.name === "agent_launch").agent_id, "agent:test");
  assert.equal(success.checks.find((check) => check.name === "request_id_probe").request_id, "launch-test-request");

  const missingAgentKey = await runLaunchCheck({
    envFile,
    baseEnv: {
      MFA_AGENT_PROBLEM_ID: "problem:test"
    },
    fetchImpl,
    requestId: "launch-test-request"
  });
  assert.equal(missingAgentKey.ok, false);
  assert.equal(missingAgentKey.checks.find((check) => check.name === "production_env").ok, true);
  assert.equal(missingAgentKey.checks.find((check) => check.name === "public_healthcheck").ok, true);
  assert.equal(missingAgentKey.checks.find((check) => check.name === "request_id_probe").ok, true);
  assert.match(missingAgentKey.checks.find((check) => check.name === "authenticated_healthcheck").error, /MFA_AGENT_KEY/);
  assert.match(missingAgentKey.checks.find((check) => check.name === "agent_launch").error, /MFA_AGENT_KEY/);

  const missingEnv = await runLaunchCheck({
    envFile: path.join(tmp, "missing.env"),
    baseEnv: {
      MFA_BASE_URL: "https://math-for-agents.example.com",
      MFA_AGENT_KEY: "mfa_test_agent_key",
      MFA_AGENT_PROBLEM_ID: "problem:test"
    },
    fetchImpl,
    requestId: "launch-test-request"
  });
  assert.equal(missingEnv.ok, false);
  assert.equal(missingEnv.checks.find((check) => check.name === "production_env").ok, false);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log("launch check checks passed.");

async function fetchImpl(url, options = {}) {
  const parsed = new URL(url);
  if (parsed.pathname === "/api/health") {
    return jsonResponse(
      { ok: true, service: "math-for-agents", database: "ok" },
      200,
      options.headers?.["x-request-id"] ? { "x-request-id": options.headers["x-request-id"] } : {}
    );
  }
  if (parsed.pathname === "/agent-manifest.json") {
    return jsonResponse(agentManifest());
  }
  if (parsed.pathname.startsWith("/docs/")) {
    return textResponse(`# ${parsed.pathname.split("/").pop()}\nAgent docs.\n`);
  }
  if (parsed.pathname === "/openapi.json") {
    return jsonResponse({
      openapi: "3.1.0",
      paths: {
        "/api/me": { get: {} },
        "/api/work": { get: {} },
        "/api/problems/{problem_id}": { get: {} },
        "/api/claims": { get: {} },
        "/api/contributions": { get: {}, post: {} },
        "/api/artifacts": { get: {}, post: {} },
        "/api/artifacts/{artifact_id}/file": { get: {} },
        "/api/verifications": { get: {} }
      }
    });
  }
  if (parsed.pathname === "/api/me") {
    assert.equal(options.headers?.authorization, "Bearer mfa_test_agent_key");
    return jsonResponse({ principal: { kind: "agent", id: "agent:test", workspace_id: "workspace:test" } });
  }
  if (parsed.pathname === "/api/assignments") {
    assert.equal(options.headers?.authorization, "Bearer mfa_test_agent_key");
    return jsonResponse({ assignments: [] });
  }
  if (parsed.pathname === "/api/work") {
    assert.equal(options.headers?.authorization, "Bearer mfa_test_agent_key");
    return jsonResponse({ agent_id: "agent:test", assignments: [], verifications: [], items: [] });
  }
  if (parsed.pathname === "/api/problems/problem%3Atest") {
    assert.equal(options.headers?.authorization, "Bearer mfa_test_agent_key");
    return jsonResponse({
      problem: { id: "problem:test" },
      assignments: [],
      claims: [{ id: "claim:test", problem_id: "problem:test" }],
      posts: [{ id: "post:test", problem_id: "problem:test" }],
      artifacts: [storedArtifact],
      verifications: [],
      verification_jobs: []
    });
  }
  if (parsed.pathname === "/api/claims" && parsed.search === "?problem_id=problem%3Atest") {
    return jsonResponse({ claims: [{ id: "claim:test", problem_id: "problem:test" }] });
  }
  if (parsed.pathname === "/api/contributions" && parsed.search === "?problem_id=problem%3Atest") {
    return jsonResponse({ contributions: [{ id: "post:test", problem_id: "problem:test" }] });
  }
  if (parsed.pathname === "/api/artifacts" && parsed.search === "?problem_id=problem%3Atest") {
    return jsonResponse({ artifacts: [storedArtifact] });
  }
  if (parsed.pathname === "/api/artifacts/artifact%3Atest/file") {
    assert.equal(options.headers?.authorization, "Bearer mfa_test_agent_key");
    return binaryResponse("artifact bytes\n");
  }
  if (parsed.pathname === "/api/verifications") return jsonResponse({ verifications: [] });
  return jsonResponse({ error: "not found" }, 404);
}

function agentManifest() {
  return {
    name: "math-for-agents",
    kind: "math-research-agent-workspace",
    openapi: "/openapi.json",
    docs: {
      agent_quickstart: "/docs/agent-quickstart.md",
      agent_api: "/docs/agent-api.md",
      agent_protocol: "/docs/agent-protocol.md",
      contributing: "/docs/AGENT_CONTRIBUTING.md",
      launch_check: "/docs/private-beta-launch.md"
    },
    core_endpoints: [
      { method: "GET", path: "/api/work" },
      { method: "GET", path: "/api/claims" },
      { method: "GET", path: "/api/contributions" },
      { method: "POST", path: "/api/contributions" },
      { method: "POST", path: "/api/artifacts" },
      { method: "GET", path: "/api/artifacts/{artifact_id}/file" },
      { method: "GET", path: "/api/verifications" }
    ]
  };
}

function jsonResponse(payload, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headers[String(name).toLowerCase()] || ""
    },
    text: async () => JSON.stringify(payload)
  };
}

function textResponse(text, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headers[String(name).toLowerCase()] || ""
    },
    text: async () => text
  };
}

function binaryResponse(text, status = 200, headers = { "content-type": "text/plain" }) {
  const bytes = new TextEncoder().encode(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headers[String(name).toLowerCase()] || ""
    },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => text
  };
}
