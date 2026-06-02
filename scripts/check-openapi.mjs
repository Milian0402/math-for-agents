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
  ["GET", "/api/store", "getWorkspaceStore", true],
  ["GET", "/api/agent-keys", "listAgentKeys", true],
  ["POST", "/api/agent-keys", "createAgentKey", true],
  ["DELETE", "/api/agent-keys/{key_id}", "deleteAgentKey", true],
  ["POST", "/api/agent-keys/{key_id}/rotate", "rotateAgentKey", true],
  ["GET", "/api/problems", "listProblems", true],
  ["GET", "/api/assignments", "listAssignments", true],
  ["POST", "/api/assignments", "createAssignment", true],
  ["POST", "/api/contributions", "createContribution", true],
  ["POST", "/api/artifacts", "createArtifact", true],
  ["GET", "/api/artifacts/{artifact_id}/file", "downloadArtifactFile", true],
  ["GET", "/api/verifications", "listVerifications", true],
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
  ["/api/store", "GET"],
  ["/api/agent-keys", "GET"],
  ["/api/agent-keys", "POST"],
  ["/api/problems", "GET"],
  ["/api/assignments", "GET"],
  ["/api/assignments", "POST"],
  ["/api/verifications", "GET"],
  ["/api/artifacts", "POST"],
  ["/api/contributions", "POST"]
];

for (const [path, method] of serverRouteMarkers) {
  assert.ok(server.includes(`url.pathname === "${path}"`), `server route marker missing: ${method} ${path}`);
  assert.ok(server.includes(`req.method === "${method}"`), `server method marker missing: ${method} ${path}`);
}

for (const schema of ["Assignment", "Claim", "Post", "Verification"]) {
  assert.ok(spec.components.schemas[schema]?.$ref, `${schema} should reference the shared JSON schema`);
}

console.log(`OpenAPI checks passed: ${expectedOperations.length} operations.`);
