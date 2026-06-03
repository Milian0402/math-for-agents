import assert from "node:assert/strict";

import { runHealthcheck } from "./healthcheck.mjs";

const calls = [];
const success = await runHealthcheck({
  baseUrl: "https://mfa.example.test/",
  bearer: "mfa_test_agent_key",
  checkAssignments: true,
  fetchImpl: async (url, options = {}) => {
    calls.push({ url, authorization: options.headers?.authorization || "" });
    if (url.endsWith("/api/health")) return jsonResponse({ ok: true, service: "math-for-agents", database: "ok" });
    if (url.endsWith("/agent-manifest.json")) return jsonResponse(agentManifest());
    if (url.endsWith("/.well-known/math-for-agents.json")) return jsonResponse(agentManifest());
    if (url.endsWith("/llms.txt")) return textResponse("# math-for-agents\n/agent-manifest.json\n/openapi.json\n");
    if (url.includes("/docs/")) return textResponse(`# ${url.split("/").pop()}\nAgent docs.\n`);
    if (url.endsWith("/openapi.json")) {
      return jsonResponse({ openapi: "3.1.0", paths: { "/api/contributions": { post: {} } } });
    }
    if (url.endsWith("/api/me")) {
      return jsonResponse({ principal: { kind: "agent", id: "agent:test", workspace_id: "workspace:test" } });
    }
    if (url.endsWith("/api/assignments")) return jsonResponse({ assignments: [] });
    return jsonResponse({ error: "not found" }, 404);
  }
});

assert.equal(success.ok, true);
assert.equal(success.base_url, "https://mfa.example.test");
assert.equal(success.checks.length, 7);
assert.equal(success.checks.find((check) => check.name === "manifest").discovery, 5);
assert.equal(success.checks.find((check) => check.name === "manifest").endpoints, 8);
assert.equal(success.checks.find((check) => check.name === "discovery_aliases").aliases.well_known_manifest, "1");
const docsCheck = success.checks.find((check) => check.name === "docs");
assert.equal(Object.keys(docsCheck.docs).length, 5);
assert.ok(docsCheck.docs.agent_quickstart > 0);
assert.ok(docsCheck.docs.contributing > 0);
assert.ok(docsCheck.docs.launch_check > 0);
assert.equal(calls.find((call) => call.url.endsWith("/api/me")).authorization, "Bearer mfa_test_agent_key");
assert.equal(calls.find((call) => call.url.endsWith("/api/assignments")).authorization, "Bearer mfa_test_agent_key");

const failed = await runHealthcheck({
  baseUrl: "http://bad.example.test",
  fetchImpl: async (url) => {
    if (url.endsWith("/api/health")) return jsonResponse({ ok: true, service: "math-for-agents", database: "down" });
    if (url.endsWith("/agent-manifest.json")) return jsonResponse(agentManifest());
    if (url.endsWith("/.well-known/math-for-agents.json")) return jsonResponse(agentManifest());
    if (url.endsWith("/llms.txt")) return textResponse("# math-for-agents\n/agent-manifest.json\n/openapi.json\n");
    if (url.includes("/docs/")) return textResponse("# Agent docs\n");
    return jsonResponse({ openapi: "3.1.0", paths: { "/api/contributions": { post: {} } } });
  }
});

assert.equal(failed.ok, false);
assert.equal(failed.checks.find((check) => check.name === "health").ok, false);

const badManifest = await runHealthcheck({
  baseUrl: "http://bad-manifest.example.test",
  fetchImpl: async (url) => {
    if (url.endsWith("/api/health")) return jsonResponse({ ok: true, service: "math-for-agents", database: "ok" });
    if (url.endsWith("/agent-manifest.json")) return jsonResponse({ name: "math-for-agents" });
    return jsonResponse({ openapi: "3.1.0", paths: { "/api/contributions": { post: {} } } });
  }
});

assert.equal(badManifest.ok, false);
assert.equal(badManifest.checks.find((check) => check.name === "manifest").ok, false);

console.log("healthcheck checks passed.");

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text
  };
}

function agentManifest() {
  return {
    name: "math-for-agents",
    kind: "math-research-agent-workspace",
    openapi: "/openapi.json",
    version: "1",
    discovery: {
      manifest: "/agent-manifest.json",
      well_known_manifest: "/.well-known/agent-manifest.json",
      well_known_math_for_agents: "/.well-known/math-for-agents.json",
      llms: "/llms.txt",
      well_known_llms: "/.well-known/llms.txt"
    },
    docs: {
      agent_quickstart: "/docs/agent-quickstart.md",
      agent_api: "/docs/agent-api.md",
      agent_protocol: "/docs/agent-protocol.md",
      contributing: "/docs/AGENT_CONTRIBUTING.md",
      launch_check: "/docs/private-beta-launch.md"
    },
    core_endpoints: [
      { method: "GET", path: "/api/connect" },
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
