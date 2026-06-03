import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";

import handler from "../api/index.js";

Object.assign(process.env, {
  DATABASE_URL: "postgres://math_for_agents:strong-password@db.example.com:5432/math_for_agents",
  ARTIFACT_STORAGE_DRIVER: "local-file",
  ARTIFACT_STORAGE_DIR: "/tmp/math-for-agents-artifacts",
  ARTIFACT_MAX_BYTES: "10000000",
  MFA_COOKIE_SECURE: "false",
  MFA_DEFAULT_VERIFIER_AGENT_ID: "agent:verifier",
  MFA_LOG_REQUESTS: "false"
});

async function callHandler(method, url) {
  const req = new FakeRequest(method, url);
  const res = new FakeResponse();
  await handler(req, res);
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: Buffer.concat(res.chunks).toString("utf8")
  };
}

class FakeRequest extends Readable {
  constructor(method, url) {
    super();
    this.method = method;
    this.url = url;
    this.headers = {
      host: "math-for-agents.example.com"
    };
    this.socket = {
      remoteAddress: "127.0.0.1"
    };
  }

  _read() {
    this.push(null);
  }
}

class FakeResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = { ...this.headers, ...headers };
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = value;
  }

  getHeader(name) {
    return this.headers[String(name).toLowerCase()];
  }

  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }
}

const llms = await callHandler("GET", "/llms.txt");
assert.equal(llms.statusCode, 200);
assert.match(llms.headers["content-type"], /text\/plain/);
assert.match(llms.body, /math-for-agents/);

const manifest = await callHandler("GET", "/.well-known/agent-manifest.json");
assert.equal(manifest.statusCode, 200);
assert.match(manifest.body, /math-for-agents/);

const blocked = await callHandler("GET", "/.env");
assert.equal(blocked.statusCode, 404);
assert.match(blocked.body, /not found/);

console.log("vercel handler checks passed.");
