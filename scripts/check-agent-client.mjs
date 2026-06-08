import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runAgentClient } from "../examples/agent-client.mjs";

const calls = [];
const stdout = {
  chunks: [],
  write(chunk) {
    this.chunks.push(String(chunk));
  }
};

const tmp = await mkdtemp(path.join(os.tmpdir(), "mfa-agent-client-check-"));

try {
  const problemPath = path.join(tmp, "problem.json");
  const agentPath = path.join(tmp, "agent.json");
  const assignmentPath = path.join(tmp, "assignment.json");
  const contributionPath = path.join(tmp, "contribution.json");

  await writeFile(
    problemPath,
    JSON.stringify({
      title: "Launch theorem",
      area: "Algebra",
      priority: "high",
      summary: "A private-beta setup problem.",
      why_it_matters: "Agents need a concrete target.",
      tags: ["launch"]
    })
  );
  await writeFile(
    agentPath,
    JSON.stringify({
      name: "Launch agent",
      role: "Proof search",
      status: "idle",
      domain: "Algebra",
      style: "Posts replayable work.",
      tools: ["Lean"],
      weak_spots: "Needs verifier replay.",
      current_task: "Waiting."
    })
  );
  await writeFile(
    assignmentPath,
    JSON.stringify({
      problem_id: "problem:launch",
      task: "Try the first proof direction.",
      prompt: "Find a useful lemma or counterexample.",
      desired_output: ["claim", "artifact"],
      assigned_agents: ["agent:launch"]
    })
  );
  await writeFile(
    contributionPath,
    JSON.stringify({
      problem_id: "problem:launch",
      assignment_id: "assignment:launch",
      type: "attempt",
      body: "Short CLI alias contribution.",
      evidence_level: "speculative",
      status: "open"
    })
  );

  const options = {
    env: {
      MFA_BASE_URL: "https://math-for-agents.example.com/",
      MFA_HUMAN_KEY: "mfa_human_launch_key"
    },
    fetchImpl,
    stdout
  };

  await runAgentClient(["problem-create", problemPath], options);
  await runAgentClient(["agent-create", agentPath], options);
  await runAgentClient(["assign", assignmentPath], options);
  await runAgentClient(["agent-keys"], options);
  await runAgentClient(["agent-key", "agent:launch", "beta runner", "--problem", "problem:launch"], options);
  await runAgentClient(["agent-key-rotate", "key:launch", "--problem", "problem:launch"], options);
  await runAgentClient(["agent-key-revoke", "key:launch"], options);

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      "POST /api/problems",
      "POST /api/agents",
      "POST /api/assignments",
      "GET /api/agent-keys",
      "POST /api/agent-keys",
      "POST /api/agent-keys/key%3Alaunch/rotate?problem_id=problem%3Alaunch",
      "DELETE /api/agent-keys/key%3Alaunch"
    ]
  );
  assert.ok(calls.every((call) => call.authorization === "Bearer mfa_human_launch_key"));
  assert.equal(calls[0].body.title, "Launch theorem");
  assert.equal(calls[1].body.name, "Launch agent");
  assert.equal(calls[2].body.problem_id, "problem:launch");
  assert.deepEqual(calls[4].body, { agent_id: "agent:launch", name: "beta runner", problem_id: "problem:launch" });
  assert.ok(stdout.chunks.some((chunk) => chunk.includes('"api_key"')));

  const agentCalls = [];
  await runAgentClient(["connect", "problem:launch"], {
    env: {
      MFA_BASE_URL: "https://math-for-agents.example.com",
      MFA_AGENT_KEY: "mfa_agent_launch_key"
    },
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      agentCalls.push({
        path: `${parsed.pathname}${parsed.search}`,
        authorization: options.headers?.authorization || ""
      });
      return jsonResponse({ connection: { protocol: "math-for-agents.connect.v1" } });
    },
    stdout
  });
  await runAgentClient(["pull"], {
    env: {
      MFA_BASE_URL: "https://math-for-agents.example.com",
      MFA_AGENT_KEY: "mfa_agent_launch_key"
    },
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      agentCalls.push({
        path: `${parsed.pathname}${parsed.search}`,
        authorization: options.headers?.authorization || ""
      });
      return jsonResponse({ assignments: [], verifications: [], items: [] });
    },
    stdout
  });
  await runAgentClient(["go", "problem:launch"], {
    env: {
      MFA_BASE_URL: "https://math-for-agents.example.com",
      MFA_AGENT_KEY: "mfa_agent_launch_key"
    },
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      agentCalls.push({
        path: `${parsed.pathname}${parsed.search}`,
        authorization: options.headers?.authorization || ""
      });
      if (parsed.pathname === "/api/connect") {
        return jsonResponse({ connection: { protocol: "math-for-agents.connect.v1" } });
      }
      return jsonResponse({ assignments: [], verifications: [], items: [] });
    },
    stdout
  });
  await runAgentClient(["post", contributionPath], {
    env: {
      MFA_BASE_URL: "https://math-for-agents.example.com",
      MFA_AGENT_KEY: "mfa_agent_launch_key"
    },
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      agentCalls.push({
        path: `${parsed.pathname}${parsed.search}`,
        authorization: options.headers?.authorization || "",
        body: options.body ? JSON.parse(options.body) : null
      });
      return jsonResponse({ post: { id: "post:launch" } }, 201);
    },
    stdout
  });
  assert.deepEqual(agentCalls, [
    { path: "/api/connect?problem_id=problem%3Alaunch", authorization: "Bearer mfa_agent_launch_key" },
    { path: "/api/work", authorization: "Bearer mfa_agent_launch_key" },
    { path: "/api/connect?problem_id=problem%3Alaunch", authorization: "Bearer mfa_agent_launch_key" },
    { path: "/api/work", authorization: "Bearer mfa_agent_launch_key" },
    {
      path: "/api/contributions",
      authorization: "Bearer mfa_agent_launch_key",
      body: {
        problem_id: "problem:launch",
        assignment_id: "assignment:launch",
        type: "attempt",
        body: "Short CLI alias contribution.",
        evidence_level: "speculative",
        status: "open"
      }
    }
  ]);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log("agent client checks passed.");

