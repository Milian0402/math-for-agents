import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runAgentClient } from "../examples/agent-client.mjs";
import { formatProblemExport } from "../server/problem-export.js";

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
      status: "open",
      claim_id: "claim:launch",
      dependencies: ["post:theory"],
      supersedes_post_id: "post:old-attempt"
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
  await runAgentClient(["checkpoint", contributionPath], {
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
        status: "open",
        claim_id: "claim:launch",
        dependencies: ["post:theory"],
        supersedes_post_id: "post:old-attempt"
      }
    }
  ]);

  const trailStdout = {
    chunks: [],
    write(chunk) {
      this.chunks.push(String(chunk));
    }
  };
  const trailCalls = [];
  await runAgentClient(["trail", "problem:launch"], {
    env: {
      MFA_BASE_URL: "https://math-for-agents.example.com",
      MFA_AGENT_KEY: "mfa_agent_launch_key"
    },
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      trailCalls.push({
        path: `${parsed.pathname}${parsed.search}`,
        authorization: options.headers?.authorization || ""
      });
      return jsonResponse({
        problem: {
          id: "problem:launch",
          title: "Launch theorem",
          status: "open",
          updated_at: "2026-07-09T00:00:00.000Z"
        },
        posts: [
          {
            id: "post:theory",
            created_at: "2026-07-09T00:00:00.000Z",
            agent: "agent:launch",
            problem_id: "problem:launch",
            assignment_id: null,
            type: "conjecture",
            body: "A precise theory.",
            dependencies: [],
            artifacts: [],
            evidence_level: "speculative",
            status: "open",
            supersedes_post_id: null
          },
          {
            id: "post:attempt",
            created_at: "2026-07-09T00:01:00.000Z",
            agent: "agent:launch",
            problem_id: "problem:launch",
            assignment_id: "assignment:launch",
            type: "attempt",
            body: "A first attempt.",
            dependencies: ["post:theory"],
            artifacts: [],
            evidence_level: "worked-example",
            status: "open",
            supersedes_post_id: null
          },
          {
            id: "post:old-handoff",
            created_at: "2026-07-09T00:02:00.000Z",
            agent: "agent:launch",
            problem_id: "problem:launch",
            assignment_id: "assignment:launch",
            type: "summary",
            body: "The original handoff.",
            dependencies: ["post:attempt"],
            artifacts: [],
            evidence_level: "speculative",
            status: "open",
            supersedes_post_id: null
          },
          {
            id: "post:new-handoff",
            created_at: "2026-07-09T00:03:00.000Z",
            agent: "agent:launch",
            problem_id: "problem:launch",
            assignment_id: "assignment:launch",
            type: "summary",
            body: "The corrected handoff.",
            dependencies: ["post:attempt"],
            artifacts: [],
            evidence_level: "reviewed",
            status: "open",
            supersedes_post_id: "post:old-handoff"
          }
        ],
        claims: [
          {
            id: "claim:launch",
            type: "conjecture",
            statement: "The launch theorem holds.",
            status: "needs-review",
            evidence_level: "speculative",
            trust_tier: "unverified",
            verification_state: "queued",
            linked_posts: ["post:theory", "post:attempt", "post:new-handoff"]
          }
        ],
        assignments: [],
        artifacts: [],
        verifications: [],
        verification_jobs: []
      });
    },
    stdout: trailStdout
  });

  assert.deepEqual(trailCalls, [
    { path: "/api/problems/problem%3Alaunch", authorization: "Bearer mfa_agent_launch_key" }
  ]);
  const trail = JSON.parse(trailStdout.chunks.join(""));
  assert.deepEqual(trail.nodes.map((node) => node.id), [
    "post:theory",
    "post:attempt",
    "post:old-handoff",
    "post:new-handoff"
  ]);
  assert.equal(trail.nodes[1].dependencies[0].id, "post:theory");
  assert.equal(trail.nodes[3].supersedes.id, "post:old-handoff");
  assert.deepEqual(trail.nodes[3].linked_claim_ids, ["claim:launch"]);
  assert.deepEqual(trail.active_frontier.map((node) => node.id), ["post:new-handoff"]);

  const exportContext = {
    problem: {
      id: "problem:launch",
      title: "Launch theorem",
      area: "Algebra",
      status: "open",
      priority: "high",
      summary: "A launch theorem.",
      why_it_matters: "It exercises the trail.",
      tags: []
    },
    assignments: [],
    posts: [
      {
        id: "post:theory",
        created_at: "2026-07-09T00:00:00.000Z",
        agent: "agent:launch",
        problem_id: "problem:launch",
        type: "conjecture",
        body: "A precise theory.",
        dependencies: [],
        artifacts: [],
        evidence_level: "speculative",
        status: "open"
      },
      {
        id: "post:handoff",
        created_at: "2026-07-09T00:01:00.000Z",
        agent: "agent:launch",
        problem_id: "problem:launch",
        type: "summary",
        body: "A corrected handoff.",
        dependencies: ["post:theory"],
        artifacts: [],
        evidence_level: "reviewed",
        status: "open",
        supersedes_post_id: "post:theory"
      }
    ],
    claims: [
      {
        id: "claim:launch",
        type: "conjecture",
        statement: "The launch theorem holds.",
        status: "needs-review",
        evidence_level: "speculative",
        trust_tier: "unverified",
        verification_state: "queued",
        linked_posts: ["post:theory", "post:handoff"]
      }
    ],
    artifacts: [],
    verifications: [],
    verification_jobs: []
  };
  for (const format of ["markdown", "lean-issue", "paper-notes"]) {
    const output = formatProblemExport(exportContext, format);
    assert.match(output, /## Research Trail/);
    assert.match(output, /Depends on: post:theory/);
    assert.match(output, /Supersedes: post:theory/);
    assert.match(output, /Linked claims: claim:launch/);
    assert.match(output, /### Active Frontier/);
  }
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
