import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildProductionEnv, parseArgs, writeProductionEnvFile } from "./create-production-env.mjs";
import { parseEnvText, runDeployPreflight } from "./deploy-preflight.mjs";

let tokenIndex = 0;
const randomToken = () => `token${++tokenIndex}${"a".repeat(32)}`;

const text = buildProductionEnv({
  origin: "https://math-for-agents.example.com/",
  email: "max@example.com",
  name: "Max Nordler",
  verifier: "agent:private-beta-verifier",
  backupRemoteHost: "/mnt/math-for-agents-backups",
  randomToken
});

const env = parseEnvText(text, "generated");
assert.equal(env.POSTGRES_USER, "math_for_agents");
assert.equal(env.POSTGRES_DB, "math_for_agents");
assert.equal(env.MFA_HUMAN_EMAIL, "max@example.com");
assert.equal(env.MFA_HUMAN_NAME, "Max Nordler");
assert.equal(env.MFA_DEFAULT_VERIFIER_AGENT_ID, "agent:private-beta-verifier");
assert.equal(env.MFA_BASE_URL, "https://math-for-agents.example.com");
assert.equal(env.MFA_PUBLIC_ORIGIN, "https://math-for-agents.example.com");
assert.equal(env.MFA_COOKIE_SECURE, "true");
assert.equal(env.MFA_ALLOW_INSECURE_COOKIES, "false");
assert.equal(env.MFA_WORKER_RUNNER, "docker");
assert.equal(env.BACKUP_REMOTE_DIR_HOST, "/mnt/math-for-agents-backups");
assert.equal(env.BACKUP_REMOTE_DIR, "/data/backup-remote");
assert.ok(env.POSTGRES_PASSWORD.length >= 16);
assert.ok(env.MFA_HUMAN_KEY.startsWith("mfa_"));

const vercelText = buildProductionEnv({
  target: "vercel",
  origin: "https://math-for-agents.example.com/",
  email: "max@example.com",
  name: "Max Nordler",
  verifier: "agent:private-beta-verifier",
  databaseUrl: "postgres://math_for_agents:strong-password@db.example.com:5432/math_for_agents",
  blobReadWriteToken: "vercel_blob_rw_private_beta_token",
  randomToken
});

const vercelEnv = parseEnvText(vercelText, "generated-vercel");
assert.equal(vercelEnv.MFA_DEPLOY_TARGET, "vercel");
assert.equal(vercelEnv.DATABASE_SSL, "true");
assert.equal(vercelEnv.ARTIFACT_STORAGE_DRIVER, "vercel-blob");
assert.equal(vercelEnv.BLOB_READ_WRITE_TOKEN, "vercel_blob_rw_private_beta_token");
assert.equal(vercelEnv.MFA_WORKER_RUNNER, "disabled");
assert.equal(vercelEnv.MFA_BASE_URL, "https://math-for-agents.example.com");

const tmp = await mkdtemp(path.join(os.tmpdir(), "mfa-production-env-check-"));

try {
  const output = path.join(tmp, ".env.production");
  await writeProductionEnvFile({
    output,
    origin: "https://math-for-agents.example.com",
    email: "max@example.com",
    name: "Max Nordler",
    backupRemoteHost: "/mnt/math-for-agents-backups",
    randomToken
  });

  await assert.rejects(
    writeProductionEnvFile({
      output,
      origin: "https://math-for-agents.example.com",
      email: "max@example.com",
      randomToken
    }),
    /already exists/
  );

  const preflight = await runDeployPreflight({
    cwd: process.cwd(),
    envFile: output,
    baseEnv: {}
  });
  assert.equal(preflight.ok, true);
  assert.equal(preflight.mode, "compose");
  assert.ok(preflight.checks.every((check) => check.ok));
  assert.ok(!preflight.warnings.some((warning) => warning.includes("BACKUP_REMOTE_DIR is not set")));
  assert.ok(preflight.warnings.some((warning) => warning.includes("Docker socket")));

  const vercelOutput = path.join(tmp, ".env.production.vercel");
  await writeProductionEnvFile({
    output: vercelOutput,
    target: "vercel",
    origin: "https://math-for-agents.example.com",
    email: "max@example.com",
    name: "Max Nordler",
    databaseUrl: "postgres://math_for_agents:strong-password@db.example.com:5432/math_for_agents",
    blobReadWriteToken: "vercel_blob_rw_private_beta_token",
    randomToken
  });

  const vercelPreflight = await runDeployPreflight({
    cwd: process.cwd(),
    envFile: vercelOutput,
    baseEnv: {}
  });
  assert.equal(vercelPreflight.ok, true);
  assert.equal(vercelPreflight.mode, "vercel");
  assert.ok(vercelPreflight.checks.every((check) => check.ok));

  await writeProductionEnvFile({
    output,
    origin: "https://math-for-agents.example.com",
    email: "max@example.com",
    force: true,
    randomToken
  });
} finally {
  await rm(tmp, { recursive: true, force: true });
}

assert.deepEqual(parseArgs(["--origin", "https://math-for-agents.example.com", "--email", "max@example.com"]), {
  origin: "https://math-for-agents.example.com",
  email: "max@example.com"
});
assert.deepEqual(
  parseArgs([
    "--target",
    "vercel",
    "--origin",
    "https://math-for-agents.example.com",
    "--email",
    "max@example.com",
    "--database-url",
    "postgres://math_for_agents:strong-password@db.example.com:5432/math_for_agents",
    "--blob-read-write-token",
    "vercel_blob_rw_private_beta_token"
  ]),
  {
    target: "vercel",
    origin: "https://math-for-agents.example.com",
    email: "max@example.com",
    databaseUrl: "postgres://math_for_agents:strong-password@db.example.com:5432/math_for_agents",
    blobReadWriteToken: "vercel_blob_rw_private_beta_token"
  }
);
assert.throws(() => buildProductionEnv({ origin: "http://127.0.0.1:4173", email: "max@example.com" }), /https/);
assert.throws(() => buildProductionEnv({ origin: "https://math-for-agents.example.com/path", email: "max@example.com" }), /path/);
assert.throws(() => buildProductionEnv({ origin: "https://math-for-agents.example.com", email: "not-email" }), /email/);
assert.throws(() => buildProductionEnv({ target: "fly", origin: "https://math-for-agents.example.com", email: "max@example.com" }), /target/);

console.log("production env checks passed.");
