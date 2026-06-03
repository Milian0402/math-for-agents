#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseEnvText } from "./deploy-preflight.mjs";

const EXTERNAL_REQUIREMENTS = [
  {
    key: "host",
    env: "MFA_EXTERNAL_HOSTING_READY",
    description: "Vercel project or VM/domain is provisioned"
  },
  {
    key: "postgres",
    env: "MFA_EXTERNAL_POSTGRES_READY",
    description: "Hosted Postgres exists, is durable, and has credentials in the deploy env"
  },
  {
    key: "artifacts",
    env: "MFA_EXTERNAL_ARTIFACT_STORAGE_READY",
    description: "Durable artifact storage exists: mounted local-file storage or private Vercel Blob"
  },
  {
    key: "worker",
    env: "MFA_EXTERNAL_WORKER_READY",
    description: "Worker host exists, or machine verification is explicitly manual for beta"
  },
  {
    key: "backups",
    env: "MFA_EXTERNAL_BACKUPS_READY",
    description: "Postgres and artifact backup/restore plan exists and has an owner"
  },
  {
    key: "monitoring",
    env: "MFA_EXTERNAL_MONITORING_READY",
    description: "Uptime monitor or scheduled healthcheck alerts on failure"
  },
  {
    key: "logs",
    env: "MFA_EXTERNAL_LOGS_READY",
    description: "Private log/error sink is configured and request IDs are findable"
  }
];

const OPTIONAL_DETAIL_VARS = [
  "MFA_EXTERNAL_HOSTING_URL",
  "MFA_EXTERNAL_POSTGRES_URL",
  "MFA_EXTERNAL_ARTIFACT_STORAGE_URL",
  "MFA_EXTERNAL_WORKER_URL",
  "MFA_EXTERNAL_BACKUP_RUNBOOK",
  "MFA_EXTERNAL_MONITORING_URL",
  "MFA_EXTERNAL_LOGS_URL"
];

export async function runExternalLaunchCheck(options = {}) {
  const cwd = options.cwd || process.cwd();
  const envFile = options.envFile === undefined ? null : options.envFile;
  const fileEnv = envFile ? parseEnvText(await readFile(envFile, "utf8"), envFile) : {};
  const env = { ...(options.baseEnv || process.env), ...fileEnv };
  const requirements = EXTERNAL_REQUIREMENTS.map((requirement) => {
    const value = String(env[requirement.env] || "").trim().toLowerCase();
    return {
      key: requirement.key,
      env: requirement.env,
      ok: value === "true",
      value: value || null,
      description: requirement.description
    };
  });
  const details = Object.fromEntries(
    OPTIONAL_DETAIL_VARS.map((name) => [name, String(env[name] || "").trim() || null])
  );

  return {
    ok: requirements.every((requirement) => requirement.ok),
    env_file: envFile ? path.relative(cwd, envFile) || path.basename(envFile) : null,
    checked_at: new Date().toISOString(),
    requirements,
    details,
    missing: requirements.filter((requirement) => !requirement.ok).map((requirement) => requirement.env)
  };
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const key = arg.startsWith("--") ? arg.slice(2) : "";
    if (!key) throw new Error(`unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    index += 1;
    if (key === "env-file") options.envFile = path.resolve(process.cwd(), value);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return `Usage:
  npm run launch:external-check
  npm run launch:external-check -- --env-file .env.production

Set these to true only after the operator-owned resource exists:
${EXTERNAL_REQUIREMENTS.map((requirement) => `  ${requirement.env}=true  # ${requirement.description}`).join("\n")}
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      runExternalLaunchCheck(options)
        .then((result) => {
          const output = JSON.stringify(result, null, 2);
          if (result.ok) console.log(output);
          else {
            console.error(output);
            process.exitCode = 1;
          }
        })
        .catch((error) => {
          console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
          process.exitCode = 1;
        });
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
