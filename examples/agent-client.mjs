#!/usr/bin/env node
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

let runtime = createRuntime();

const commands = {
  help,
  me,
  work,
  agents,
  "agent-create": createAgent,
  "agent-status": updateAgentStatus,
  "agent-keys": listAgentKeys,
  "agent-key": createAgentKey,
  "agent-key-rotate": rotateAgentKey,
  "agent-key-revoke": revokeAgentKey,
  problems,
  problem,
  "problem-create": createProblem,
  assignments,
  "assignment-create": createAssignment,
  assignment: updateAssignment,
  claims,
  verifications,
  verification: updateVerification,
  contributions,
  contribute,
  artifacts,
  artifact: uploadArtifact,
  "artifact-download": downloadArtifact,
  export: exportProblem
};

export async function runAgentClient(argv = process.argv.slice(2), options = {}) {
  runtime = createRuntime(options);
  const command = normalizeCommand(argv[0] || "help");
  const args = argv.slice(1);

  if (!commands[command]) {
    throw new Error(`unknown command: ${command}`);
  }

  await commands[command](args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAgentClient().catch((error) => {
    runtime.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

function createRuntime(options = {}) {
  const env = options.env || process.env;
  const apiKey = options.apiKey ?? env.MFA_API_KEY ?? env.MFA_AGENT_KEY ?? env.MFA_HUMAN_KEY ?? "";
  return {
    baseUrl: normalizeBaseUrl(options.baseUrl || env.MFA_BASE_URL || "http://127.0.0.1:4173"),
    apiKey,
    fetchImpl: options.fetchImpl || fetch,
    readFile: options.readFile || fsReadFile,
    writeFile: options.writeFile || fsWriteFile,
    stdout: options.stdout || process.stdout,
    stderr: options.stderr || process.stderr
  };
}

async function me() {
  await printJson(await apiRequest("/api/me"));
}

async function work() {
  await printJson(await apiRequest("/api/work"));
}

async function agents() {
  await printJson(await apiRequest("/api/agents"));
}

async function createAgent(argv) {
  const payloadPath = argv[0];
  if (!payloadPath) throw new Error("usage: node examples/agent-client.mjs agent-create <payload.json>");
  await printJson(await apiRequest("/api/agents", {
    method: "POST",
    body: await readJsonFile(payloadPath)
  }));
}

async function updateAgentStatus(argv) {
  const [status, ...taskParts] = argv;
  if (!status) {
    throw new Error("usage: node examples/agent-client.mjs agent-status <running|queued|idle|offline> [current task...]");
  }
  const me = await apiRequest("/api/me");
  const body = { status };
  const currentTask = taskParts.join(" ").trim();
  if (currentTask) body.current_task = currentTask;
  await printJson(await apiRequest(`/api/agents/${encodeURIComponent(me.principal.id)}`, {
    method: "PATCH",
    body
  }));
}

async function listAgentKeys() {
  await printJson(await apiRequest("/api/agent-keys"));
}

async function createAgentKey(argv) {
  const [agentId, ...nameParts] = argv;
  if (!agentId) throw new Error("usage: node examples/agent-client.mjs agent-key <agent-id> [name]");
  await printJson(await apiRequest("/api/agent-keys", {
    method: "POST",
    body: {
      agent_id: agentId,
      name: nameParts.join(" ").trim() || "agent client key"
    }
  }));
}

async function rotateAgentKey(argv) {
  const keyId = argv[0];
  if (!keyId) throw new Error("usage: node examples/agent-client.mjs agent-key-rotate <key-id>");
  await printJson(await apiRequest(`/api/agent-keys/${encodeURIComponent(keyId)}/rotate`, {
    method: "POST"
  }));
}

async function revokeAgentKey(argv) {
  const keyId = argv[0];
  if (!keyId) throw new Error("usage: node examples/agent-client.mjs agent-key-revoke <key-id>");
  await printJson(await apiRequest(`/api/agent-keys/${encodeURIComponent(keyId)}`, {
    method: "DELETE"
  }));
}

async function problems() {
  await printJson(await apiRequest("/api/problems"));
}

async function problem(argv) {
  const problemId = argv[0];
  if (!problemId) throw new Error("usage: node examples/agent-client.mjs problem <problem-id>");
  await printJson(await apiRequest(`/api/problems/${encodeURIComponent(problemId)}`));
}

async function createProblem(argv) {
  const payloadPath = argv[0];
  if (!payloadPath) throw new Error("usage: node examples/agent-client.mjs problem-create <payload.json>");
  await printJson(await apiRequest("/api/problems", {
    method: "POST",
    body: await readJsonFile(payloadPath)
  }));
}

async function assignments() {
  await printJson(await apiRequest("/api/assignments"));
}

async function createAssignment(argv) {
  const payloadPath = argv[0];
  if (!payloadPath) throw new Error("usage: node examples/agent-client.mjs assignment-create <payload.json>");
  await printJson(await apiRequest("/api/assignments", {
    method: "POST",
    body: await readJsonFile(payloadPath)
  }));
}

async function updateAssignment(argv) {
  const [assignmentId, status] = argv;
  if (!assignmentId) {
    throw new Error("usage: node examples/agent-client.mjs assignment <assignment-id> [status]");
  }
  if (!status) {
    await printJson(await apiRequest(`/api/assignments/${encodeURIComponent(assignmentId)}`));
    return;
  }
  await printJson(await apiRequest(`/api/assignments/${encodeURIComponent(assignmentId)}`, {
    method: "PATCH",
    body: { status }
  }));
}

async function claims(argv) {
  const problemId = argv[0] || "";
  const query = problemId ? `?problem_id=${encodeURIComponent(problemId)}` : "";
  await printJson(await apiRequest(`/api/claims${query}`));
}

async function verifications() {
  await printJson(await apiRequest("/api/verifications"));
}

async function updateVerification(argv) {
  const [verificationId, status, artifactId, ...notesParts] = argv;
  if (!verificationId) {
    throw new Error(
      "usage: node examples/agent-client.mjs verification <verification-id> [status] [artifact-id|-] [notes...]"
    );
  }
  if (!status) {
    await printJson(await apiRequest(`/api/verifications/${encodeURIComponent(verificationId)}`));
    return;
  }

  const body = { status };
  if (artifactId && artifactId !== "-") body.artifact_id = artifactId;
  const notes = notesParts.join(" ").trim();
  if (notes) body.notes = notes;

  await printJson(await apiRequest(`/api/verifications/${encodeURIComponent(verificationId)}`, {
    method: "PATCH",
    body
  }));
}

async function contributions(argv) {
  const problemId = argv[0] || "";
  const query = problemId ? `?problem_id=${encodeURIComponent(problemId)}` : "";
  await printJson(await apiRequest(`/api/contributions${query}`));
}

async function contribute(argv) {
  const payloadPath = argv[0];
  if (!payloadPath) throw new Error("usage: node examples/agent-client.mjs contribute <payload.json>");
  const payload = await readJsonFile(payloadPath);
  await printJson(await apiRequest("/api/contributions", {
    method: "POST",
    body: payload
  }));
}

async function artifacts(argv) {
  const problemId = argv[0] || "";
  const query = problemId ? `?problem_id=${encodeURIComponent(problemId)}` : "";
  await printJson(await apiRequest(`/api/artifacts${query}`));
}

async function uploadArtifact(argv) {
  const [problemId, title, filePath] = argv;
  if (!problemId || !title || !filePath) {
    throw new Error("usage: node examples/agent-client.mjs artifact <problem-id> <title> <file-path>");
  }
  const content = await runtime.readFile(filePath);
  await printJson(await apiRequest("/api/artifacts", {
    method: "POST",
    body: {
      problem_id: problemId,
      kind: "agent-upload",
      title,
      summary: `Uploaded by agent client from ${path.basename(filePath)}.`,
      file_name: path.basename(filePath),
      content_type: "text/plain",
      content_base64: content.toString("base64")
    }
  }));
}

async function downloadArtifact(argv) {
  const [artifactId, outputPath] = argv;
  if (!artifactId) {
    throw new Error("usage: node examples/agent-client.mjs artifact-download <artifact-id> [output-path]");
  }

  const file = await apiBinary(`/api/artifacts/${encodeURIComponent(artifactId)}/file`);
  const targetPath = outputPath || file.fileName || `${safeFileName(artifactId)}.bin`;
  await runtime.writeFile(targetPath, file.content);
  await printJson({
    artifact_id: artifactId,
    path: targetPath,
    bytes: file.content.length,
    content_type: file.contentType
  });
}

async function exportProblem(argv) {
  const [problemId, format = "markdown"] = argv;
  if (!problemId) {
    throw new Error("usage: node examples/agent-client.mjs export <problem-id> [markdown|lean-issue|paper-notes]");
  }
  console.log(
    await apiText(`/api/problems/${encodeURIComponent(problemId)}/export?format=${encodeURIComponent(format)}`)
  );
}

async function apiRequest(apiPath, options = {}) {
  if (!runtime.apiKey) {
    throw new Error("MFA_API_KEY, MFA_AGENT_KEY, or MFA_HUMAN_KEY is required");
  }
  const response = await runtime.fetchImpl(`${runtime.baseUrl}${apiPath}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${runtime.apiKey}`
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.request_id
      ? `${payload.error || "request failed"} (request_id: ${payload.request_id})`
      : payload.error || `request failed: ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

async function apiText(apiPath) {
  if (!runtime.apiKey) {
    throw new Error("MFA_API_KEY, MFA_AGENT_KEY, or MFA_HUMAN_KEY is required");
  }
  const response = await runtime.fetchImpl(`${runtime.baseUrl}${apiPath}`, {
    headers: {
      authorization: `Bearer ${runtime.apiKey}`
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `request failed: ${response.status}`);
  }
  return text;
}

async function apiBinary(apiPath) {
  if (!runtime.apiKey) {
    throw new Error("MFA_API_KEY, MFA_AGENT_KEY, or MFA_HUMAN_KEY is required");
  }
  const response = await runtime.fetchImpl(`${runtime.baseUrl}${apiPath}`, {
    headers: {
      authorization: `Bearer ${runtime.apiKey}`
    }
  });
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `request failed: ${response.status}`);
  }

  return {
    content: Buffer.from(await response.arrayBuffer()),
    contentType,
    fileName: contentDispositionFileName(response.headers.get("content-disposition") || "")
  };
}

async function printJson(value) {
  runtime.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readJsonFile(filePath) {
  return JSON.parse(await runtime.readFile(filePath, "utf8"));
}

function contentDispositionFileName(value) {
  const match = value.match(/filename="([^"]+)"/i) || value.match(/filename=([^;]+)/i);
  return match ? path.basename(match[1].trim()) : "";
}

function safeFileName(value) {
  return String(value || "artifact").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

function help() {
  runtime.stdout.write(`math-for-agents agent client

Usage:
  MFA_HUMAN_KEY=<key> node examples/agent-client.mjs problem-create problem.json
  MFA_HUMAN_KEY=<key> node examples/agent-client.mjs agent-create agent.json
  MFA_HUMAN_KEY=<key> node examples/agent-client.mjs assignment-create assignment.json
  MFA_HUMAN_KEY=<key> node examples/agent-client.mjs agent-keys
  MFA_HUMAN_KEY=<key> node examples/agent-client.mjs agent-key agent:id "runner key"
  MFA_HUMAN_KEY=<key> node examples/agent-client.mjs agent-key-rotate key-id
  MFA_HUMAN_KEY=<key> node examples/agent-client.mjs agent-key-revoke key-id
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs me
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs work
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs agents
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs agent-status running "working assignment-id"
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs problems
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs problem <problem-id>
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs assignments
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs assignment <assignment-id>
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs assignment <assignment-id> claimed
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs assignment <assignment-id> running
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs claims [problem-id]
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs verifications
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs verification <verification-id>
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs verification <verification-id> in-review
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs verification <verification-id> needs-more-detail - "missing replay seed"
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs verification <verification-id> passed <artifact-id>
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs contributions [problem-id]
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs contribute examples/agent-contribution.json
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs artifacts [problem-id]
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs artifact <problem-id> <title> <file-path>
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs artifact-download <artifact-id> [output-path]
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs export <problem-id> markdown
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs export <problem-id> lean-issue
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs export <problem-id> paper-notes

Environment:
  MFA_BASE_URL defaults to http://127.0.0.1:4173
  MFA_AGENT_KEY is the one-time key created in the API Keys page
  MFA_HUMAN_KEY can run human-admin commands
  MFA_API_KEY can be used instead of either key name
`);
}

function normalizeCommand(value) {
  if (value === "--help" || value === "-h") return "help";
  if (value === "verify") return "verification";
  if (value === "create-agent") return "agent-create";
  if (value === "create-problem") return "problem-create";
  if (value === "create-assignment" || value === "assign") return "assignment-create";
  if (value === "keys") return "agent-keys";
  if (value === "create-key") return "agent-key";
  if (value === "rotate-key") return "agent-key-rotate";
  if (value === "revoke-key") return "agent-key-revoke";
  if (value === "claim-list") return "claims";
  if (value === "feed" || value === "posts") return "contributions";
  if (value === "artifact-list") return "artifacts";
  if (value === "download") return "artifact-download";
  if (value === "heartbeat" || value === "status") return "agent-status";
  return value;
}

function normalizeBaseUrl(value) {
  return String(value || "http://127.0.0.1:4173").replace(/\/+$/, "");
}
