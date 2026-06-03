import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildEffectiveEnvironments, parseEnvText, runDeployPreflight } from "./deploy-preflight.mjs";

const parsed = parseEnvText(`
# comments are ignored
POSTGRES_PASSWORD='private-beta-postgres-32'
MFA_HUMAN_EMAIL=max@example.com
MFA_HUMAN_PASSWORD="private-beta-human-password"
`);

assert.equal(parsed.POSTGRES_PASSWORD, "private-beta-postgres-32");
assert.equal(parsed.MFA_HUMAN_EMAIL, "max@example.com");
assert.equal(parsed.MFA_HUMAN_PASSWORD, "private-beta-human-password");

const effective = buildEffectiveEnvironments({
  POSTGRES_PASSWORD: "privatebetapostgres32",
  MFA_HUMAN_EMAIL: "max@example.com",
  MFA_HUMAN_PASSWORD: "private-beta-human-password",
  MFA_HUMAN_KEY: "mfa_private_beta_key_32_chars"
});
assert.equal(effective.mode, "compose");
assert.equal(effective.webEnv.NODE_ENV, "production");
assert.equal(effective.webEnv.ARTIFACT_STORAGE_DIR, "/data/artifacts");
assert.equal(effective.workerEnv.MFA_WORKER_RUNNER, "docker");

const vercelEffective = buildEffectiveEnvironments({
  MFA_DEPLOY_TARGET: "vercel",
  DATABASE_URL: "postgres://math_for_agents:strong-password@db.example.com:5432/math_for_agents",
  DATABASE_SSL: "true",
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_private_beta_token",
  MFA_HUMAN_EMAIL: "max@example.com",
  MFA_HUMAN_PASSWORD: "private-beta-human-password",
  MFA_HUMAN_KEY: "mfa_private_beta_key_32_chars"
});
assert.equal(vercelEffective.mode, "vercel");
assert.equal(vercelEffective.webEnv.ARTIFACT_STORAGE_DRIVER, "vercel-blob");
assert.equal(vercelEffective.webEnv.ARTIFACT_STORAGE_DIR, "");
assert.equal(vercelEffective.workerEnv.MFA_WORKER_RUNNER, "disabled");

const tmp = await mkdtemp(path.join(os.tmpdir(), "mfa-preflight-check-"));

