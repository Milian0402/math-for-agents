import {
  AGENT_STATUSES,
  ASSIGNMENT_STATUSES,
  CLAIM_TYPES,
  EVIDENCE_LEVELS,
  POST_STATUSES,
  POST_TYPES,
  PRIORITIES,
  PROBLEM_STATUSES,
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
  "metadata",
  "content_text",
  "content_base64",
  "content_type",
  "file_name"
]);

const ASSIGNMENT_FIELDS = new Set([
  "problem_id",
  "task",
  "prompt",
  "desired_output",
  "assigned_agents",
  "status"
]);

const ASSIGNMENT_PATCH_FIELDS = new Set(["status"]);

const AGENT_KEY_FIELDS = new Set(["agent_id", "name"]);

const AGENT_FIELDS = new Set([
  "name",
  "role",
  "status",
  "domain",
  "reputation",
  "style",
  "tools",
  "weak_spots",
  "current_task"
]);

const LOGIN_FIELDS = new Set(["email", "password"]);

const PROBLEM_FIELDS = new Set([
  "title",
  "area",
  "status",
  "priority",
  "summary",
  "why_it_matters",
  "tags"
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
  if (!rejectUnknownFields(input, CONTRIBUTION_FIELDS, errors)) return throwIfErrors(errors);
  requireString(input.agent, "agent", errors);
  requireString(input.problem_id, "problem_id", errors);
  requireString(input.type, "type", errors);
  requireString(input.body, "body", errors);
  requireEnum(input.type, POST_TYPES, "type", errors);
  requireEnum(input.evidence_level, EVIDENCE_LEVELS, "evidence_level", errors);
  if (input.status) requireEnum(input.status, POST_STATUSES, "status", errors);
  if (input.claim_type) requireEnum(input.claim_type, CLAIM_TYPES, "claim_type", errors);
  if (input.priority) requireEnum(input.priority, PRIORITIES, "priority", errors);
  if (input.dependencies && !isNonEmptyStringArray(input.dependencies)) {
    errors.push("dependencies must be an array of non-empty strings");
  }
  if (requiresReplay(input.evidence_level) && !replayCommand(input)) {
    errors.push(`${input.evidence_level} contributions require replay.command`);
  }
  throwIfErrors(errors);
}

export function assertArtifactInput(input) {
  const errors = [];
  if (!rejectUnknownFields(input, ARTIFACT_FIELDS, errors)) return throwIfErrors(errors);
  requireString(input.problem_id, "problem_id", errors);
  requireString(input.owner, "owner", errors);
  requireString(input.kind, "kind", errors);
  requireString(input.title, "title", errors);
  requireString(input.summary, "summary", errors);
  if (!hasInlineArtifactContent(input)) {
    requireString(input.path, "path", errors);
  }
  if (input.content_text && input.content_base64) {
    errors.push("provide only one of content_text or content_base64");
  }
  if (input.content_base64 && !/^[A-Za-z0-9+/=\s]+$/.test(input.content_base64)) {
    errors.push("content_base64 must be valid base64 text");
  }
  throwIfErrors(errors);
}

export function assertAssignmentInput(input) {
  const errors = [];
  if (!rejectUnknownFields(input, ASSIGNMENT_FIELDS, errors)) return throwIfErrors(errors);
  requireString(input.problem_id, "problem_id", errors);
  requireString(input.task, "task", errors);
  requireString(input.prompt, "prompt", errors);
  if (!isNonEmptyStringArray(input.desired_output) || !input.desired_output.length) {
    errors.push("desired_output must be a non-empty array of non-empty strings");
  }
  if (!isNonEmptyStringArray(input.assigned_agents) || !input.assigned_agents.length) {
    errors.push("assigned_agents must be a non-empty array of non-empty strings");
  }
  throwIfErrors(errors);
}

export function assertAssignmentPatch(input) {
  const errors = [];
  if (!rejectUnknownFields(input, ASSIGNMENT_PATCH_FIELDS, errors)) return throwIfErrors(errors);
  requireString(input.status, "status", errors);
  if (input.status) requireEnum(input.status, ASSIGNMENT_STATUSES, "status", errors);
  throwIfErrors(errors);
}

export function assertAgentKeyInput(input) {
  const errors = [];
  if (!rejectUnknownFields(input, AGENT_KEY_FIELDS, errors)) return throwIfErrors(errors);
  requireString(input.agent_id, "agent_id", errors);
  requireString(input.name, "name", errors);
  if (typeof input.name === "string" && input.name.trim().length > 80) {
    errors.push("name must be 80 characters or fewer");
  }
  throwIfErrors(errors);
}

export function assertAgentInput(input) {
  const errors = [];
  if (!rejectUnknownFields(input, AGENT_FIELDS, errors)) return throwIfErrors(errors);
  requireString(input.name, "name", errors);
  requireString(input.role, "role", errors);
  if (input.status) requireEnum(input.status, AGENT_STATUSES, "status", errors);
  if (input.tools && !isStringArray(input.tools)) {
    errors.push("tools must be an array of strings");
  }
  if (input.reputation !== undefined) {
    if (typeof input.reputation !== "number" || !Number.isInteger(input.reputation) || input.reputation < 0 || input.reputation > 100) {
      errors.push("reputation must be an integer from 0 to 100");
    }
  }
  throwIfErrors(errors);
}

export function assertLoginInput(input) {
  const errors = [];
  if (!rejectUnknownFields(input, LOGIN_FIELDS, errors)) return throwIfErrors(errors);
  requireString(input.email, "email", errors);
  requireString(input.password, "password", errors);
  if (typeof input.email === "string" && !input.email.includes("@")) {
    errors.push("email must be a valid email address");
  }
  throwIfErrors(errors);
}

export function assertProblemInput(input) {
  const errors = [];
  if (!rejectUnknownFields(input, PROBLEM_FIELDS, errors)) return throwIfErrors(errors);
  requireString(input.title, "title", errors);
  requireString(input.area, "area", errors);
  requireString(input.summary, "summary", errors);
  if (input.status) requireEnum(input.status, PROBLEM_STATUSES, "status", errors);
  if (input.priority) requireEnum(input.priority, PRIORITIES, "priority", errors);
  if (input.tags && !isStringArray(input.tags)) {
    errors.push("tags must be an array of strings");
  }
  throwIfErrors(errors);
}

export function assertVerificationPatch(input) {
  const errors = [];
  if (!rejectUnknownFields(input, VERIFICATION_PATCH_FIELDS, errors)) return throwIfErrors(errors);
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
    return false;
  }
  for (const key of Object.keys(input)) {
    if (!allowedFields.has(key)) errors.push(`unknown field: ${key}`);
  }
  return true;
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

function isNonEmptyStringArray(value) {
  return isStringArray(value) && value.every((item) => item.trim());
}

function hasInlineArtifactContent(input) {
  return typeof input.content_text === "string" || typeof input.content_base64 === "string";
}

function throwIfErrors(errors) {
  if (errors.length) throw new RequestValidationError(errors);
}
