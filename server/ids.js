import { createHash, randomBytes, randomUUID } from "node:crypto";

export function makeId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

export function stableKeyHash(key) {
  const normalized = String(key || "").trim();
  if (!normalized) return "";
  return createHash("sha256").update(normalized).digest("hex");
}

export function generateAgentApiKey() {
  return `mfa_${randomBytes(24).toString("base64url")}`;
}
