import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createNodeServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { materializeArtifactContent, openArtifactFile } from "./artifact-storage.js";
import { secureCookiesEnabled } from "./config.js";
import { checkDatabaseHealth } from "./db.js";
import { makeId } from "./ids.js";
import { applyRateLimit, createRequestContext, errorPayload, rateLimitHeaders } from "./ops.js";
import {
  authenticateAgent,
  authenticateHumanSession,
  createAgentApiKey,
  createAssignment,
  createArtifact,
  createContribution,
  deleteAgentApiKey,
  getArtifact,
  getWorkspace,
  getWorkspaceStore,
  listAgentApiKeys,
  listAssignmentsForAgent,
  listProblems,
  listVerificationQueue,
  loginHuman,
  revokeHumanSession,
  rotateAgentApiKey,
  updateVerification
} from "./repository.js";
import {
  assertAgentKeyInput,
  assertArtifactInput,
  assertAssignmentInput,
  assertLoginInput,
  assertVerificationPatch,
  RequestValidationError
} from "./validation.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

export function createServer() {
  return createNodeServer(async (req, res) => {
    const context = createRequestContext(req, res);
    req.context = context;
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      context.path = url.pathname;
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      await serveStatic(req, res, url);
    } catch (error) {
      sendError(res, error, context);
    }
  });
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    try {
      await checkDatabaseHealth();
    } catch {
      throw httpError(503, "database unavailable");
    }
    sendJson(res, 200, { ok: true, service: "math-for-agents", mode: "online-mvp", database: "ok" });
    return;
  }

  const rateLimitError = applyRateLimit(req, url);
  if (rateLimitError) throw rateLimitError;

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(req);
    assertLoginInput(body);
    const result = await loginHuman(body.email, body.password);
    if (!result) throw httpError(401, "invalid email or password");
    sendJson(res, 200, { principal: result.principal }, {
      "set-cookie": sessionCookie(result.sessionToken, result.expiresAt)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const sessionToken = cookieValue(req, "mfa_session");
    if (sessionToken) await revokeHumanSession(sessionToken);
    sendJson(res, 200, { ok: true }, {
      "set-cookie": clearSessionCookie()
    });
    return;
  }

  const principal = await requirePrincipal(req);
  req.context.principal = principal;
  const workspaceId = principal.workspace_id;

  if (req.method === "GET" && url.pathname === "/api/me") {
    sendJson(res, 200, { principal });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/workspace") {
    sendJson(res, 200, { workspace: await getWorkspace(workspaceId) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/store") {
    sendJson(res, 200, { store: await getWorkspaceStore(workspaceId), principal });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent-keys") {
    requireHuman(principal);
    sendJson(res, 200, { keys: await listAgentApiKeys(workspaceId) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent-keys") {
    requireHuman(principal);
    const body = await readJson(req);
    assertAgentKeyInput(body);
    const result = await createAgentApiKey(workspaceId, body);
    if (!result) throw httpError(404, "agent not found");
    sendJson(res, 201, result);
    return;
  }

  const agentKeyMatch = url.pathname.match(/^\/api\/agent-keys\/([^/]+)$/);
  if (agentKeyMatch && req.method === "DELETE") {
    requireHuman(principal);
    const key = await deleteAgentApiKey(workspaceId, agentKeyMatch[1]);
    if (!key) throw httpError(404, "agent key not found");
    sendJson(res, 200, { key });
    return;
  }

  const agentKeyRotateMatch = url.pathname.match(/^\/api\/agent-keys\/([^/]+)\/rotate$/);
  if (agentKeyRotateMatch && req.method === "POST") {
    requireHuman(principal);
    const result = await rotateAgentApiKey(workspaceId, agentKeyRotateMatch[1]);
    if (!result) throw httpError(404, "agent key not found");
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/problems") {
    sendJson(res, 200, { problems: await listProblems(workspaceId) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/assignments") {
    const agentId = principal.kind === "agent" ? principal.id : url.searchParams.get("agent_id") || "";
    if (!agentId) throw httpError(400, "agent_id is required for human assignment lookup");
    sendJson(res, 200, { assignments: await listAssignmentsForAgent(workspaceId, agentId) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/assignments") {
    if (principal.kind !== "human") throw httpError(403, "only human keys can create assignments");
    const body = await readJson(req);
    assertAssignmentInput(body);
    sendJson(res, 201, await createAssignment(workspaceId, principal.id, body));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/verifications") {
    const assignedAgent = principal.kind === "agent" ? principal.id : url.searchParams.get("assigned_agent") || "";
    sendJson(res, 200, { verifications: await listVerificationQueue(workspaceId, assignedAgent) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/artifacts") {
    const body = await readJson(req);
    if (principal.kind === "agent" && body.owner && body.owner !== principal.id) {
      throw httpError(403, "agent keys can only create artifacts for their own agent id");
    }
    const artifactInput = {
      ...body,
      owner: principal.kind === "agent" ? principal.id : body.owner
    };
    assertArtifactInput(artifactInput);
    const artifact = await materializeArtifactContent(workspaceId, {
      id: makeId("artifact"),
      created_at: new Date().toISOString(),
      ...artifactInput,
      path: artifactInput.path || "#",
      content_hash: artifactInput.content_hash || null,
      metadata: artifactInput.metadata || {}
    }, artifactInput);
    sendJson(res, 201, { artifact: await createArtifact(workspaceId, artifact) });
    return;
  }

  const artifactFileMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/file$/);
  if (req.method === "GET" && artifactFileMatch) {
    const artifact = await getArtifact(workspaceId, artifactFileMatch[1]);
    if (!artifact) throw httpError(404, "artifact not found");
    const file = await openArtifactFile(artifact);
    if (!file) throw httpError(404, "artifact file not found");
    sendFile(res, file);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/contributions") {
    const body = await readJson(req);
    if (principal.kind === "agent" && body.agent && body.agent !== principal.id) {
      throw httpError(403, "agent keys can only submit contributions as their own agent id");
    }
    const contribution = await createContribution(workspaceId, {
      ...body,
      agent: principal.kind === "agent" ? principal.id : body.agent
    });
    sendJson(res, 201, contribution);
    return;
  }

  const verificationMatch = url.pathname.match(/^\/api\/verifications\/([^/]+)$/);
  if (req.method === "PATCH" && verificationMatch) {
    const body = await readJson(req);
    assertVerificationPatch(body);
    const result = await updateVerification(workspaceId, verificationMatch[1], body);
    if (!result) throw httpError(404, "verification not found");
    sendJson(res, 200, result);
    return;
  }

  throw httpError(404, "API route not found");
}

async function requirePrincipal(req) {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";

  if (token) {
    if (process.env.MFA_HUMAN_KEY && token === process.env.MFA_HUMAN_KEY) {
      return {
        kind: "human",
        id: process.env.MFA_HUMAN_ID || "human:max",
        workspace_id: process.env.MFA_WORKSPACE_ID || "workspace:default",
        role: "owner",
        auth_method: "human-key"
      };
    }

    const agent = await authenticateAgent(token);
    if (!agent) throw httpError(401, "invalid bearer token");

    return {
      kind: "agent",
      id: agent.id,
      workspace_id: agent.workspace_id,
      name: agent.name,
      role: agent.role,
      auth_method: "agent-key"
    };
  }

  const sessionToken = cookieValue(req, "mfa_session");
  const human = await authenticateHumanSession(sessionToken);
  if (!human) throw httpError(401, "missing session or bearer token");

  return {
    kind: "human",
    id: human.id,
    email: human.email,
    name: human.name,
    workspace_id: human.workspace_id,
    role: human.role,
    auth_method: "human-session"
  };
}

function requireHuman(principal) {
  if (principal.kind !== "human") throw httpError(403, "only human keys can manage agent API keys");
}

async function readJson(req) {
  let raw = "";
  const maxBytes = Number(process.env.MAX_JSON_BYTES || process.env.ARTIFACT_MAX_BYTES || 10_000_000);
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBytes) throw httpError(413, "request body too large");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw httpError(400, "request body must be valid JSON");
  }
}

async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    throw httpError(405, "method not allowed");
  }

  const cleanPath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const filePath = path.resolve(root, cleanPath);
  if (!filePath.startsWith(root)) throw httpError(403, "forbidden");

  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat || !fileStat.isFile()) throw httpError(404, "not found");

  res.writeHead(200, {
    "content-type": contentTypes[path.extname(filePath)] || "application/octet-stream",
    "cache-control": "no-store"
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(payload, null, 2));
}

function cookieValue(req, name) {
  const cookie = req.headers.cookie || "";
  const prefix = `${name}=`;
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return decodeURIComponent(trimmed.slice(prefix.length));
  }
  return "";
}

function sessionCookie(sessionToken, expiresAt) {
  const maxAge = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  return cookieHeader("mfa_session", sessionToken, `Max-Age=${maxAge}; Expires=${new Date(expiresAt).toUTCString()}`);
}

function clearSessionCookie() {
  return cookieHeader("mfa_session", "", "Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
}

function cookieHeader(name, value, lifetime) {
  const secure = secureCookiesEnabled();
  return `${name}=${encodeURIComponent(value)}; ${lifetime}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function sendFile(res, file) {
  res.writeHead(200, {
    "content-type": file.contentType,
    "content-length": String(file.size),
    "content-disposition": `attachment; filename="${file.fileName.replace(/"/g, "")}"`,
    "cache-control": "no-store"
  });
  file.stream.pipe(res);
}

function sendError(res, error, context = {}) {
  const statusCode = error.statusCode || statusForDatabaseError(error) || (error instanceof RequestValidationError ? 422 : 500);
  const payload = errorPayload(error, statusCode, context.request_id, messageForError(error, statusCode));
  sendJson(res, statusCode, payload, rateLimitHeaders(error));
}

function statusForDatabaseError(error) {
  if (error.code === "23503") return 422;
  if (error.code === "23505") return 409;
  return 0;
}

function messageForError(error, statusCode) {
  if (error.code === "23503") return "referenced record not found";
  if (error.code === "23505") return "record already exists";
  return statusCode >= 500 ? "internal server error" : error.message;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
