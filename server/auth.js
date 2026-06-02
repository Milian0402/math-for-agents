import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

const PASSWORD_ITERATIONS = 210_000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = "sha256";

export function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const hash = pbkdf2Sync(String(password), salt, PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST);
  return `pbkdf2_${PASSWORD_DIGEST}$${PASSWORD_ITERATIONS}$${salt}$${hash.toString("base64url")}`;
}

export function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 4 || parts[0] !== `pbkdf2_${PASSWORD_DIGEST}`) return false;

  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = Buffer.from(parts[3], "base64url");
  if (!Number.isInteger(iterations) || iterations < 100_000 || !salt || expected.length !== PASSWORD_KEY_LENGTH) {
    return false;
  }

  const actual = pbkdf2Sync(String(password), salt, iterations, expected.length, PASSWORD_DIGEST);
  return timingSafeEqual(actual, expected);
}

export function generateSessionToken() {
  return `mfa_session_${randomBytes(32).toString("base64url")}`;
}
