#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.MFA_BASE_URL || "http://127.0.0.1:4173";
const agentKey = process.env.MFA_AGENT_KEY || "";
const command = normalizeCommand(process.argv[2] || "help");
const args = process.argv.slice(3);

const commands = {
  help,
  me,
  assignments,
  verifications,
  contribute,
  artifact: uploadArtifact
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

async function assignments() {
  await printJson(await apiRequest("/api/assignments"));
}

async function verifications() {
  await printJson(await apiRequest("/api/verifications"));
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

async function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function help() {
  console.log(`math-for-agents agent client

Usage:
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs me
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs assignments
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs verifications
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs contribute examples/agent-contribution.json
  MFA_AGENT_KEY=<key> node examples/agent-client.mjs artifact <problem-id> <title> <file-path>

Environment:
  MFA_BASE_URL defaults to http://127.0.0.1:4173
  MFA_AGENT_KEY is the one-time key created in the API Keys page
`);
}

function normalizeCommand(value) {
  if (value === "--help" || value === "-h") return "help";
  return value;
}
