// Real Postgres semantics in WASM, real HTTP routes/auth, no external services.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const artifactDir = await mkdtemp(path.join(os.tmpdir(), "mfa-research-test-"));
function adapter(engine) {
  return { query: async (sql, params = []) => {
    const result = await engine.query(sql, params);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  } };
}
mock.module(new URL("../server/db.js", import.meta.url).href, { namedExports: {
  query: adapter(db).query,
  transaction: (fn) => db.transaction((tx) => fn(adapter(tx))),
  checkDatabaseHealth: async () => { await db.query("select 1"); },
  closePool: async () => {},
  getPool: () => adapter(db)
} });

process.env.MFA_HUMAN_KEY = "test-owner-key";
process.env.MFA_HUMAN_ID = "human:alice";
process.env.MFA_WORKSPACE_ID = "workspace:a";
process.env.MFA_DEFAULT_VERIFIER_AGENT_ID = "agent:verifier";
process.env.ARTIFACT_STORAGE_DIR = artifactDir;
process.env.ARTIFACT_STORAGE_DRIVER = "local-file";
process.env.MFA_LOG_REQUESTS = "false";
process.env.MFA_LOG_ERRORS = "false";
process.env.MFA_COOKIE_SECURE = "false";

const { createServer } = await import("../server/http.js");
const { hashPassword } = await import("../server/auth.js");
const { stableKeyHash } = await import("../server/ids.js");
const { researchHash } = await import("../server/research.js");
const { formatProblemExport } = await import("../server/problem-export.js");
const schema = await readFile(new URL("../server/schema.sql", import.meta.url), "utf8");
let server;

