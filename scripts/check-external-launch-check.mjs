import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseArgs, runExternalLaunchCheck } from "./external-launch-check.mjs";

const missing = await runExternalLaunchCheck({
  baseEnv: {},
  envFile: null
});
assert.equal(missing.ok, false);
assert.ok(missing.missing.includes("MFA_EXTERNAL_HOSTING_READY"));
assert.equal(missing.requirements.length, 7);

const readyEnv = {
  MFA_EXTERNAL_HOSTING_READY: "true",
  MFA_EXTERNAL_POSTGRES_READY: "true",
  MFA_EXTERNAL_ARTIFACT_STORAGE_READY: "true",
  MFA_EXTERNAL_WORKER_READY: "true",
  MFA_EXTERNAL_BACKUPS_READY: "true",
  MFA_EXTERNAL_MONITORING_READY: "true",
  MFA_EXTERNAL_LOGS_READY: "true",
  MFA_EXTERNAL_HOSTING_URL: "https://math-for-agents.example.com",
  MFA_EXTERNAL_BACKUP_RUNBOOK: "https://ops.example.com/math-for-agents/backups"
};
const ready = await runExternalLaunchCheck({
  baseEnv: readyEnv,
  envFile: null
});
assert.equal(ready.ok, true);
assert.deepEqual(ready.missing, []);
assert.equal(ready.details.MFA_EXTERNAL_HOSTING_URL, "https://math-for-agents.example.com");
assert.equal(ready.details.MFA_EXTERNAL_BACKUP_RUNBOOK, "https://ops.example.com/math-for-agents/backups");

const tmp = await mkdtemp(path.join(os.tmpdir(), "mfa-external-launch-check-"));
try {
  const envFile = path.join(tmp, ".env.external");
  await writeFile(
    envFile,
    [
      "MFA_EXTERNAL_HOSTING_READY=true",
      "MFA_EXTERNAL_POSTGRES_READY=true",
      "MFA_EXTERNAL_ARTIFACT_STORAGE_READY=true",
      "MFA_EXTERNAL_WORKER_READY=true",
      "MFA_EXTERNAL_BACKUPS_READY=true",
      "MFA_EXTERNAL_MONITORING_READY=true",
      "MFA_EXTERNAL_LOGS_READY=true"
    ].join("\n")
  );
  assert.equal((await runExternalLaunchCheck({ baseEnv: {}, envFile })).ok, true);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

assert.deepEqual(parseArgs(["--env-file", ".env.production"]), {
  envFile: path.resolve(process.cwd(), ".env.production")
});
assert.throws(() => parseArgs(["--env-file"]), /requires a value/);

console.log("external launch checks passed.");
