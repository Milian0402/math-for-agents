import path from "node:path";

const DEV_HUMAN_KEYS = new Set(["mfa_dev_human_key"]);
const DEV_HUMAN_PASSWORDS = new Set(["mfa_dev_password"]);
const VALID_WORKER_RUNNERS = new Set(["disabled", "docker", "local"]);

export function assertWebRuntimeConfig(env = process.env) {
  const errors = commonRuntimeErrors(env);
  if (isProduction(env)) {
    requireSecureCookieConfig(env, errors);
    rejectWeakOptionalSecret(env, "MFA_HUMAN_KEY", DEV_HUMAN_KEYS, 24, errors);
    rejectWeakOptionalSecret(env, "MFA_HUMAN_PASSWORD", DEV_HUMAN_PASSWORDS, 12, errors);
  }
  throwConfigErrors(errors);
}

export function assertWorkerRuntimeConfig(env = process.env) {
  const errors = commonRuntimeErrors(env);
  const runner = env.MFA_WORKER_RUNNER || "disabled";
  if (!VALID_WORKER_RUNNERS.has(runner)) {
    errors.push("MFA_WORKER_RUNNER must be one of: disabled, docker, local");
  }
  if (isProduction(env) && runner === "disabled") {
    errors.push("MFA_WORKER_RUNNER must not be disabled for the production worker process");
  }
  if (runner === "local" && env.MFA_WORKER_ALLOW_LOCAL !== "true") {
    errors.push("MFA_WORKER_ALLOW_LOCAL=true is required when MFA_WORKER_RUNNER=local");
  }
  throwConfigErrors(errors);
}

function commonRuntimeErrors(env) {
  const errors = [];
  requireEnv(env, "DATABASE_URL", errors);
  if (env.ARTIFACT_MAX_BYTES) {
    requirePositiveInteger(env, "ARTIFACT_MAX_BYTES", errors);
  }

  if (isProduction(env)) {
    requireEnv(env, "ARTIFACT_STORAGE_DIR", errors);
    requirePositiveInteger(env, "ARTIFACT_MAX_BYTES", errors);
    if (env.DATABASE_URL?.includes("math_for_agents:math_for_agents@")) {
      errors.push("DATABASE_URL must not use the default local development Postgres password in production");
    }
    if (env.ARTIFACT_STORAGE_DIR && !path.isAbsolute(env.ARTIFACT_STORAGE_DIR)) {
      errors.push("ARTIFACT_STORAGE_DIR must be an absolute path in production");
    }
  }

  return errors;
}

function requireSecureCookieConfig(env, errors) {
  if (env.MFA_COOKIE_SECURE !== "true" && env.MFA_ALLOW_INSECURE_COOKIES !== "true") {
    errors.push("MFA_COOKIE_SECURE=true is required in production unless MFA_ALLOW_INSECURE_COOKIES=true is set for a trusted local deploy");
  }
}

function rejectWeakOptionalSecret(env, name, devValues, minLength, errors) {
  const value = String(env[name] || "");
  if (!value) return;
  if (devValues.has(value)) {
    errors.push(`${name} must not use the development default in production`);
  }
  if (value.length < minLength) {
    errors.push(`${name} must be at least ${minLength} characters in production`);
  }
}

function requireEnv(env, name, errors) {
  if (!String(env[name] || "").trim()) {
    errors.push(`${name} is required`);
  }
}

function requirePositiveInteger(env, name, errors) {
  const value = Number(env[name]);
  if (!Number.isInteger(value) || value <= 0) {
    errors.push(`${name} must be a positive integer`);
  }
}

function isProduction(env) {
  return env.NODE_ENV === "production";
}

function throwConfigErrors(errors) {
  if (!errors.length) return;
  const error = new Error(`Runtime config is invalid:\n- ${errors.join("\n- ")}`);
  error.name = "RuntimeConfigError";
  throw error;
}
