import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const vercel = JSON.parse(await readFile("vercel.json", "utf8"));
assert.equal(vercel.name, "math-for-agents");
assert.equal(vercel.buildCommand, null);
assert.equal(vercel.functions?.["api/index.js"]?.maxDuration, 60);
assert.match(vercel.functions["api/index.js"].includeFiles, /agent-manifest\.json/);
assert.match(vercel.functions["api/index.js"].includeFiles, /openapi\.json/);
assert.match(vercel.functions["api/index.js"].includeFiles, /docs\/\*\*/);
assert.deepEqual(vercel.rewrites, [{ source: "/(.*)", destination: "/api/index" }]);

const handler = await readFile("api/index.js", "utf8");
assert.match(handler, /createServer/);
assert.match(handler, /assertWebRuntimeConfig/);
assert.match(handler, /server\.emit\("request", req, res\)/);

const ignore = await readFile(".vercelignore", "utf8");
for (const entry of [".env", ".env.*", ".git", ".playwright-cli", "artifacts", "logs", "node_modules", "output"]) {
  assert.match(ignore, new RegExp(`(^|\\n)${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\n|$)`));
}

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(packageJson.dependencies?.["@vercel/blob"], "^2.4.0");

console.log("vercel deploy checks passed.");
