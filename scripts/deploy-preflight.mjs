#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { assertWebRuntimeConfig, assertWorkerRuntimeConfig } from "../server/config.js";

const REQUIRED_FILES = [
  "Dockerfile",
  "deploy/compose.production.yml",
  "server/schema.sql",
  "server/migrate.mjs",
  "server/bootstrap-admin.mjs",
  "scripts/backup.sh",
  "scripts/restore.sh",
  "scripts/healthcheck.mjs"
];

const REQUIRED_PACKAGE_SCRIPTS = [
  "db:migrate",
  "auth:bootstrap",
  "backup",
  "backup:verify",
  "restore",
  "healthcheck",
  "smoke:release"
];

const COMPOSE_MARKERS = [
  "services:",
  "db:",
  "web:",
  "worker:",
  "NODE_ENV: production",
  "condition: service_healthy",
  "artifact_data:",
  "/var/run/docker.sock:/var/run/docker.sock"
];

const RESERVED_URL_CHARS = /[\s:/?#\[\]@]/;

export async function runDeployPreflight(options = {}) {
  const cwd = options.cwd || process.cwd();
  const envFile = options.envFile === undefined ? defaultEnvFile(cwd) : options.envFile;
  const fileEnv = envFile ? parseEnvText(await readFile(envFile, "utf8"), envFile) : {};
  const env = { ...(options.baseEnv || process.env), ...fileEnv };
  const { mode, webEnv, workerEnv } = buildEffectiveEnvironments(env);
  const checks = [];
  const warnings = [];

  await addAsyncCheck(checks, "required deploy files", async () => {
    for (const file of REQUIRED_FILES) {
      await access(path.join(cwd, file));
    }
  });

  await addAsyncCheck(checks, "package release scripts", async () => {
    const packageJson = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    for (const script of REQUIRED_PACKAGE_SCRIPTS) {
      if (!packageJson.scripts?.[script]) throw new Error(`missing package script: ${script}`);
    }
  });

  await addAsyncCheck(checks, "production compose shape", async () => {
    const compose = await readFile(path.join(cwd, "deploy/compose.production.yml"), "utf8");
    for (const marker of COMPOSE_MARKERS) {
      if (!compose.includes(marker)) throw new Error(`compose file missing marker: ${marker}`);
    }
  });

  addCheck(checks, "human owner env", () => {
    requireNonPlaceholder(webEnv.MFA_HUMAN_EMAIL, "MFA_HUMAN_EMAIL");
    if (!webEnv.MFA_HUMAN_EMAIL.includes("@")) throw new Error("MFA_HUMAN_EMAIL must be an email address");
    requireNonPlaceholder(webEnv.MFA_HUMAN_PASSWORD, "MFA_HUMAN_PASSWORD");
    requireNonPlaceholder(webEnv.MFA_HUMAN_KEY, "MFA_HUMAN_KEY");
  });

  addCheck(checks, "database env", () => {
    if (mode === "compose") {
      requireNonPlaceholder(env.POSTGRES_PASSWORD, "POSTGRES_PASSWORD");
      if (env.POSTGRES_PASSWORD === "math_for_agents") {
        throw new Error("POSTGRES_PASSWORD must not use the local development default");
      }
      if (String(env.POSTGRES_PASSWORD).length < 16) {
        throw new Error("POSTGRES_PASSWORD must be at least 16 characters");
      }
      if (RESERVED_URL_CHARS.test(env.POSTGRES_PASSWORD)) {
        throw new Error("POSTGRES_PASSWORD must avoid spaces and URL-reserved characters for the compose DATABASE_URL");
      }
      return;
    }
    requireNonPlaceholder(webEnv.DATABASE_URL, "DATABASE_URL");
  });

  addCheck(checks, "web runtime config", () => assertWebRuntimeConfig(webEnv));
  addCheck(checks, "worker runtime config", () => assertWorkerRuntimeConfig(workerEnv));

  addCheck(checks, "artifact limits", () => {
    const maxBytes = Number(webEnv.ARTIFACT_MAX_BYTES);
    if (!Number.isInteger(maxBytes) || maxBytes < 1_000_000) {
      throw new Error("ARTIFACT_MAX_BYTES should be at least 1000000 for a private beta");
    }
  });

  if (!envFile) warnings.push("no env file was loaded; checked current process env only");
  if (!env.BACKUP_REMOTE_DIR) warnings.push("BACKUP_REMOTE_DIR is not set; configure mounted off-host storage before real beta traffic");
  if (!env.MFA_BASE_URL || /^https?:\/\/(127\.0\.0\.1|localhost)/.test(env.MFA_BASE_URL)) {
    warnings.push("MFA_BASE_URL is not a public/private-beta URL; healthcheck examples will still point at localhost");
  }
  if (workerEnv.MFA_WORKER_RUNNER === "docker") {
    warnings.push("docker worker runner uses the host Docker socket; run it only on a dedicated VM");
  }
  if (webEnv.MFA_ALLOW_INSECURE_COOKIES === "true") {
    warnings.push("MFA_ALLOW_INSECURE_COOKIES=true is only acceptable for trusted HTTP-only private deploys");
  }

  return {
    ok: checks.every((check) => check.ok),
    mode,
    env_file: envFile ? path.relative(cwd, envFile) || path.basename(envFile) : null,
    checks,
    warnings
  };
}

export function buildEffectiveEnvironments(env) {
  const mode = env.POSTGRES_PASSWORD ? "compose" : "standalone";
  const databaseUrl =
    mode === "compose"
      ? `postgres://${env.POSTGRES_USER || "math_for_agents"}:${env.POSTGRES_PASSWORD || ""}@db:5432/${
          env.POSTGRES_DB || "math_for_agents"
        }`
      : env.DATABASE_URL || "";
  const cookieSecure =
    env.MFA_COOKIE_SECURE !== undefined
      ? env.MFA_COOKIE_SECURE
      : env.MFA_ALLOW_INSECURE_COOKIES === "true"
        ? "false"
        : "true";

  const common = {
    ...env,
    NODE_ENV: "production",
    DATABASE_URL: databaseUrl,
    DATABASE_SSL: mode === "compose" ? "false" : env.DATABASE_SSL || "false",
    ARTIFACT_STORAGE_DIR: mode === "compose" ? "/data/artifacts" : env.ARTIFACT_STORAGE_DIR || "",
    ARTIFACT_MAX_BYTES: env.ARTIFACT_MAX_BYTES || "10000000",
    MFA_COOKIE_SECURE: cookieSecure
  };

  return {
    mode,
    webEnv: common,
    workerEnv: {
      ...common,
      MFA_WORKER_RUNNER: env.MFA_WORKER_RUNNER || "docker"
    }
  };
}

export function parseEnvText(text, source = "env") {
  const env = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) throw new Error(`${source}:${index + 1}: invalid env line`);
    env[match[1]] = unquoteEnvValue(match[2].trim());
  }
  return env;
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    const inner = value.slice(1, -1);
    if (value.startsWith('"')) return inner.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    return inner;
  }
  return value;
}

function defaultEnvFile(cwd) {
  return path.join(cwd, ".env.production");
}

async function addAsyncCheck(checks, name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error.message });
  }
}

function addCheck(checks, name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error.message });
  }
}

function requireNonPlaceholder(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  if (/^<.*>$/.test(normalized) || /^(changeme|change-me|password|secret)$/i.test(normalized)) {
    throw new Error(`${name} must not be a placeholder`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const envFileArg = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : defaultEnvFile(process.cwd());
  runDeployPreflight({ envFile: envFileArg })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
