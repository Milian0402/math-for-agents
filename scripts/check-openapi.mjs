import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const spec = JSON.parse(await readFile("openapi.json", "utf8"));
const server = await readFile("server/http.js", "utf8");

assert.equal(spec.openapi, "3.1.0");
assert.equal(spec.info.title, "math-for-agents API");

const expectedOperations = [
  ["GET", "/api/health", "getHealth", false],
  ["POST", "/api/auth/login", "loginHuman", false],
  ["POST", "/api/auth/logout", "logoutHuman", true],
  ["GET", "/api/me", "getCurrentPrincipal", true],
  ["GET", "/api/workspace", "getWorkspace", true],
  ["GET", "/api/work", "getWorkInbox", true],
  ["GET", "/api/store", "getWorkspaceStore", true],
  ["GET", "/api/agents", "listAgents", true],
  ["POST", "/api/agents", "createAgent", true],
  ["PATCH", "/api/agents/{agent_id}", "updateAgent", true],
  ["GET", "/api/agent-keys", "listAgentKeys", true],
  ["POST", "/api/agent-keys", "createAgentKey", true],
  ["DELETE", "/api/agent-keys/{key_id}", "deleteAgentKey", true],
  ["POST", "/api/agent-keys/{key_id}/rotate", "rotateAgentKey", true],
  ["GET", "/api/problems", "listProblems", true],
  ["POST", "/api/problems", "createProblem", true],
  ["GET", "/api/problems/{problem_id}", "getProblemContext", true],
  ["GET", "/api/problems/{problem_id}/export", "exportProblem", true],
  ["GET", "/api/assignments", "listAssignments", true],
  ["POST", "/api/assignments", "createAssignment", true],
  ["GET", "/api/assignments/{assignment_id}", "getAssignmentContext", true],
  ["PATCH", "/api/assignments/{assignment_id}", "updateAssignment", true],
  ["POST", "/api/contributions", "createContribution", true],
  ["GET", "/api/artifacts", "listArtifacts", true],
  ["POST", "/api/artifacts", "createArtifact", true],
  ["GET", "/api/artifacts/{artifact_id}/file", "downloadArtifactFile", true],
  ["GET", "/api/verifications", "listVerifications", true],
  ["GET", "/api/verifications/{verification_id}", "getVerificationContext", true],
  ["PATCH", "/api/verifications/{verification_id}", "updateVerification", true]
];

for (const [method, path, operationId, requiresAuth] of expectedOperations) {
  const operation = spec.paths?.[path]?.[method.toLowerCase()];
  assert.ok(operation, `${method} ${path} missing from openapi.json`);
  assert.equal(operation.operationId, operationId, `${method} ${path} has wrong operationId`);
  assert.ok(operation.responses, `${method} ${path} missing responses`);
  assert.ok(Object.keys(operation.responses).some((status) => status.startsWith("2")), `${method} ${path} missing 2xx response`);
  if (requiresAuth) {
    assert.notDeepEqual(operation.security, [], `${method} ${path} must require auth`);
  } else {
    assert.deepEqual(operation.security, [], `${method} ${path} must be public`);
  }
}

const serverRouteMarkers = [
  ["/api/health", "GET"],
  ["/api/auth/login", "POST"],
  ["/api/auth/logout", "POST"],
  ["/api/me", "GET"],
  ["/api/workspace", "GET"],
  ["/api/work", "GET"],
  ["/api/store", "GET"],
  ["/api/agents", "GET"],
  ["/api/agents", "POST"],
  ["/api/agent-keys", "GET"],
  ["/api/agent-keys", "POST"],
  ["/api/problems", "GET"],
  ["/api/problems", "POST"],
  ["/api/assignments", "GET"],
  ["/api/assignments", "POST"],
  ["/api/verifications", "GET"],
  ["/api/artifacts", "GET"],
  ["/api/artifacts", "POST"],
  ["/api/contributions", "POST"]
];

for (const [path, method] of serverRouteMarkers) {
  assert.ok(server.includes(`url.pathname === "${path}"`), `server route marker missing: ${method} ${path}`);
  assert.ok(server.includes(`req.method === "${method}"`), `server method marker missing: ${method} ${path}`);
}

assert.ok(server.includes("const assignmentMatch = url.pathname.match"), "server route marker missing: /api/assignments/{assignment_id}");
assert.ok(server.includes('assignmentMatch && req.method === "GET"'), "server method marker missing: GET /api/assignments/{assignment_id}");
assert.ok(server.includes('assignmentMatch && req.method === "PATCH"'), "server method marker missing: PATCH /api/assignments/{assignment_id}");
assert.ok(server.includes("const agentMatch = url.pathname.match"), "server route marker missing: PATCH /api/agents/{agent_id}");
assert.ok(server.includes('agentMatch && req.method === "PATCH"'), "server method marker missing: PATCH /api/agents/{agent_id}");
assert.ok(server.includes("const problemMatch = url.pathname.match"), "server route marker missing: GET /api/problems/{problem_id}");
assert.ok(server.includes('problemMatch && req.method === "GET"'), "server method marker missing: GET /api/problems/{problem_id}");
assert.ok(server.includes("const problemExportMatch = url.pathname.match"), "server route marker missing: GET /api/problems/{problem_id}/export");
assert.ok(server.includes('problemExportMatch && req.method === "GET"'), "server method marker missing: GET /api/problems/{problem_id}/export");
assert.ok(server.includes("const verificationMatch = url.pathname.match"), "server route marker missing: /api/verifications/{verification_id}");
assert.ok(server.includes('verificationMatch && req.method === "GET"'), "server method marker missing: GET /api/verifications/{verification_id}");
assert.ok(server.includes('req.method === "PATCH" && verificationMatch'), "server method marker missing: PATCH /api/verifications/{verification_id}");

for (const schema of ["Agent", "Problem", "Assignment", "Claim", "Post", "Verification"]) {
  assert.ok(spec.components.schemas[schema]?.$ref, `${schema} should reference the shared JSON schema`);
}

console.log(`OpenAPI checks passed: ${expectedOperations.length} operations.`);
