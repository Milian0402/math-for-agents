import { randomUUID } from "node:crypto";

const buckets = new Map();

export function createRequestContext(req, res) {
  const requestId = requestIdFor(req);
  const context = {
    request_id: requestId,
    started_at: Date.now(),
    method: req.method,
    path: "",
    principal: null
  };
  res.setHeader("x-request-id", requestId);
  res.on("finish", () => logRequest(context, res));
  return context;
}

export function applyRateLimit(req, url) {
  if (process.env.MFA_RATE_LIMIT_ENABLED === "false") return null;
  if (req.method === "GET" && url.pathname === "/api/health") return null;

  const limit = limitFor(req, url);
  const now = Date.now();
  const key = `${clientIp(req)}:${limit.bucket}`;
  const bucket = buckets.get(key);
  if (!bucket || bucket.reset_at <= now) {
    buckets.set(key, { count: 1, reset_at: now + limit.window_ms });
    pruneBuckets(now);
    return null;
  }

  bucket.count += 1;
  if (bucket.count <= limit.max) return null;

  const error = new Error("rate limit exceeded");
  error.statusCode = 429;
  error.retryAfter = Math.max(1, Math.ceil((bucket.reset_at - now) / 1000));
  return error;
}

export function rateLimitHeaders(error) {
  if (!error?.retryAfter) return {};
  return { "retry-after": String(error.retryAfter) };
}

export function errorPayload(error, statusCode, requestId, message) {
  const payload = {
    error: statusCode >= 500 ? "internal server error" : message,
    request_id: requestId
  };
  if (error.errors) payload.details = error.errors;
  return payload;
}

export function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function requestIdFor(req) {
  const header = req.headers["x-request-id"];
  if (typeof header === "string" && /^[a-zA-Z0-9._:-]{6,120}$/.test(header)) {
    return header;
  }
  return `req-${randomUUID()}`;
}

function limitFor(req, url) {
  const windowMs = Number(process.env.MFA_RATE_LIMIT_WINDOW_MS || 60_000);
  if (url.pathname === "/api/auth/login") {
    return {
      bucket: "login",
      max: Number(process.env.MFA_RATE_LIMIT_LOGIN_MAX || 10),
      window_ms: windowMs
    };
  }
  if (req.method !== "GET") {
    return {
      bucket: "write",
      max: Number(process.env.MFA_RATE_LIMIT_WRITE_MAX || 120),
      window_ms: windowMs
    };
  }
  return {
    bucket: "read",
    max: Number(process.env.MFA_RATE_LIMIT_READ_MAX || 600),
    window_ms: windowMs
  };
}

function pruneBuckets(now) {
  if (buckets.size < 10_000) return;
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.reset_at <= now) buckets.delete(key);
  }
}

function logRequest(context, res) {
  if (process.env.MFA_LOG_REQUESTS === "false") return;
  const entry = {
    at: new Date().toISOString(),
    request_id: context.request_id,
    method: context.method,
    path: context.path,
    status: res.statusCode,
    duration_ms: Date.now() - context.started_at,
    principal: context.principal
      ? {
          kind: context.principal.kind,
          id: context.principal.id,
          workspace_id: context.principal.workspace_id,
          auth_method: context.principal.auth_method
        }
      : null
  };
  console.log(JSON.stringify(entry));
}
