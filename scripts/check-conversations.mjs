import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const dir = await mkdtemp(path.join(os.tmpdir(),"mfa-conversations-"));
const adapter = (engine) => ({ query: async (sql,params=[]) => {
  const result = await engine.query(sql,params);
  return {...result,rowCount:result.affectedRows ?? result.rows.length};
}});
mock.module(new URL("../server/db.js",import.meta.url).href,{namedExports:{
  query:adapter(db).query,transaction:(fn) => db.transaction((tx) => fn(adapter(tx))),
  checkDatabaseHealth:async () => {},closePool:async () => {},getPool:() => adapter(db)
}});
Object.assign(process.env,{MFA_HUMAN_KEY:"mfa_dev_human_key",MFA_HUMAN_ID:"human:alice",MFA_WORKSPACE_ID:"workspace:a",
  MFA_DEFAULT_VERIFIER_AGENT_ID:"agent:verifier",ARTIFACT_STORAGE_DIR:dir,ARTIFACT_STORAGE_DRIVER:"local-file",
  MFA_LOG_REQUESTS:"false",MFA_LOG_ERRORS:"false",MFA_COOKIE_SECURE:"false"});
const { createServer } = await import("../server/http.js");
const { stableKeyHash } = await import("../server/ids.js");
const { hashPassword } = await import("../server/auth.js");
const { researchHash } = await import("../server/research.js");
const { runAgentClient } = await import("../examples/agent-client.mjs");
let server;
try {
  const schema = await readFile(new URL("../server/schema.sql",import.meta.url),"utf8");
  await db.exec(schema);
  await db.exec(schema);
  await db.exec(`insert into workspaces (id,name,owner) values ('workspace:a','Math network','human:alice'),('workspace:b','Other workspace','human:b');
    insert into problems (id,workspace_id,title,area,status,priority,summary) values
      ('problem:a','workspace:a','The missing induction step','Number theory','open','medium','A small discussion fixture, not a research result.'),
      ('problem:other','workspace:a','Another problem','Algebra','open','low','Test'),('problem:b','workspace:b','Private problem','Math','open','low','Test');
    insert into agents (id,workspace_id,name,role,status) values
      ('agent:a','workspace:a','Ada','researcher','idle'),('agent:b','workspace:a','Benoit','researcher','idle'),
      ('agent:c','workspace:a','Clara','researcher','idle'),('agent:verifier','workspace:a','Verifier','verifier','idle'),
      ('agent:foreign','workspace:b','Foreign','researcher','idle');`);
  await db.query("insert into human_users (id,email,name,password_hash) values ('human:alice','alice@example.test','Alice',$1)",[hashPassword("conversation-test-password")]);
  await db.exec("insert into workspace_members (workspace_id,human_id,role) values ('workspace:a','human:alice','owner')");
  for (const [id,ws] of [["a","a"],["b","a"],["c","a"],["foreign","b"]]) {
    await db.query("insert into agent_api_keys (id,workspace_id,agent_id,name,key_hash) values ($1,$2,$3,'test',$4)",
      [`${id}-key`,`workspace:${ws}`,`agent:${id}`,stableKeyHash(`${id}-key`)]);
  }
  server = createServer();
  await new Promise((resolve,reject) => {server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(url,body,key="a-key",method) {
    const response = await fetch(base+url,{method:method || (body === undefined ? "GET" : "POST"),
      headers:{"content-type":"application/json",...(key ? {authorization:`Bearer ${key}`} : {})},
      ...(body === undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  }
  const post = (input={},key) => request("/api/contributions",{
    problem_id:"problem:a",type:"question",evidence_level:"speculative",body:"Can we close the induction step?",...input},key);
  const root = (await post()).body.post;
  const input = {reply_to:root.id,idempotency_key:"reply-b-1",body:"The induction hypothesis covers n. What establishes the n + 1 case?"};
  const response = await post(input,"b-key");
  assert.equal(response.status,201,JSON.stringify(response.body));
  const reply = response.body.post;
  assert.equal(reply.agent,"agent:b");
  assert.deepEqual(reply.provenance.reply_to,{id:root.id,content_hash:root.content_hash});
  assert.deepEqual(reply.dependencies,[],"A discussion reply must not assert mathematical dependency or endorsement");
  assert.equal(reply.provenance.thread_root_id,root.id);
  const originalHash = root.content_hash;
  let thread = (await request(`/api/contributions/${reply.id}/thread`)).body;
  assert.equal(thread.root.content_hash,originalHash);
  assert.equal(thread.target.id,reply.id);
  assert.equal(thread.replies[0].post.id,reply.id);
  assert.equal(thread.replies[0].reply_to,root.id);
  const canonicalPost = JSON.parse(JSON.stringify(thread.replies[0].post));
  for (const field of ["workspace_id","content_hash","idempotency_key","request_hash"]) delete canonicalPost[field];
  assert.equal(researchHash(canonicalPost),reply.content_hash,"Reply provenance must survive persistence and API round trip");
  let activity = (await request("/api/activity")).body;
  assert.equal(activity.unread_count,1);
  const notification = activity.items[0];
  assert.equal(notification.post.id,reply.id);
  assert.equal((await request("/api/activity?agent_id=agent:a",undefined,"c-key")).body.items.length,0,"cannot select another recipient");
  assert.equal((await request("/api/activity",undefined,"b-key")).body.unread_count,0,"no notification for your own reply");
  assert.equal((await request("/api/work")).body.items[0].kind,"discussion");
  assert.equal((await request("/api/work?agent_id=agent:a",undefined,"mfa_dev_human_key")).body.activity.items.length,0,"human work inspection does not expose another identity's activity");
  assert.equal((await request(notification.context_path)).body.target.id,reply.id);
  assert.equal((await request(`/api/activity/${notification.id}/read`,{},"b-key")).status,404);
  assert.equal((await request(`/api/activity/${notification.id}/read`,{},"foreign-key")).status,404);
  assert.equal((await request(`/api/contributions/${reply.id}/thread`,undefined,"foreign-key")).status,404);
  assert.equal((await request("/api/activity",undefined,null)).status,401);
  assert.equal((await request(`/api/contributions/${root.id}/thread`,undefined,null)).status,401);
  assert.equal((await post({...input,agent:"agent:a"},"b-key")).status,403);
  assert.equal((await post({...input,agent:"agent:b"},"mfa_dev_human_key")).status,403,"even an owner cannot impersonate a discussion participant");
  assert.equal((await post({...input,problem_id:"problem:other",idempotency_key:"other-problem"},"b-key")).status,422);
  assert.equal((await post({...input,problem_id:"problem:b"},"foreign-key")).status,422);
  assert.equal((await post({...input,reply_to:"missing",idempotency_key:"missing-parent"},"b-key")).status,422);
  assert.equal((await post({...input,reply_to:{}},"b-key")).status,422);
  assert.equal((await post({...input,idempotency_key:undefined},"b-key")).status,422);
  const retries = await Promise.all([post(input,"b-key"),post(input,"b-key")]);
  assert(retries.every((r) => r.body.post.id === reply.id));
  assert.equal((await request("/api/activity")).body.items.length,1,"retries cannot create duplicate notifications");
  assert.equal((await post({...input,body:"Different content"},"b-key")).status,409);
  const nested = (await post({reply_to:reply.id,idempotency_key:"reply-c-1",body:"Try splitting the successor into even and odd cases."},"c-key")).body.post;
  assert.equal((await request("/api/activity",undefined,"b-key")).body.items[0].kind,"reply");
  assert.equal((await request("/api/activity")).body.items[0].kind,"thread-reply");
  // Root author replying to someone else should notify that person, not themselves.
  await post({reply_to:nested.id,idempotency_key:"reply-a-1",body:"I will test those cases and post the missing assumptions."});
  assert.equal((await request("/api/activity")).body.unread_count,2);
  const firstPage = (await request(`/api/contributions/${root.id}/thread?limit=1`)).body;
  const secondPage = (await request(`/api/contributions/${root.id}/thread?limit=1&after=${firstPage.next_after}`)).body;
  assert.equal(firstPage.replies.length,1);
  assert.equal(secondPage.replies[0].post.id,nested.id);
  assert.equal(secondPage.root.id,root.id);
  const activityPage = (await request("/api/activity?limit=1")).body;
  const older = (await request(`/api/activity?limit=1&before=${activityPage.next_before}`)).body;
  assert.equal(older.items[0].id,notification.id);
  const read = (await request(`/api/activity/${notification.id}/read`,{})).body;
  assert.deepEqual((await request(`/api/activity/${notification.id}/read`,{})).body,read,"acknowledgments are idempotent");
  assert.equal((await request("/api/activity?unread=true")).body.items.length,1);
  assert.equal((await request("/api/activity")).body.items.length,2,"reading preserves history");
  for (const url of ["/api/activity?before=1.5","/api/activity?limit=0","/api/activity?limit=101","/api/activity?unread=yes",`/api/contributions/${root.id}/thread?after=9223372036854775808`]) {
    assert.equal((await request(url)).status,422,url);
  }
  // A later ledger failure must roll back the post, reply edge and notification together.
  const inference = {provider:"test-fixture",model:"fixture",provider_request_id:"same-run",input_tokens:1,output_tokens:1};
  await post({inference},"b-key");
  const before = (await request("/api/activity")).body.unread_count;
  const failed = await post({...input,idempotency_key:"rollback",inference},"b-key");
  assert.notEqual(failed.status,201);
  assert.equal((await request("/api/activity")).body.unread_count,before);
  assert.equal((await request(`/api/contributions/${root.id}/thread`)).body.reply_count,3);
  // A separate human participates and receives a real inbox item too.
  const humanPost = (await post({body:"Which assumption do we need to check first?"},"mfa_dev_human_key")).body.post;
  await post({reply_to:humanPost.id,idempotency_key:"reply-to-human",body:"We need the base case and a step that works for every n, not just examples."},"b-key");
  assert.equal((await request("/api/activity",undefined,"mfa_dev_human_key")).body.unread_count,1);
  // Real CLI calls over HTTP, no model or inference execution.
  async function cli(args,key="a-key",files={}) {
    let output="";
    await runAgentClient(args,{baseUrl:base,apiKey:key,stdout:{write:(s) => output+=s},readFile:async (file) => JSON.stringify(files[file])});
    return JSON.parse(output);
  }
  assert.equal((await cli(["thread",reply.id])).root.id,root.id);
  const packet = await cli(["participate","problem:a"]);
  assert.equal(packet.execution,"read-only-context");
  assert.equal(packet.scheduled,false);
  assert(packet.next_actions.some((s) => s.includes("reply_to")));
  assert(packet.activity.items.length > 0);
  process.env.MFA_AGENT_PROBLEM_ID = "<problem-id>";
  assert((await cli(["participate"])).contributions.length > 0,"unscoped participation discovers the network without an assignment or selected problem");
  delete process.env.MFA_AGENT_PROBLEM_ID;
  const cliReply = await cli(["reply",reply.id,"reply.json"],"a-key",{"reply.json":{
    type:"attempt",evidence_level:"speculative",body:"The successor argument still needs a bound uniform in n.",idempotency_key:"cli-reply-1"}});
  assert.equal(cliReply.post.provenance.reply_to.id,reply.id);
  const cliInbox = await cli(["activity"],"b-key");
  assert(cliInbox.items.some((n) => n.post.id === cliReply.post.id));
  assert((await cli(["activity-read",cliInbox.items[0].id],"b-key")).read_at);
  console.log("Conversation checks passed: agent replies, provenance, human inbox, auth, pagination, retry/rollback safety and live CLI participation.");
  if (process.argv.includes("--preview")) {
    console.log(`Preview: ${base} (synthetic test data only)`);
    await new Promise((resolve) => process.once("SIGTERM",resolve));
  }
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.close();
  await rm(dir,{recursive:true,force:true});
}
