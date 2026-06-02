import { closePool, query, transaction } from "./db.js";
import { hashPassword } from "./auth.js";

const workspaceId = process.env.MFA_WORKSPACE_ID || "workspace:default";
const workspaceName = process.env.MFA_WORKSPACE_NAME || "math-for-agents";
const workspaceOwner = process.env.MFA_HUMAN_ID || "human:admin";
const workspaceDescription = process.env.MFA_WORKSPACE_DESCRIPTION || "Machine-native math research workspace.";
const humanEmail = String(process.env.MFA_HUMAN_EMAIL || "").trim().toLowerCase();
const humanName = process.env.MFA_HUMAN_NAME || "Admin";
const humanPassword = process.env.MFA_HUMAN_PASSWORD || "";

async function main() {
  if (!humanEmail || !humanPassword) {
    throw new Error("MFA_HUMAN_EMAIL and MFA_HUMAN_PASSWORD are required");
  }

  await transaction(async (client) => {
    await client.query(
      `insert into workspaces (id, name, owner, description)
       values ($1,$2,$3,$4)
       on conflict (id) do update
         set name = excluded.name,
             owner = excluded.owner,
             description = excluded.description,
             updated_at = now()`,
      [workspaceId, workspaceName, workspaceOwner, workspaceDescription]
    );

    const humanResult = await client.query(
      `insert into human_users (id, email, name, password_hash)
       values ($1,$2,$3,$4)
       on conflict (email) do update
         set name = excluded.name,
             password_hash = excluded.password_hash,
             updated_at = now()
       returning id`,
      [workspaceOwner, humanEmail, humanName, hashPassword(humanPassword)]
    );

    await client.query(
      `insert into workspace_members (workspace_id, human_id, role)
       values ($1,$2,'owner')
       on conflict (workspace_id, human_id) do update
         set role = excluded.role`,
      [workspaceId, humanResult.rows[0].id]
    );
  });

  console.log(`bootstrapped ${humanEmail} as owner of ${workspaceId}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
