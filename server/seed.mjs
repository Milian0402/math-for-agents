import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { closePool, query, transaction } from "./db.js";
import { hashPassword } from "./auth.js";
import { stableKeyHash } from "./ids.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceId = process.env.MFA_WORKSPACE_ID || "workspace:default";
const humanId = process.env.MFA_HUMAN_ID || "human:max";
const humanEmail = process.env.MFA_HUMAN_EMAIL || "max@example.com";
const humanName = process.env.MFA_HUMAN_NAME || "Max";
const humanPassword = process.env.MFA_HUMAN_PASSWORD || "mfa_dev_password";

async function main() {
  const schema = await readFile(path.join(root, "server/schema.sql"), "utf8");
  const seed = JSON.parse(await readFile(path.join(root, "data/seed.json"), "utf8"));

  await query(schema);

  await transaction(async (client) => {
    await client.query("delete from verification_jobs where workspace_id = $1", [workspaceId]);
    await client.query("delete from verifications where workspace_id = $1", [workspaceId]);
    await client.query("delete from claims where workspace_id = $1", [workspaceId]);
    await client.query("delete from posts where workspace_id = $1", [workspaceId]);
    await client.query("delete from artifacts where workspace_id = $1", [workspaceId]);
    await client.query("delete from assignments where workspace_id = $1", [workspaceId]);
    await client.query("delete from problems where workspace_id = $1", [workspaceId]);
    await client.query("delete from agent_api_keys where workspace_id = $1", [workspaceId]);
    await client.query("delete from agents where workspace_id = $1", [workspaceId]);
    await client.query("delete from workspace_members where workspace_id = $1", [workspaceId]);
    await client.query(
      "delete from human_sessions where human_id in (select id from human_users where id = $1 or email = $2)",
      [humanId, humanEmail.toLowerCase()]
    );
    await client.query("delete from human_users where id = $1 or email = $2", [humanId, humanEmail.toLowerCase()]);
    await client.query("delete from workspaces where id = $1", [workspaceId]);

    await client.query(
      `insert into workspaces (id, name, owner, description)
       values ($1,$2,$3,$4)`,
      [workspaceId, seed.workspace.name, seed.workspace.owner, seed.workspace.description]
    );

    await client.query(
      `insert into human_users (id, email, name, password_hash)
       values ($1,$2,$3,$4)`,
      [humanId, humanEmail.toLowerCase(), humanName, hashPassword(humanPassword)]
    );

    await client.query(
      `insert into workspace_members (workspace_id, human_id, role)
       values ($1,$2,$3)`,
      [workspaceId, humanId, "owner"]
    );

    for (const agent of seed.agents) {
      await client.query(
        `insert into agents
          (id, workspace_id, name, role, status, domain, reputation, style, tools, weak_spots, current_task)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          agent.id,
          workspaceId,
          agent.name,
          agent.role,
          agent.status,
          agent.domain || "",
          agent.reputation || 0,
          agent.style || "",
          JSON.stringify(agent.tools || []),
          agent.weak_spots || "",
          agent.current_task || ""
        ]
      );

      const key = process.env[envKeyForAgent(agent.id)] || devKeyForAgent(agent.id);
      await client.query(
        `insert into agent_api_keys (id, workspace_id, agent_id, name, key_hash)
         values ($1,$2,$3,$4,$5)`,
        [`key-${slugForAgent(agent.id)}`, workspaceId, agent.id, "local dev key", stableKeyHash(key)]
      );
    }

    for (const problem of seed.problems) {
      await client.query(
        `insert into problems
          (id, workspace_id, title, area, status, priority, updated_at, summary, why_it_matters, tags, assignment_ids, claim_ids)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          problem.id,
          workspaceId,
          problem.title,
          problem.area,
          problem.status,
          problem.priority,
          problem.updated_at,
          problem.summary,
          problem.why_it_matters || "",
          JSON.stringify(problem.tags || []),
          JSON.stringify(problem.assignment_ids || []),
          JSON.stringify(problem.claim_ids || [])
        ]
      );
    }

    for (const assignment of seed.assignments) {
      await client.query(
        `insert into assignments
          (id, workspace_id, created_at, owner, problem_id, task, prompt, desired_output, assigned_agents, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          assignment.id,
          workspaceId,
          assignment.created_at,
          assignment.owner,
          assignment.problem_id,
          assignment.task,
          assignment.prompt || "",
          JSON.stringify(assignment.desired_output || []),
          JSON.stringify(assignment.assigned_agents || []),
          assignment.status
        ]
      );
    }

    for (const artifact of seed.artifacts) {
      await client.query(
        `insert into artifacts
          (id, workspace_id, problem_id, owner, kind, title, summary, path, content_hash, metadata)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          artifact.id,
          workspaceId,
          artifact.problem_id,
          artifact.owner,
          artifact.kind,
          artifact.title,
          artifact.summary,
          artifact.path,
          artifact.content_hash || null,
          JSON.stringify(artifact.metadata || {})
        ]
      );
    }

    for (const post of seed.posts) {
      await client.query(
        `insert into posts
          (id, workspace_id, created_at, agent, problem_id, assignment_id, type, body, dependencies, artifacts, evidence_level, status, replay)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          post.id,
          workspaceId,
          post.created_at,
          post.agent,
          post.problem_id,
          post.assignment_id || null,
          post.type,
          post.body,
          JSON.stringify(post.dependencies || []),
          JSON.stringify(post.artifacts || []),
          post.evidence_level,
          post.status,
          post.replay ? JSON.stringify(post.replay) : null
        ]
      );
    }

    for (const claim of seed.claims) {
      await client.query(
        `insert into claims
          (id, workspace_id, problem_id, type, statement, status, evidence_level, trust_tier, verification_state, linked_posts)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          claim.id,
          workspaceId,
          claim.problem_id,
          claim.type,
          claim.statement,
          claim.status,
          claim.evidence_level,
          claim.trust_tier,
          claim.verification_state,
          JSON.stringify(claim.linked_posts || [])
        ]
      );
    }

    for (const verification of seed.verifications) {
      await client.query(
        `insert into verifications
          (id, workspace_id, claim_id, assigned_agent, method, priority, status, notes, artifact_id, checklist)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          verification.id,
          workspaceId,
          verification.claim_id,
          verification.assigned_agent,
          verification.method,
          verification.priority,
          verification.status,
          verification.notes || "",
          verification.artifact_id || null,
          JSON.stringify(verification.checklist || [])
        ]
      );

      if (!["passed", "failed"].includes(verification.status)) {
        await client.query(
          `insert into verification_jobs
            (id, workspace_id, verification_id, kind, status, payload)
           values ($1,$2,$3,$4,$5,$6)`,
          [
            `job-${verification.id}`,
            workspaceId,
            verification.id,
            verification.method,
            verification.status === "replay-requested" ? "waiting-for-replay" : "queued",
            JSON.stringify({ claim_id: verification.claim_id })
          ]
        );
      }
    }
  });

  console.log(`seeded ${workspaceId}`);
  console.log(`dev human login: ${humanEmail} / ${humanPassword}`);
  console.log("dev agent keys:");
  for (const agent of seed.agents) {
    console.log(`  ${agent.id}: ${devKeyForAgent(agent.id)}`);
  }
}

function envKeyForAgent(agentId) {
  return `MFA_AGENT_KEY_${slugForAgent(agentId).toUpperCase()}`;
}

function devKeyForAgent(agentId) {
  return `mfa_dev_${slugForAgent(agentId)}`;
}

function slugForAgent(agentId) {
  return agentId.replace(/^agent:/, "").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
