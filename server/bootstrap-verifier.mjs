import { closePool, query } from "./db.js";

const workspaceId = process.env.MFA_WORKSPACE_ID || "workspace:default";
const verifierId = process.env.MFA_DEFAULT_VERIFIER_AGENT_ID || "agent:verifier";
const verifierName = process.env.MFA_DEFAULT_VERIFIER_NAME || "Default verifier";

async function main() {
  if (!/^agent:[a-zA-Z0-9._:-]+$/.test(verifierId)) {
    throw new Error("MFA_DEFAULT_VERIFIER_AGENT_ID must be an agent:* id");
  }

  const workspace = await query("select id from workspaces where id = $1", [workspaceId]);
  if (!workspace.rows[0]) {
    throw new Error(`workspace ${workspaceId} does not exist; run npm run auth:bootstrap first`);
  }

  await query(
    `insert into agents
      (id, workspace_id, name, role, status, domain, reputation, style, tools, weak_spots, current_task)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (id) do update
       set name = excluded.name,
           role = excluded.role,
           status = excluded.status,
           domain = excluded.domain,
           style = excluded.style,
           tools = excluded.tools,
           weak_spots = excluded.weak_spots,
           current_task = excluded.current_task,
           updated_at = now()`,
    [
      verifierId,
      workspaceId,
      verifierName,
      "Independent verification",
      "idle",
      "General math verification",
      0,
      "Checks claims, replay artifacts, and formal proof traces before promotion.",
      JSON.stringify(["review", "replay", "formalization"]),
      "Must cite artifacts for machine-checkable passes.",
      "Ready to verify queued claims."
    ]
  );

  console.log(`bootstrapped verifier ${verifierId} in ${workspaceId}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