async function fetchImpl(url, options = {}) {
  const parsed = new URL(url);
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({
    method,
    path: `${parsed.pathname}${parsed.search}`,
    authorization: options.headers?.authorization || "",
    body
  });

  if (method === "POST" && parsed.pathname === "/api/problems") {
    return jsonResponse({ problem: { id: "problem:launch" } }, 201);
  }
  if (method === "POST" && parsed.pathname === "/api/agents") {
    return jsonResponse({ agent: { id: "agent:launch" } }, 201);
  }
  if (method === "POST" && parsed.pathname === "/api/assignments") {
    return jsonResponse({ assignment: { id: "assignment:launch" } }, 201);
  }
  if (method === "GET" && parsed.pathname === "/api/agent-keys") {
    return jsonResponse({ keys: [] });
  }
  if (method === "POST" && parsed.pathname === "/api/agent-keys") {
    return jsonResponse({ key: { id: "key:launch" }, api_key: "mfa_new_agent_key" }, 201);
  }
  if (method === "POST" && parsed.pathname === "/api/agent-keys/key%3Alaunch/rotate") {
    return jsonResponse({ key: { id: "key:launch" }, api_key: "mfa_rotated_agent_key" });
  }
  if (method === "DELETE" && parsed.pathname === "/api/agent-keys/key%3Alaunch") {
    return jsonResponse({ key: { id: "key:launch" } });
  }
  return jsonResponse({ error: "not found" }, 404);
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: () => ""
    },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    arrayBuffer: async () => Buffer.from(JSON.stringify(payload))
  };
}
