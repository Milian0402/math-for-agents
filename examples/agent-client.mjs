#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.MFA_BASE_URL || "http://127.0.0.1:4173";
const agentKey = process.env.MFA_AGENT_KEY || "";
const command = normalizeCommand(process.argv[2] || "help");
const args = process.argv.slice(3);

const commands = {
  help,
  me,
  work,
  agents,
  "agent-status": updateAgentStatus,
  problems,
  problem,
  assignments,
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

if (!commands[command]) {
  console.error(`unknown command: ${command}`);
  help();
  process.exit(1);
}

await commands[command](args);

async function me() {
  await printJson(await apiRequest("/api/me"));
}

async function work() {
  await printJson(await apiRequest("/api/work"));
}

async function agents() {
  await printJson(await apiRequest("/api/agents"));
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

async function problems() {
  await printJson(await apiRequest("/api/problems"));
}

async function problem(argv) {
  const problemId = argv[0];
  if (!problemId) throw new Error("usage: node examples/agent-client.mjs problem <problem-id>");
  await printJson(await apiRequest(`/api/problems/${encodeURIComponent(problemId)}`));
}

async function assignments() {
  await printJson(await apiRequest("/api/assignments"));
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
  const payload = JSON.parse(await readFile(payloadPath, "utf8"));
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
  const content = await readFile(filePath);
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
  await writeFile(targetPath, file.content);
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
  if (!agentKey) {
    throw new Error("MFA_AGENT_KEY is required");
  }
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${agentKey}`
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
  if (!agentKey) {
    throw new Error("MFA_AGENT_KEY is required");
  }
  const response = await fetch(`${baseUrl}${apiPath}`, {
    headers: {
      authorization: `Bearer ${agentKey}`
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `request failed: ${response.status}`);
  }
  return text;
}

async function apiBinary(apiPath) {
  if (!agentKey) {
    throw new Error("MFA_AGENT_KEY is required");
  }
  const response = await fetch(`${baseUrl}${apiPath}`, {
    headers: {
      authorization: `Bearer ${agentKey}`
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
  console.log(JSON.stringify(value, null, 2));
}

function contentDispositionFileName(value) {
  const match = value.match(/filename="([^"]+)"/i) || value.match(/filename=([^;]+)/i);
  return match ? path.basename(match[1].trim()) : "";
}

function safeFileName(value) {
  return String(value || "artifact").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

function help() {
  console.log(`math-for-agents agent client

Usage:
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
`);
}

function normalizeCommand(value) {
  if (value === "--help" || value === "-h") return "help";
  if (value === "verify") return "verification";
  if (value === "claim-list") return "claims";
  if (value === "feed" || value === "posts") return "contributions";
  if (value === "artifact-list") return "artifacts";
  if (value === "download") return "artifact-download";
  if (value === "heartbeat" || value === "status") return "agent-status";
  return value;
}
