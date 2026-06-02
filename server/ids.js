import { createHash, randomUUID } from "node:crypto";

export function makeId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

export function stableKeyHash(key) {
  const normalized = String(key || "").trim();
  if (!normalized) return "";
  return createHash("sha256").update(normalized).digest("hex");
}
