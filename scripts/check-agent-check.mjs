import assert from "node:assert/strict";

import { runAgentCheck } from "./agent-check.mjs";

const calls = [];
const storedArtifact = {
  id: "artifact:test",
  problem_id: "problem:test",
  path: "/api/artifacts/artifact%3Atest/file"
};

const success = await runAgentCheck({
  baseUrl: "https://mfa.example.test/",
  agentKey: "mfa_test_agent_key",
  problemId: "problem:test",
  fetchImpl: async (url, options = {}) => {
    calls.push({ url, authorization: options.headers?.authorization || "" });
    if (url.endsWith("/agent-manifest.json")) {
      return jsonResponse(agentManifest());
    }
    if (url.endsWith("/openapi.json")) {
      return jsonResponse({
        openapi: "3.1.0",
        paths: {
          "/api/me": { get: {} },
          "/api/work": { get: {} },
          "/api/problems/{problem_id}": { get: {} },
          "/api/claims": { get: {} },
          "/api/contributions": { get: {}, post: {} },
          "/api/artifacts": { get: {}, post: {} },
          "/api/verifications": { get: {} }
        }
      });
    }
    if (url.endsWith("/api/me")) {
      return jsonResponse({ principal: { kind: "agent", id: "agent:test", workspace_id: "workspace:test" } });
    }
    if (url.endsWith("/api/work")) {
      return jsonResponse({ agent_id: "agent:test", assignments: [], verifications: [], items: [] });
    }
    if (url.endsWith("/api/problems/problem%3Atest")) {
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
    if (url.endsWith("/api/claims?problem_id=problem%3Atest")) {
      return jsonResponse({ claims: [{ id: "claim:test", problem_id: "problem:test" }] });
    }
    if (url.endsWith("/api/contributions?problem_id=problem%3Atest")) {
      return jsonResponse({ contributions: [{ id: "post:test", problem_id: "problem:test" }] });
    }
    if (url.endsWith("/api/artifacts?problem_id=problem%3Atest")) {
      return jsonResponse({ artifacts: [storedArtifact] });
    }
    if (url.endsWith("/api/artifacts/artifact%3Atest/file")) return binaryResponse("artifact bytes\n");
    if (url.endsWith("/api/verifications")) return jsonResponse({ verifications: [] });
    return jsonResponse({ error: "not found" }, 404);
  }
});

assert.equal(success.ok, true);
assert.equal(success.base_url, "https://mfa.example.test");
assert.equal(success.problem_id, "problem:test");
assert.equal(success.agent_id, "agent:test");
assert.equal(success.checks.length, 10);
assert.equal(success.checks.find((check) => check.name === "manifest").endpoints, 6);
assert.equal(calls.find((call) => call.url.endsWith("/api/me")).authorization, "Bearer mfa_test_agent_key");
assert.equal(calls.find((call) => call.url.endsWith("/api/work")).authorization, "Bearer mfa_test_agent_key");
assert.equal(calls.find((call) => call.url.endsWith("/api/artifacts/artifact%3Atest/file")).authorization, "Bearer mfa_test_agent_key");
assert.equal(success.checks.find((check) => check.name === "claims").count, 1);
assert.equal(success.checks.find((check) => check.name === "artifact_download").bytes, 15);

const missingKey = await runAgentCheck({
  baseUrl: "https://mfa.example.test",
  agentKey: "",
  fetchImpl: async () => jsonResponse({})
});
assert.equal(missingKey.ok, false);
assert.equal(missingKey.checks[0].name, "configuration");
assert.match(missingKey.checks[0].error, /MFA_AGENT_KEY/);

const badOpenapi = await runAgentCheck({
  baseUrl: "https://mfa.example.test",
  agentKey: "mfa_test_agent_key",
  fetchImpl: async (url) => {
    if (url.endsWith("/agent-manifest.json")) {
      return jsonResponse(agentManifest());
    }
    if (url.endsWith("/openapi.json")) return jsonResponse({ openapi: "3.1.0", paths: {} });
    return jsonResponse({ error: "not expected" }, 500);
  }
});
assert.equal(badOpenapi.ok, false);
assert.equal(badOpenapi.checks.find((check) => check.name === "openapi").ok, false);

console.log("agent check checks passed.");

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: () => ""
    },
    text: async () => JSON.stringify(payload)
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

function agentManifest() {
  return {
    name: "math-for-agents",
    kind: "math-research-agent-workspace",
    openapi: "/openapi.json",
    docs: {
      agent_quickstart: "/docs/agent-quickstart.md",
      agent_api: "/docs/agent-api.md",
      agent_protocol: "/docs/agent-protocol.md"
    },
    core_endpoints: [
      { method: "GET", path: "/api/work" },
      { method: "GET", path: "/api/claims" },
      { method: "GET", path: "/api/contributions" },
      { method: "POST", path: "/api/contributions" },
      { method: "POST", path: "/api/artifacts" },
      { method: "GET", path: "/api/verifications" }
    ]
  };
}
