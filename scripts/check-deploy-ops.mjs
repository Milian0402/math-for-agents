import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function text(path) {
  return readFile(path, "utf8");
}

function includesAll(source, markers, label) {
  for (const marker of markers) {
    assert.ok(source.includes(marker), `${label} missing marker: ${marker}`);
  }
}

const compose = await text("deploy/compose.production.yml");
includesAll(
  compose,
  [
    "healthcheck:",
    "backup:",
    'profiles: ["ops"]',
    'command: ["npm", "run", "healthcheck"]',
    'command: ["npm", "run", "backup"]',
    "MFA_BASE_URL:",
    "BACKUP_DIR: /data/backups",
    "BACKUP_REMOTE_DIR:",
    "${BACKUP_DIR_HOST:-../backups}:/data/backups",
    "${BACKUP_REMOTE_DIR_HOST:-../backup-remote}:/data/backup-remote",
    "artifact_data:/data/artifacts:ro"
  ],
  "production compose"
);

const envExample = await text(".env.example");
includesAll(
  envExample,
  ["MFA_PUBLIC_PORT=", "BACKUP_DIR_HOST=", "BACKUP_REMOTE_DIR_HOST=", "MFA_BASE_URL="],
  "env example"
);

const caddy = await text("deploy/caddy/Caddyfile.example");
includesAll(caddy, ["math-for-agents.example.com", "reverse_proxy 127.0.0.1:4173", "Strict-Transport-Security"], "caddy template");

for (const name of ["healthcheck", "backup"]) {
  const service = await text(`deploy/systemd/math-for-agents-${name}.service.example`);
  includesAll(
    service,
    [
      "WorkingDirectory=/opt/math-for-agents",
      "COMPOSE_PROJECT_NAME=math-for-agents",
      "docker compose --env-file /opt/math-for-agents/.env.production",
      "--profile ops run --rm"
    ],
    `${name} service`
  );

  const timer = await text(`deploy/systemd/math-for-agents-${name}.timer.example`);
  includesAll(timer, ["[Timer]", "Persistent=true", `Unit=math-for-agents-${name}.service`], `${name} timer`);
}

const deployDocs = await text("docs/deploy.md");
includesAll(
  deployDocs,
  [
    "Caddy",
    "systemd",
    "--profile ops run --rm healthcheck",
    "--profile ops run --rm backup",
    "private-beta-launch.md",
    "npm run agent:check"
  ],
  "deploy docs"
);

const opsDocs = await text("docs/ops.md");
includesAll(
  opsDocs,
  ["deploy/systemd", "deploy/caddy/Caddyfile.example", "BACKUP_DIR_HOST", "BACKUP_REMOTE_DIR_HOST", "private-beta-launch.md"],
  "ops docs"
);

const launchDocs = await text("docs/private-beta-launch.md");
includesAll(
  launchDocs,
  [
    "Go/No-Go Evidence",
    "npm run preflight:deploy -- .env.production",
    "MFA_HEALTHCHECK_BEARER",
    "npm run agent:check",
    "node examples/agent-client.mjs work",
    "node examples/agent-client.mjs claims",
    "npm run backup:verify",
    "npm run restore:drill",
    "Rollback and Recovery",
    "Alerting and external error aggregation are operator-owned"
  ],
  "private beta launch docs"
);

console.log("deploy ops template checks passed.");