try {
  const goodEnv = path.join(tmp, ".env.production.good");
  await writeFile(
    goodEnv,
    [
      "POSTGRES_PASSWORD=privatebetapostgres32",
      "MFA_HUMAN_EMAIL=max@example.com",
      "MFA_HUMAN_PASSWORD=private-beta-human-password",
      "MFA_HUMAN_KEY=mfa_private_beta_key_32_chars",
      "MFA_DEFAULT_VERIFIER_AGENT_ID=agent:private-beta-verifier",
      "MFA_COOKIE_SECURE=true",
      "MFA_WORKER_RUNNER=docker",
      "ARTIFACT_MAX_BYTES=10000000",
      "BACKUP_REMOTE_DIR=/mnt/math-for-agents-backups",
      "MFA_BASE_URL=https://math-for-agents.example.com",
      "MFA_PUBLIC_ORIGIN=https://math-for-agents.example.com"
    ].join("\n")
  );

  const good = await runDeployPreflight({
    cwd: process.cwd(),
    envFile: goodEnv,
    baseEnv: {}
  });
  assert.equal(good.ok, true);
  assert.equal(good.mode, "compose");
  assert.ok(good.checks.every((check) => check.ok));

  const vercelEnv = path.join(tmp, ".env.production.vercel");
  await writeFile(
    vercelEnv,
    [
      "MFA_DEPLOY_TARGET=vercel",
      "DATABASE_URL=postgres://math_for_agents:strong-password@db.example.com:5432/math_for_agents",
      "DATABASE_SSL=true",
      "ARTIFACT_STORAGE_DRIVER=vercel-blob",
      "BLOB_READ_WRITE_TOKEN=vercel_blob_rw_private_beta_token",
      "MFA_HUMAN_EMAIL=max@example.com",
      "MFA_HUMAN_PASSWORD=private-beta-human-password",
      "MFA_HUMAN_KEY=mfa_private_beta_key_32_chars",
      "MFA_DEFAULT_VERIFIER_AGENT_ID=agent:private-beta-verifier",
      "MFA_COOKIE_SECURE=true",
      "ARTIFACT_MAX_BYTES=10000000",
      "MFA_BASE_URL=https://math-for-agents.example.com",
      "MFA_PUBLIC_ORIGIN=https://math-for-agents.example.com"
    ].join("\n")
  );

  const vercel = await runDeployPreflight({
    cwd: process.cwd(),
    envFile: vercelEnv,
    baseEnv: {}
  });
  assert.equal(vercel.ok, true);
  assert.equal(vercel.mode, "vercel");
  assert.ok(vercel.checks.every((check) => check.ok));
  assert.ok(vercel.warnings.some((warning) => warning.includes("Vercel deploy runs the web/API function only")));

  const badVercelEnv = path.join(tmp, ".env.production.bad-vercel");
  await writeFile(
    badVercelEnv,
    [
      "MFA_DEPLOY_TARGET=vercel",
      "DATABASE_URL=postgres://math_for_agents:strong-password@db.example.com:5432/math_for_agents",
      "DATABASE_SSL=false",
      "ARTIFACT_STORAGE_DRIVER=local-file",
      "MFA_HUMAN_EMAIL=max@example.com",
      "MFA_HUMAN_PASSWORD=private-beta-human-password",
      "MFA_HUMAN_KEY=mfa_private_beta_key_32_chars",
      "MFA_DEFAULT_VERIFIER_AGENT_ID=agent:private-beta-verifier",
      "MFA_COOKIE_SECURE=true",
      "ARTIFACT_MAX_BYTES=10000000",
      "MFA_BASE_URL=https://math-for-agents.example.com",
      "MFA_PUBLIC_ORIGIN=https://math-for-agents.example.com"
    ].join("\n")
  );

  const badVercel = await runDeployPreflight({
    cwd: process.cwd(),
    envFile: badVercelEnv,
    baseEnv: {}
  });
  assert.equal(badVercel.ok, false);
  assert.ok(badVercel.checks.some((check) => !check.ok && check.error.includes("DATABASE_SSL=true")));
  assert.ok(badVercel.checks.some((check) => !check.ok && check.name === "vercel artifact storage"));

  const badEnv = path.join(tmp, ".env.production.bad");
  await writeFile(
    badEnv,
    [
      "POSTGRES_PASSWORD=math_for_agents",
      "MFA_HUMAN_EMAIL=max@example.com",
      "MFA_HUMAN_PASSWORD=mfa_dev_password",
      "MFA_HUMAN_KEY=mfa_dev_human_key",
      "MFA_COOKIE_SECURE=false",
      "MFA_WORKER_RUNNER=disabled"
    ].join("\n")
  );

  const bad = await runDeployPreflight({
    cwd: process.cwd(),
    envFile: badEnv,
    baseEnv: {}
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.checks.some((check) => !check.ok && check.name === "public origin env"));
  assert.ok(bad.checks.some((check) => !check.ok && check.name === "default verifier env"));
  assert.ok(bad.checks.some((check) => !check.ok && check.error.includes("POSTGRES_PASSWORD")));
  assert.ok(bad.checks.some((check) => !check.ok && check.name === "web runtime config"));
  assert.ok(bad.checks.some((check) => !check.ok && check.name === "worker runtime config"));

  const reservedEnv = path.join(tmp, ".env.production.reserved");
  await writeFile(
    reservedEnv,
    [
      "POSTGRES_PASSWORD=private@postgres32",
      "MFA_HUMAN_EMAIL=max@example.com",
      "MFA_HUMAN_PASSWORD=private-beta-human-password",
      "MFA_HUMAN_KEY=mfa_private_beta_key_32_chars"
    ].join("\n")
  );

  const reserved = await runDeployPreflight({
    cwd: process.cwd(),
    envFile: reservedEnv,
    baseEnv: {}
  });
  assert.equal(reserved.ok, false);
  assert.ok(reserved.checks.some((check) => !check.ok && check.error.includes("URL-reserved")));

  const mismatchEnv = path.join(tmp, ".env.production.mismatch");
  await writeFile(
    mismatchEnv,
    [
      "POSTGRES_PASSWORD=privatebetapostgres32",
      "MFA_HUMAN_EMAIL=max@example.com",
      "MFA_HUMAN_PASSWORD=private-beta-human-password",
      "MFA_HUMAN_KEY=mfa_private_beta_key_32_chars",
      "MFA_DEFAULT_VERIFIER_AGENT_ID=agent:private-beta-verifier",
      "MFA_COOKIE_SECURE=true",
      "MFA_WORKER_RUNNER=docker",
      "ARTIFACT_MAX_BYTES=10000000",
      "BACKUP_REMOTE_DIR=/mnt/math-for-agents-backups",
      "MFA_BASE_URL=https://math-for-agents.example.com",
      "MFA_PUBLIC_ORIGIN=https://other.example.com"
    ].join("\n")
  );

  const mismatch = await runDeployPreflight({
    cwd: process.cwd(),
    envFile: mismatchEnv,
    baseEnv: {}
  });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.checks.some((check) => !check.ok && check.error.includes("MFA_PUBLIC_ORIGIN must include")));

  const localUrlEnv = path.join(tmp, ".env.production.local-url");
  await writeFile(
    localUrlEnv,
    [
      "POSTGRES_PASSWORD=privatebetapostgres32",
      "MFA_HUMAN_EMAIL=max@example.com",
      "MFA_HUMAN_PASSWORD=private-beta-human-password",
      "MFA_HUMAN_KEY=mfa_private_beta_key_32_chars",
      "MFA_DEFAULT_VERIFIER_AGENT_ID=agent:private-beta-verifier",
      "MFA_COOKIE_SECURE=true",
      "MFA_WORKER_RUNNER=docker",
      "ARTIFACT_MAX_BYTES=10000000",
      "BACKUP_REMOTE_DIR=/mnt/math-for-agents-backups",
      "MFA_BASE_URL=http://127.0.0.1:4173",
      "MFA_PUBLIC_ORIGIN=http://127.0.0.1:4173"
    ].join("\n")
  );

  const localUrl = await runDeployPreflight({
    cwd: process.cwd(),
    envFile: localUrlEnv,
    baseEnv: {}
  });
  assert.equal(localUrl.ok, false);
  assert.ok(localUrl.checks.some((check) => !check.ok && check.error.includes("https://")));

  const badVerifierEnv = path.join(tmp, ".env.production.bad-verifier");
  await writeFile(
    badVerifierEnv,
    [
      "POSTGRES_PASSWORD=privatebetapostgres32",
      "MFA_HUMAN_EMAIL=max@example.com",
      "MFA_HUMAN_PASSWORD=private-beta-human-password",
      "MFA_HUMAN_KEY=mfa_private_beta_key_32_chars",
      "MFA_DEFAULT_VERIFIER_AGENT_ID=private-beta-verifier",
      "MFA_COOKIE_SECURE=true",
      "MFA_WORKER_RUNNER=docker",
      "ARTIFACT_MAX_BYTES=10000000",
      "BACKUP_REMOTE_DIR=/mnt/math-for-agents-backups",
      "MFA_BASE_URL=https://math-for-agents.example.com",
      "MFA_PUBLIC_ORIGIN=https://math-for-agents.example.com"
    ].join("\n")
  );

  const badVerifier = await runDeployPreflight({
    cwd: process.cwd(),
    envFile: badVerifierEnv,
    baseEnv: {}
  });
  assert.equal(badVerifier.ok, false);
  assert.ok(badVerifier.checks.some((check) => !check.ok && check.error.includes("agent:")));
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log("deploy preflight checks passed.");