try {
  // Simulate an existing installation, then apply and reapply the additive schema.
  await db.exec(schema.split("-- Additive upgrade:")[0] + "commit;");
  await db.exec(`insert into workspaces (id,name,owner) values ('workspace:a','A','human:alice'), ('workspace:b','B','human:bob');
    insert into problems (id,workspace_id,title,area,status,priority,summary) values
      ('problem:a','workspace:a','A','Math','open','high','Test'),
      ('problem:other','workspace:a','Other','Math','open','high','Test'),
      ('problem:b','workspace:b','B','Math','open','high','Test');
    insert into posts (id,workspace_id,agent,problem_id,type,body,evidence_level,status) values
      ('post:legacy','workspace:a','human:alice','problem:a','attempt','Legacy work','speculative','open');`);
  await db.exec(schema);
  await db.exec(schema);
  const legacy = (await db.query("select * from posts where id = 'post:legacy'")).rows[0];
  assert.equal(legacy.submitted_by, null);
  assert.equal(legacy.content_hash, null);
  assert.equal((await db.query("select * from credit_events")).rows.length, 0);
  for (const [id, email] of [["human:alice", "alice@example.test"], ["human:bob", "bob@example.test"]]) {
    await db.query("insert into human_users (id,email,name,password_hash) values ($1,$2,$1,$3)", [id, email, hashPassword("test-password")]);
  }
  await db.exec(`insert into workspace_members (workspace_id,human_id,role) values
    ('workspace:a','human:alice','owner'), ('workspace:a','human:bob','member');
    insert into agents (id,workspace_id,name,role,status) values
    ('agent:verifier','workspace:a','Verifier','verifier','idle'),
    ('agent:writer','workspace:a','Writer','researcher','idle'),
    ('agent:foreign','workspace:b','Foreign','researcher','idle');`);
  for (const [id, workspace, token] of [["agent:writer", "workspace:a", "writer-key"], ["agent:foreign", "workspace:b", "foreign-key"]]) {
    await db.query("insert into agent_api_keys (id,workspace_id,agent_id,name,key_hash) values ($1,$2,$3,'test',$4)", [id + ":key", workspace, id, stableKeyHash(token)]);
  }
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body, token = "test-owner-key", extras = {}) => {
    const response = await fetch(base + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extras.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...Object.fromEntries(Object.entries(extras).filter(([key]) => key !== "headers"))
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const submit = (overrides = {}, token) => request("/api/contributions", {
    problem_id: "problem:a", type: "progress-update", evidence_level: "speculative", body: "Partial result, not a complete proof.",
    progress: { changes: "Reduced to one case", established: "Only a conditional reduction", blockers: "Last case remains open", next_steps: "Check the remaining case" },
    ...overrides
  }, token);
  const upload = await request("/api/artifacts", { problem_id: "problem:a", kind: "proof", title: "Proof notes", summary: "A partial proof", file_name: "proof.md", content_text: "# Partial proof\n", content_type: "text/markdown" });
  assert.equal(upload.status, 201);
  const artifactId = upload.body.artifact.id;
  assert.equal(upload.body.artifact.metadata.server_stored, true);
  const input = { idempotency_key: "first-proof", type: "proof", evidence_level: "informal-proof", claim_statement: "The stated conditional reduction holds.", artifact_id: artifactId, license: "CC-BY-4.0" };
  const first = await submit(input);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const post = first.body.post;
  assert.equal(post.agent, "human:alice");
  assert.equal(post.author_kind, "human");
  assert.equal(post.submitted_by, "human:alice");
  assert.equal(first.body.claim.trust_tier, "unverified");
  assert.equal(first.body.claim.status, "needs-review");
  assert.equal(post.provenance.artifacts[0].bytes_stored, true);
  assert.match(post.content_hash, /^sha256:[a-f0-9]{64}$/);
  const { content_hash, idempotency_key, request_hash, ...digestInput } = post;
  assert.equal(researchHash(digestInput), content_hash);
  assert.notEqual(researchHash({ ...digestInput, body: "tampered" }), content_hash);
  assert.equal(researchHash({ b: 2, a: 1 }), researchHash({ a: 1, b: 2 }));
  const repeated = await Promise.all(Array.from({ length: 4 }, () => submit(input)));
  for (const result of repeated) {
    assert.equal(result.status, 201);
    assert.equal(result.body.post.id, post.id);
    assert.equal(result.body.claim.id, first.body.claim.id);
    const { workspace_id, content_hash: storedHash, idempotency_key: retryKey, request_hash: retryHash, ...storedDigest } = result.body.post;
    assert.equal(researchHash(storedDigest), storedHash, "persisted posts retain a reproducible digest");
  }
  assert.equal((await submit({ ...input, body: "changed" })).status, 409);
  const revision = await submit({ revision_of: post.id, idempotency_key: "revision", dependencies: ["post:legacy", "post:legacy"] });
  assert.equal(revision.status, 201, JSON.stringify(revision.body));
  assert.equal(revision.body.post.revision_of, post.id);
  assert.deepEqual(revision.body.post.dependencies, ["post:legacy"]);
  assert.equal(revision.body.post.provenance.parents.find((p) => p.id === post.id).content_hash, post.content_hash);
  assert.equal(revision.body.post.provenance.parents.find((p) => p.id === "post:legacy").content_hash, null);
  assert.equal((await db.query("select * from contribution_edges where post_id = $1", [revision.body.post.id])).rows.length, 2);
  await assert.rejects(db.query("update posts set body = 'overwritten' where id = $1", [post.id]), /append-only/);
  assert.equal((await submit({ revision_of: post.id }, "writer-key")).status, 403);
  assert.equal((await submit({ dependencies: [post.id] }, "writer-key")).status, 201);
  assert.equal((await submit({ author_id: "human:alice" }, "writer-key")).status, 403);
  assert.equal((await submit({ author_id: "human:bob" })).status, 403);
  assert.equal((await submit({ author_id: "agent:writer", agent: "human:alice" })).status, 422);
  const delegated = await submit({ author_id: "agent:writer" });
  assert.equal(delegated.status, 201);
  assert.equal(delegated.body.post.author_kind, "agent");
  assert.equal(delegated.body.post.submitted_by, "human:alice");
  assert.equal((await submit({ author_kind: "human" }, "writer-key")).status, 422);
  assert.equal((await submit({ submitted_by: "human:bob" })).status, 422);
  assert.equal((await submit({ content_hash: "sha256:fake" })).status, 422);
  assert.equal((await submit({ status: "accepted" })).status, 422);
  assert.equal((await submit({ progress: {} })).status, 422);
  assert.equal((await submit({ progress: { changes: "x", paid: true } })).status, 422);
  assert.equal((await submit({ type: "proof", claim_statement: "" })).status, 422);
  assert.equal((await submit({ type: "attempt", claim_statement: 12 })).status, 422);
  assert.equal((await submit({ revision_of: "post:missing" })).status, 422);
  const foreign = await submit({ problem_id: "problem:b" }, "foreign-key");
  assert.equal(foreign.status, 201);
  assert.equal((await submit({ dependencies: [foreign.body.post.id] })).status, 404);
  assert.equal((await submit({ problem_id: "problem:other", revision_of: post.id })).status, 422);
  assert.equal((await submit({ problem_id: "problem:other", artifact_id: artifactId })).status, 422);
  const fakeStorage = { storage: { driver: "local-file", key: "secrets" }, server_stored: true };
  assert.equal((await submit({ artifact_title: "Fake", artifact_metadata: fakeStorage })).status, 422);
  assert.equal((await request("/api/artifacts", { problem_id: "problem:a", kind: "proof", title: "Fake", summary: "fake", path: "/fake", metadata: fakeStorage })).status, 422);

  const inference = { provider: "local", model: "test-model", provider_request_id: "run-1", input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_tokens: 10, gpu_seconds: 2, cost_microusd: 1234 };
  const run = await submit({ inference, idempotency_key: "inference-1" }, "writer-key");
  assert.equal(run.status, 201, JSON.stringify(run.body));
  assert.equal((await submit({ inference }, "writer-key")).status, 409);
  assert.equal((await submit({ inference: { ...inference, verified: true } })).status, 422);
  for (const invalid of [-1, 0.5, "10", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await submit({ inference: { ...inference, input_tokens: invalid } })).status, 422);
  }
  assert.equal((await submit({ inference: { ...inference, cached_input_tokens: 101 } })).status, 422);
  assert.equal((await submit({ inference: { ...inference, provider_request_id: "" } })).status, 422);
  assert.equal((await db.query("select count(*)::int as n from inference_runs")).rows[0].n, 1);
  const credit = await request("/api/credits?problem_id=problem:a");
  assert.equal(credit.status, 200, JSON.stringify(credit.body));
  assert.equal(credit.body.redeemable, false);
  assert.ok(credit.body.events.every((event) => typeof event.sequence === "string"));
  const authorEvents = credit.body.events.filter((e) => e.post_id === post.id);
  assert.equal(authorEvents.length, 1);
  assert.equal(authorEvents[0].principal_id, "human:alice");
  assert.equal(authorEvents[0].kind, "authorship-recorded");
  const inferenceEvent = credit.body.events.find((e) => e.kind === "inference-reported");
  assert.equal(inferenceEvent.evidence_status, "self-reported");
  assert.equal(inferenceEvent.details.redeemable, false);
  await assert.rejects(db.query("update credit_events set principal_id = 'human:bob' where id = $1", [inferenceEvent.id]), /append-only/);
  const next = await request("/api/credits?limit=2");
  const page2 = await request(`/api/credits?limit=2&before=${next.body.next_before}`);
  assert.equal(page2.status, 200);
  assert.equal(next.body.events.some((e) => page2.body.events.some((f) => f.id === e.id)), false);
  assert.equal((await request("/api/credits?before=9223372036854775808")).status, 422);
  assert.equal((await request("/api/credits?limit=0")).status, 422);
  assert.equal((await request("/api/credits", undefined, "")).status, 401);
  assert.equal((await request("/api/credits", { amount: 100 })).status, 404);
  const foreignCredit = await request("/api/credits", undefined, "foreign-key");
  assert.equal(foreignCredit.body.events.length, 1);
  assert.equal(foreignCredit.body.events[0].post_id, foreign.body.post.id);
  const privateProblem = await request("/api/credits?problem_id=problem:a", undefined, "foreign-key");
  assert.equal(privateProblem.status, 404);
  const currentStore = await request("/api/store");
  assert.ok(currentStore.body.store.credit_events.length);
  assert.ok(currentStore.body.store.principals.some((p) => p.id === "human:alice" && p.kind === "human"));
  assert.equal(currentStore.body.store.principals.some((p) => p.email || p.password_hash), false);
  const context = await request("/api/problems/problem:a");
  const markdown = formatProblemExport(context.body, "markdown");
  assert.match(markdown, /submitted by human:alice/);
  assert.match(markdown, /CC-BY-4.0/);
  assert.match(markdown, /Last case remains open/);
  assert.match(markdown, /legacy\/local attribution/);
  // A normal member can post as themselves, never import under an agent's name.
  const login = await request("/api/auth/login", { email: "bob@example.test", password: "test-password" }, "");
  assert.equal(login.status, 200);
  const memberHeaders = { cookie: login.headers.get("set-cookie").split(";")[0], origin: base };
  const member = await request("/api/contributions", { problem_id: "problem:a", type: "attempt", body: "My work", evidence_level: "speculative" }, "", { headers: memberHeaders });
  assert.equal(member.status, 201);
  assert.equal(member.body.post.agent, "human:bob");
  assert.equal((await request("/api/contributions", { author_id: "agent:writer", problem_id: "problem:a", type: "attempt", body: "Spoof", evidence_level: "speculative" }, "", { headers: memberHeaders })).status, 403);
  assert.equal((await db.query("select reputation from agents where id = 'agent:writer'")).rows[0].reputation, 0);
  console.log("Research checks passed: additive migrations, HTTP uploads/authorship/progress, immutable revisions, retries, scope checks, non-redeemable inference ledger, exports.");
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  mock.restoreAll();
  await db.close();
  await rm(artifactDir, { recursive: true, force: true });
}
