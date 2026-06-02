import {
  CLAIM_TYPES,
  EVIDENCE_LEVELS,
  POST_STATUSES,
  POST_TYPES,
  PRIORITIES,
  VERIFICATION_METHODS,
  VERIFICATION_STATUSES,
  MACHINE_METHODS,
  requiresReplay
} from "../src/vocab.js";

const CONTRIBUTION_FIELDS = new Set([
  "agent",
  "problem_id",
  "assignment_id",
  "type",
  "body",
  "dependencies",
  "evidence_level",
  "status",
  "claim_type",
  "claim_statement",
  "priority",
  "verifier",
  "artifact_id",
  "artifact_kind",
  "artifact_title",
  "artifact_path",
  "artifact_summary",
  "artifact_metadata",
  "replay",
  "replay_command",
  "replay_seed",
  "replay_env",
  "replay_output_hash"
]);

const ARTIFACT_FIELDS = new Set([
  "problem_id",
  "owner",
  "kind",
  "title",
  "summary",
  "path",
  "content_hash",
  "metadata"
]);

const VERIFICATION_PATCH_FIELDS = new Set(["status", "method", "artifact_id", "notes", "checklist"]);

export class RequestValidationError extends Error {
  constructor(errors) {
    super(errors.join("; "));
    this.name = "RequestValidationError";
    this.statusCode = 422;
    this.errors = errors;
  }
}

export function assertContributionInput(input) {
  const errors = [];
  rejectUnknownFields(input, CONTRIBUTION_FIELDS, errors);
  requireString(input.agent, "agent", errors);
  requireString(input.problem_id, "problem_id", errors);
  requireString(input.type, "type", errors);
  requireString(input.body, "body", errors);
  requireEnum(input.type, POST_TYPES, "type", errors);
  requireEnum(input.evidence_level, EVIDENCE_LEVELS, "evidence_level", errors);
  if (input.status) requireEnum(input.status, POST_STATUSES, "status", errors);
  if (input.claim_type) requireEnum(input.claim_type, CLAIM_TYPES, "claim_type", errors);
  if (input.priority) requireEnum(input.priority, PRIORITIES, "priority", errors);
  if (input.dependencies && !isStringArray(input.dependencies)) {
    errors.push("dependencies must be an array of strings");
  }
  if (requiresReplay(input.evidence_level) && !replayCommand(input)) {
    errors.push(`${input.evidence_level} contributions require replay.command`);
  }
  throwIfErrors(errors);
}

export function assertArtifactInput(input) {
  const errors = [];
  rejectUnknownFields(input, ARTIFACT_FIELDS, errors);
  requireString(input.problem_id, "problem_id", errors);
  requireString(input.owner, "owner", errors);
  requireString(input.kind, "kind", errors);
  requireString(input.title, "title", errors);
  requireString(input.summary, "summary", errors);
  requireString(input.path, "path", errors);
  throwIfErrors(errors);
}

export function assertVerificationPatch(input) {
  const errors = [];
  rejectUnknownFields(input, VERIFICATION_PATCH_FIELDS, errors);
  if (input.status) requireEnum(input.status, VERIFICATION_STATUSES, "status", errors);
  if (input.method) requireEnum(input.method, VERIFICATION_METHODS, "method", errors);
  if (input.checklist && !isStringArray(input.checklist)) {
    errors.push("checklist must be an array of strings");
  }
  if (input.status === "passed" && MACHINE_METHODS.includes(input.method || "") && !input.artifact_id) {
    errors.push(`passed ${input.method} checks require artifact_id`);
  }
  throwIfErrors(errors);
}

export function replayCommand(input) {
  return input.replay_command?.trim?.() || input.replay?.command?.trim?.() || "";
}

function rejectUnknownFields(input, allowedFields, errors) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    errors.push("request body must be a JSON object");
    return;
  }
  for (const key of Object.keys(input)) {
    if (!allowedFields.has(key)) errors.push(`unknown field: ${key}`);
  }
}

function requireString(value, field, errors) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${field} is required`);
  }
}

function requireEnum(value, allowed, field, errors) {
  if (!allowed.includes(value)) {
    errors.push(`${field} must be one of: ${allowed.join(", ")}`);
  }
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function throwIfErrors(errors) {
  if (errors.length) throw new RequestValidationError(errors);
}
