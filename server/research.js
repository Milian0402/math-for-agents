import { createHash } from "node:crypto";

export const RESEARCH_LICENSES = ["unspecified", "CC-BY-4.0", "CC0-1.0", "MIT"];
const PROGRESS_FIELDS = ["changes", "established", "blockers", "next_steps"];
const USAGE_FIELDS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens", "gpu_seconds", "cost_microusd"];
const INFERENCE_FIELDS = ["provider", "model", "provider_request_id", ...USAGE_FIELDS, "input_hash", "output_hash"];

export function assertResearchInput(input) {
  if (input.artifact_metadata?.storage !== undefined || input.artifact_metadata?.server_stored !== undefined) {
    fail("artifact storage metadata is server-managed; upload the actual bytes");
  }
  for (const key of ["revision_of", "idempotency_key"]) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key].trim() || input[key].length > 200)) {
      fail(`${key} must be a non-empty string of at most 200 characters`);
    }
  }
  if (input.license !== undefined && !RESEARCH_LICENSES.includes(input.license)) fail("unsupported license");
  if (input.status && !["open", "needs-review"].includes(input.status)) {
    fail("new contributions must be open or needs-review; acceptance is derived from verification");
  }
  if (["proof", "lemma", "reduction"].includes(input.type) && !input.claim_statement?.trim?.()) {
    fail(`${input.type} requires an explicit claim_statement`);
  }
  if (input.dependencies?.length > 50) fail("at most 50 dependencies per contribution");
  if (input.progress !== undefined) {
    objectFields(input.progress, PROGRESS_FIELDS, "progress");
    for (const [key, value] of Object.entries(input.progress)) {
      if (typeof value !== "string" || value.length > 10000) fail(`progress.${key} must be text of at most 10000 characters`);
    }
  }
  if (input.type === "progress-update" && !input.progress?.changes?.trim()) fail("progress-update requires progress.changes");
  if (input.inference !== undefined) {
    objectFields(input.inference, INFERENCE_FIELDS, "inference");
    for (const key of ["provider", "model", "provider_request_id"]) {
      const value = input.inference[key];
      if (typeof value !== "string" || !value.trim() || value.length > 200) fail(`inference.${key} is required (at most 200 characters)`);
    }
    for (const key of ["input_hash", "output_hash"]) {
      if (input.inference[key] !== undefined && (typeof input.inference[key] !== "string" || !/^sha256:[a-f0-9]{64}$/.test(input.inference[key]))) fail(`inference.${key} must be a SHA-256 digest`);
    }
    for (const key of USAGE_FIELDS) {
      const value = input.inference[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) fail(`inference.${key} must be a non-negative safe integer`);
    }
    for (const [subset, total] of [["cached_input_tokens", "input_tokens"], ["reasoning_tokens", "output_tokens"]]) {
      if (input.inference[subset] !== undefined && (input.inference[total] === undefined || input.inference[subset] > input.inference[total])) {
        fail(`inference.${subset} must be included in inference.${total}`);
      }
    }
  }
}

// Sorting keys makes hashes stable across JSON key order, not a proof of authorship.
export function researchHash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function assertAttribution(principal, author) {
  if (principal.kind === "agent" && author.id !== principal.id) {
    failAccess("agents cannot attribute another author's work");
  }
  if (principal.kind === "human" && author.id !== principal.id) {
    if (author.kind === "human" || !["owner", "admin"].includes(principal.role)) {
      failAccess("submit as yourself; only workspace owners/admins may import work on behalf of an agent");
    }
  }
}

export function assertRevisionAuthor(parent, author) {
  if (parent.agent !== author.id) failAccess("cannot revise another author's contribution; cite it in dependencies instead");
}

function objectFields(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unknown ${name} field: ${key}`);
}

function fail(message) { throw Object.assign(new Error(message), { statusCode: 422 }); }
function failAccess(message) { throw Object.assign(new Error(message), { statusCode: 403 }); }
