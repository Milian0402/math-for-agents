import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseArgs, runProductionBootstrap } from "./bootstrap-production.mjs";

const tmp = await mkdtemp(path.join(os.tmpdir(), "mfa-bootstrap-check-"));

try {
  const envFile = path.join(tmp, ".env.production");
  await writeFile(
    envFile,
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

  const calls = [];
  const result = await runProductionBootstrap({
    cwd: process.cwd(),
    envFile,
    baseEnv: {},
    runStep: async (step, options) => {
      calls.push({ step, env: options.env });
      return {
        ok: true,
        duration_ms: 1,
        stdout: `${step.name} ok`,
        stderr: "",
        exit_code: 0
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "vercel");
  assert.deepEqual(
    result.steps.map((step) => step.name),
    ["db:migrate", "auth:bootstrap", "agents:bootstrap-verifier"]
  );
  assert.equal(calls[0].env.DATABASE_SSL, "true");
  assert.equal(calls[0].env.ARTIFACT_STORAGE_DRIVER, "vercel-blob");
  assert.equal(calls[0].env.BLOB_READ_WRITE_TOKEN, "vercel_blob_rw_private_beta_token");

  const failed = await runProductionBootstrap({
    cwd: process.cwd(),
    envFile,
    baseEnv: {},
    runStep: async (step) => ({
      ok: step.name !== "auth:bootstrap",
      duration_ms: 1,
      stdout: "",
      stderr: step.name === "auth:bootstrap" ? "bad auth bootstrap" : "",
      exit_code: step.name === "auth:bootstrap" ? 1 : 0
    })
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(
    failed.steps.map((step) => step.name),
    ["db:migrate", "auth:bootstrap"]
  );
  assert.match(failed.steps.at(-1).stderr, /bad auth bootstrap/);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

assert.deepEqual(parseArgs(["--env-file", ".env.production"]), {
  envFile: path.resolve(process.cwd(), ".env.production")
});
assert.deepEqual(parseArgs(["--no-env-file"]), { envFile: null });
assert.throws(() => parseArgs(["--env-file"]), /requires a value/);

console.log("production bootstrap checks passed.");
