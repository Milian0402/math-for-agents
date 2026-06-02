import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createNodeServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { materializeArtifactContent, openArtifactFile } from "./artifact-storage.js";
import { secureCookiesEnabled } from "./config.js";
import { checkDatabaseHealth } from "./db.js";
import { verificationAgentForContribution } from "./domain.js";
import { makeId } from "./ids.js";
import { applyRateLimit, createRequestContext, errorPayload, logErrorEvent, rateLimitHeaders } from "./ops.js";
import { formatProblemExport } from "./problem-export.js";
import {
  authenticateAgent,
  authenticateHumanSession,
  createAgent,
  createAgentApiKey,
  createAssignment,
  createArtifact,
  createContribution,
  createProblem,
  deleteAgentApiKey,
  getAgent,
  getAgentApiKey,
  getAssignment,
  getArtifact,
  getClaim,
  getProblemContext,
  getVerification,
  getWorkspace,
  getWorkspaceStore,
  findMissingAgentIds,
  listAgentApiKeys,
  listAgents,
  listAssignmentsForAgent,
  listProblems,
  listVerificationQueue,
  loginHuman,
  revokeHumanSession,
  rotateAgentApiKey,
  updateAssignment,
  updateVerification
} from "./repository.js";
import {
  assertAgentInput,
  assertAgentKeyInput,
  assertArtifactInput,
  assertAssignmentInput,
  assertAssignmentPatch,
  assertContributionInput,
  assertLoginInput,
  assertProblemInput,
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
const publicStaticExactPaths = new Set(["index.html", "openapi.json", "README.md", "data/seed.json"]);
const publicStaticPrefixes = ["src/", "docs/", "schemas/", "examples/", "logs/"];

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
    enforceCookieWriteOrigin(req);
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
  enforceSessionWriteOrigin(req, principal);

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

  if (req.method === "GET" && url.pathname === "/api/agents") {
    sendJson(res, 200, { agents: await listAgents(workspaceId) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agents") {
    requireHuman(principal);
    const body = await readJson(req);
    assertAgentInput(body);
    sendJson(res, 201, { agent: await createAgent(workspaceId, body) });
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
    await enforceAgentCanUseKeys(workspaceId, body.agent_id);
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
    const keyId = agentKeyRotateMatch[1];
    const key = await getAgentApiKey(workspaceId, keyId);
    if (!key) throw httpError(404, "agent key not found");
    await enforceAgentCanUseKeys(workspaceId, key.agent_id);
    const result = await rotateAgentApiKey(workspaceId, keyId);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/problems") {
    sendJson(res, 200, { problems: await listProblems(workspaceId) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/problems") {
    requireHuman(principal);
    const body = await readJson(req);
    assertProblemInput(body);
    sendJson(res, 201, { problem: await createProblem(workspaceId, body) });
    return;
  }

  const problemExportMatch = url.pathname.match(/^\/api\/problems\/([^/]+)\/export$/);
  if (problemExportMatch && req.method === "GET") {
    const problemId = decodeURIComponent(problemExportMatch[1]);
    const context = await getProblemContext(workspaceId, problemId);
    if (!context) throw httpError(404, "problem not found");
    const format = url.searchParams.get("format") || "markdown";
    sendText(
      res,
      200,
      formatProblemExport(context, format),
      exportFileName(context.problem, format)
    );
    return;
  }

  const problemMatch = url.pathname.match(/^\/api\/problems\/([^/]+)$/);
  if (problemMatch && req.method === "GET") {
    const context = await getProblemContext(workspaceId, decodeURIComponent(problemMatch[1]));
    if (!context) throw httpError(404, "problem not found");
    sendJson(res, 200, context);
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
    await enforceKnownAgentIds(workspaceId, body.assigned_agents, "assigned_agents");
    sendJson(res, 201, await createAssignment(workspaceId, principal.id, body));
    return;
  }

  const assignmentMatch = url.pathname.match(/^\/api\/assignments\/([^/]+)$/);
  if (assignmentMatch && req.method === "PATCH") {
    const assignmentId = assignmentMatch[1];
    const body = await readJson(req);
    assertAssignmentPatch(body);

    if (principal.kind === "agent") {
      if (body.status === "done") throw httpError(403, "agent keys cannot mark assignments done");
      const assignment = await getAssignment(workspaceId, assignmentId);
      if (!assignment) throw httpError(404, "assignment not found");
      if (assignment.status === "done") throw httpError(403, "done assignments are locked for agent keys");
      if (!assignmentVisibleToAgent(assignment, principal.id)) {
        throw httpError(403, "agent keys can only update their assigned work");
      }
    }

    const assignment = await updateAssignment(workspaceId, assignmentId, body);
    if (!assignment) throw httpError(404, "assignment not found");
    sendJson(res, 200, { assignment });
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
    const contributionInput = {
      ...body,
      agent: principal.kind === "agent" ? principal.id : body.agent,
      verifier: body.verifier || defaultVerifierAgentId()
    };
    assertContributionInput(contributionInput);
    await enforceContributionAssignmentAccess(workspaceId, principal, contributionInput);
    await enforceContributionArtifactAccess(workspaceId, contributionInput);
    await enforceContributionVerifierAccess(workspaceId, contributionInput);
    const contribution = await createContribution(workspaceId, contributionInput);
    sendJson(res, 201, contribution);
    return;
  }

  const verificationMatch = url.pathname.match(/^\/api\/verifications\/([^/]+)$/);
  if (req.method === "PATCH" && verificationMatch) {
    const body = await readJson(req);
    assertVerificationPatch(body);
    const verificationId = verificationMatch[1];
    let verification = null;
    if (principal.kind === "agent") {
      verification = await getVerification(workspaceId, verificationId);
      if (!verification) throw httpError(404, "verification not found");
      if (verification.assigned_agent !== principal.id) {
        throw httpError(403, "agent keys can only update verifications assigned to their own agent id");
      }
    }
    if (body.artifact_id) {
      verification ||= await getVerification(workspaceId, verificationId);
      if (!verification) throw httpError(404, "verification not found");
      await enforceVerificationArtifactAccess(workspaceId, verification, body.artifact_id);
    }
    const result = await updateVerification(workspaceId, verificationId, body);
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
  if (principal.kind !== "human") throw httpError(403, "only human auth can perform this action");
}

function enforceCookieWriteOrigin(req) {
  if (!cookieValue(req, "mfa_session")) return;
  const check = sessionWriteOriginCheck(req);
  if (!check.ok) throw httpError(403, check.error);
}

function enforceSessionWriteOrigin(req, principal) {
  if (principal.auth_method !== "human-session") return;
  if (safeMethod(req.method)) return;
  const check = sessionWriteOriginCheck(req);
  if (!check.ok) throw httpError(403, check.error);
}

export function sessionWriteOriginCheck(req, env = process.env) {
  const actualOrigin = requestOrigin(req);
  if (!actualOrigin) {
    return {
      ok: false,
      error: "human session writes require a same-origin Origin or Referer header"
    };
  }

  const allowedOrigins = allowedSessionOrigins(req, env);
  if (!allowedOrigins.includes(actualOrigin)) {
    return {
      ok: false,
      error: "human session write origin is not allowed",
      origin: actualOrigin,
      allowed_origins: allowedOrigins
    };
  }

  return { ok: true, origin: actualOrigin, allowed_origins: allowedOrigins };
}

export function allowedSessionOrigins(req, env = process.env) {
  const origins = new Set();
  for (const origin of String(env.MFA_PUBLIC_ORIGIN || "").split(",")) {
    const normalized = normalizeOrigin(origin.trim());
    if (normalized) origins.add(normalized);
  }

  const host = req.headers.host;
  if (host) {
    const forwardedProto = env.MFA_TRUST_PROXY === "true" ? firstHeaderValue(req.headers["x-forwarded-proto"]) : "";
    const protocol = forwardedProto || (secureCookiesEnabled(env) ? "https" : "http");
    origins.add(`${protocol}://${host}`);
  }

  return [...origins];
}

function requestOrigin(req) {
  return normalizeOrigin(req.headers.origin) || normalizeOrigin(req.headers.referer);
}

function normalizeOrigin(value) {
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function firstHeaderValue(value) {
  return String(Array.isArray(value) ? value[0] : value || "").split(",")[0].trim();
}

function safeMethod(method) {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function assignmentVisibleToAgent(assignment, agentId) {
  const assignedAgents = Array.isArray(assignment.assigned_agents) ? assignment.assigned_agents : [];
  return assignedAgents.length === 0 || assignedAgents.includes(agentId);
}

async function enforceContributionAssignmentAccess(workspaceId, principal, body) {
  const assignmentId = body.assignment_id?.trim?.() || "";
  if (!assignmentId) return;

  const assignment = await getAssignment(workspaceId, assignmentId);
  if (!assignment) throw httpError(404, "assignment not found");
  if (assignment.problem_id !== body.problem_id) {
    throw httpError(422, "assignment_id must belong to problem_id");
  }

  if (principal.kind !== "agent") return;
  if (assignment.status === "done") throw httpError(403, "done assignments are locked for agent keys");
  if (!assignmentVisibleToAgent(assignment, principal.id)) {
    throw httpError(403, "agent keys can only contribute to their assigned work");
  }
}

async function enforceContributionArtifactAccess(workspaceId, body) {
  const artifactId = body.artifact_id?.trim?.() || "";
  if (!artifactId) return;

  const artifact = await getArtifact(workspaceId, artifactId);
  if (!artifact) throw httpError(404, "artifact not found");
  if (artifact.problem_id !== body.problem_id) {
    throw httpError(422, "artifact_id must belong to problem_id");
  }
}

async function enforceContributionVerifierAccess(workspaceId, body) {
  const verifier = verificationAgentForContribution(body, { defaultVerifier: defaultVerifierAgentId() });
  if (!verifier) return;
  await enforceKnownAgentIds(workspaceId, [verifier], "verifier");
}

async function enforceVerificationArtifactAccess(workspaceId, verification, artifactId) {
  const artifact = await getArtifact(workspaceId, artifactId);
  if (!artifact) throw httpError(404, "artifact not found");

  const claim = await getClaim(workspaceId, verification.claim_id);
  if (!claim) throw httpError(404, "claim not found");
  if (artifact.problem_id !== claim.problem_id) {
    throw httpError(422, "artifact_id must belong to the verification claim problem");
  }
}

async function enforceKnownAgentIds(workspaceId, agentIds, fieldName) {
  const missing = await findMissingAgentIds(workspaceId, agentIds);
  if (missing.length) throw httpError(404, `${fieldName} contains unknown agent id: ${missing.join(", ")}`);
}

async function enforceAgentCanUseKeys(workspaceId, agentId) {
  const agent = await getAgent(workspaceId, agentId);
  if (!agent) throw httpError(404, "agent not found");
  if (agent.status === "disabled") throw httpError(403, "disabled agents cannot use API keys");
}

function defaultVerifierAgentId(env = process.env) {
  return env.MFA_DEFAULT_VERIFIER_AGENT_ID || "agent:verifier";
}

async function readJson(req) {
  const chunks = [];
  let receivedBytes = 0;
  const maxBytes = requestBodyLimitBytes();
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.length;
    if (receivedBytes > maxBytes) throw httpError(413, "request body too large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks, receivedBytes).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw httpError(400, "request body must be valid JSON");
  }
}

export function requestBodyLimitBytes(env = process.env) {
  if (env.MAX_JSON_BYTES) return positiveInteger(env.MAX_JSON_BYTES, "MAX_JSON_BYTES");
  const artifactMaxBytes = positiveInteger(env.ARTIFACT_MAX_BYTES || 10_000_000, "ARTIFACT_MAX_BYTES");
  return Math.ceil(artifactMaxBytes * 1.5) + 65_536;
}

async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    throw httpError(405, "method not allowed");
  }

  const filePath = resolveStaticFilePath(url.pathname);
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

export function resolveStaticFilePath(pathname, baseRoot = root) {
  let decodedPath = "";
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw httpError(400, "path must be valid URI encoding");
  }

  const requestedPath = decodedPath.replace(/^\/+/, "") || "index.html";
  const filePath = path.resolve(baseRoot, requestedPath);
  const relativePath = path.relative(baseRoot, filePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw httpError(403, "forbidden");
  }

  const publicPath = relativePath.split(path.sep).join("/");
  if (!isPublicStaticPath(publicPath)) throw httpError(404, "not found");
  return filePath;
}

function isPublicStaticPath(publicPath) {
  const segments = publicPath.split("/");
  if (segments.some((segment) => segment.startsWith("."))) return false;
  if (publicStaticExactPaths.has(publicPath)) return true;
  return publicStaticPrefixes.some((prefix) => publicPath.startsWith(prefix));
}

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, statusCode, body, fileName) {
  res.writeHead(statusCode, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": `attachment; filename="${fileName.replace(/"/g, "")}"`,
    "cache-control": "no-store"
  });
  res.end(body);
}

function exportFileName(problem, format) {
  const slug = String(problem.id || problem.title || "problem")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "problem";
  return `${slug}.${format}.md`;
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
  logErrorEvent(context, error, statusCode, payload.error);
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

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
