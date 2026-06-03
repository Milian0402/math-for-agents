#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildEffectiveEnvironments, parseEnvText, runDeployPreflight } from "./deploy-preflight.mjs";

const BOOTSTRAP_STEPS = [
  { name: "db:migrate", args: ["server/migrate.mjs"] },
  { name: "auth:bootstrap", args: ["server/bootstrap-admin.mjs"] },
  { name: "agents:bootstrap-verifier", args: ["server/bootstrap-verifier.mjs"] }
];

export async function runProductionBootstrap(options = {}) {
  const cwd = options.cwd || process.cwd();
  const envFile = options.envFile === undefined ? path.join(cwd, ".env.production") : options.envFile;
  const baseEnv = options.baseEnv || process.env;
  const fileEnv = envFile ? parseEnvText(await readFile(envFile, "utf8"), envFile) : {};
  const rawEnv = { ...baseEnv, ...fileEnv };
  const { mode, webEnv } = buildEffectiveEnvironments(rawEnv);
  const stepEnv = { ...baseEnv, ...webEnv };
  const runStep = options.runStep || runNodeStep;
  const steps = [];

  const preflight = await runDeployPreflight({ cwd, envFile, baseEnv });
  if (!preflight.ok) {
    return {
      ok: false,
      mode,
      env_file: envFile ? path.relative(cwd, envFile) || path.basename(envFile) : null,
      warnings: preflight.warnings,
      failed_checks: preflight.checks.filter((check) => !check.ok).map((check) => check.name),
      steps
    };
  }

  for (const step of BOOTSTRAP_STEPS) {
    const result = await runStep(step, { cwd, env: stepEnv });
    steps.push({ name: step.name, ...result });
    if (!result.ok) {
      return {
        ok: false,
        mode,
        env_file: envFile ? path.relative(cwd, envFile) || path.basename(envFile) : null,
        warnings: preflight.warnings,
        failed_checks: [],
        steps
      };
    }
  }

  return {
    ok: true,
    mode,
    env_file: envFile ? path.relative(cwd, envFile) || path.basename(envFile) : null,
    warnings: preflight.warnings,
    failed_checks: [],
    steps
  };
}

async function runNodeStep(step, options) {
  const startedAt = Date.now();
  const result = await runProcess(process.execPath, step.args, {
    cwd: options.cwd,
    env: options.env
  });

  return {
    ok: result.status === 0,
    duration_ms: Date.now() - startedAt,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exit_code: result.status
  };
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--no-env-file") {
      options.envFile = null;
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
  npm run launch:bootstrap -- --env-file .env.production
  npm run launch:bootstrap -- --no-env-file

Options:
  --env-file <path>  Production env file, default .env.production
  --no-env-file      Use the current process env, useful inside Docker Compose
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      runProductionBootstrap(options)
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
