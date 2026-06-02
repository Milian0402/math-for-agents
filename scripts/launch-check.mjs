#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runAgentCheck } from "./agent-check.mjs";
import { parseEnvText, runDeployPreflight } from "./deploy-preflight.mjs";
import { runHealthcheck } from "./healthcheck.mjs";

const DEFAULT_TIMEOUT_MS = 5_000;

export async function runLaunchCheck(options = {}) {
  const cwd = options.cwd || process.cwd();
  const envFile = options.envFile === undefined ? path.join(cwd, ".env.production") : options.envFile;
  const baseEnv = options.baseEnv || process.env;
  const fileEnv = envFile ? await readEnvFile(envFile) : { ok: true, env: {}, error: "" };
  const env = { ...baseEnv, ...fileEnv.env };
  const baseUrl = normalizeBaseUrl(options.baseUrl || env.MFA_BASE_URL || "");
  const agentKey = options.agentKey ?? env.MFA_AGENT_KEY ?? env.MFA_HEALTHCHECK_BEARER ?? "";
  const problemId = options.problemId || env.MFA_AGENT_PROBLEM_ID || "";
  const timeoutMs = Number(
    options.timeoutMs || env.MFA_LAUNCH_CHECK_TIMEOUT_MS || env.MFA_AGENT_CHECK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS
  );
  const fetchImpl = options.fetchImpl || fetch;
  const checks = [];
  const startedAt = Date.now();

  await addResultCheck(checks, "production_env", async () => {
    if (!fileEnv.ok) throw new Error(fileEnv.error);
    return summarizePreflight(
      await runDeployPreflight({
        cwd,
        envFile,
        baseEnv
      })
    );
  });

  await addResultCheck(checks, "public_healthcheck", async () => {
    if (!baseUrl) throw new Error("MFA_BASE_URL is required");
    return summarizeHealthcheck(
      await runHealthcheck({
        baseUrl,
        timeoutMs,
        fetchImpl
      })
    );
  });

  await addResultCheck(checks, "authenticated_healthcheck", async () => {
    if (!baseUrl) throw new Error("MFA_BASE_URL is required");
    if (!agentKey) throw new Error("MFA_AGENT_KEY or MFA_HEALTHCHECK_BEARER is required");
    return summarizeHealthcheck(
      await runHealthcheck({
        baseUrl,
        bearer: agentKey,
        checkAssignments: true,
        timeoutMs,
        fetchImpl
      })
    );
  });

  await addResultCheck(checks, "agent_launch", async () => {
    if (!baseUrl) throw new Error("MFA_BASE_URL is required");
    if (!agentKey) throw new Error("MFA_AGENT_KEY or MFA_HEALTHCHECK_BEARER is required");
    if (!problemId) throw new Error("MFA_AGENT_PROBLEM_ID is required");
    return summarizeAgentCheck(
      await runAgentCheck({
        baseUrl,
        agentKey,
        problemId,
        timeoutMs,
        fetchImpl
      })
    );
  });

  return {
    ok: checks.every((check) => check.ok),
    base_url: baseUrl || null,
    env_file: envFile ? path.relative(cwd, envFile) || path.basename(envFile) : null,
    problem_id: problemId || null,
    checked_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    checks
  };
}

function summarizePreflight(preflight) {
  return {
    ok: preflight.ok,
    mode: preflight.mode,
    warnings: preflight.warnings,
    failed_checks: preflight.checks.filter((check) => !check.ok).map((check) => check.name)
  };
}

function summarizeHealthcheck(healthcheck) {
  return {
    ok: healthcheck.ok,
    base_url: healthcheck.base_url,
    failed_checks: healthcheck.checks.filter((check) => !check.ok).map((check) => check.name),
    checks: healthcheck.checks.map((check) => ({
      name: check.name,
      ok: check.ok,
      error: check.error
    }))
  };
}

function summarizeAgentCheck(agentCheck) {
  return {
    ok: agentCheck.ok,
    agent_id: agentCheck.agent_id,
    problem_id: agentCheck.problem_id,
    failed_checks: agentCheck.checks.filter((check) => !check.ok).map((check) => check.name),
    checks: agentCheck.checks.map((check) => ({
      name: check.name,
      ok: check.ok,
      error: check.error
    }))
  };
}

async function addResultCheck(checks, name, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    checks.push({ name, duration_ms: Date.now() - startedAt, ...result });
  } catch (error) {
    checks.push({ name, ok: false, duration_ms: Date.now() - startedAt, error: error.message });
  }
}

async function readEnvFile(envFile) {
  try {
    return {
      ok: true,
      env: parseEnvText(await readFile(envFile, "utf8"), envFile),
      error: ""
    };
  } catch (error) {
    return { ok: false, env: {}, error: error.message };
  }
}

function parseArgs(argv) {
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
    else if (key === "base-url") options.baseUrl = value;
    else if (key === "agent-key") options.agentKey = value;
    else if (key === "problem-id") options.problemId = value;
    else if (key === "timeout-ms") options.timeoutMs = Number(value);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return `Usage:
  MFA_AGENT_KEY=<agent-key> MFA_AGENT_PROBLEM_ID=<problem-id> npm run launch:check

Options:
  --env-file <path>       Production env file, default .env.production
  --base-url <url>        Override MFA_BASE_URL
  --agent-key <key>       Override MFA_AGENT_KEY without printing it
  --problem-id <id>       Override MFA_AGENT_PROBLEM_ID
  --timeout-ms <ms>       HTTP timeout for public and authenticated checks
`;
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      runLaunchCheck(options)
        .then((result) => {
          const output = JSON.stringify(result, null, 2);
          if (result.ok) {
            console.log(output);
          } else {
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
