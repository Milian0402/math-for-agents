import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const dir = await mkdtemp(path.join(os.tmpdir(),"mfa-pilot-check-"));
const adapter = (engine) => ({query:async (sql,params=[]) => {
  const result = await engine.query(sql,params);
  return {...result,rowCount:result.affectedRows ?? result.rows.length};
}});
mock.module(new URL("../server/db.js",import.meta.url).href,{namedExports:{
  query:adapter(db).query,transaction:(fn) => db.transaction((tx) => fn(adapter(tx))),
  checkDatabaseHealth:async () => {},closePool:async () => {},getPool:() => adapter(db)
}});
Object.assign(process.env,{MFA_HUMAN_KEY:"pilot-owner-key",MFA_HUMAN_ID:"human:alice",MFA_WORKSPACE_ID:"workspace:a",
  MFA_DEFAULT_VERIFIER_AGENT_ID:"agent:verifier",ARTIFACT_STORAGE_DIR:dir,ARTIFACT_STORAGE_DRIVER:"local-file",
  MFA_LOG_REQUESTS:"false",MFA_LOG_ERRORS:"false",MFA_COOKIE_SECURE:"false"});
const { createServer } = await import("../server/http.js");
const { hashPassword } = await import("../server/auth.js");
const { stableKeyHash } = await import("../server/ids.js");
const { researchHash } = await import("../server/research.js");
const { runWorkerOnce,evaluateExecution } = await import("../server/verification-worker.js");
const { tierFromVerification,canPromote } = await import("../src/vocab.js");
const schema = await readFile(new URL("../server/schema.sql",import.meta.url),"utf8");
let server;
try {
  await db.exec(schema.split("-- Additive upgrade:")[0]+"commit;");
  await db.exec(`insert into workspaces (id,name,owner) values ('workspace:a','A','human:alice'),('workspace:b','B','human:b');
    insert into problems (id,workspace_id,title,area,status,priority,summary) values ('problem:a','workspace:a','A','Math','open','high','Test'),('problem:b','workspace:b','B','Math','open','high','Test');
    insert into claims (id,workspace_id,problem_id,type,statement,status,evidence_level,trust_tier,verification_state)
      values ('claim:legacy','workspace:a','problem:a','proof','1 = 2','accepted','formal-proof','formally-checked','passed');
    insert into verifications (id,workspace_id,claim_id,assigned_agent,method,priority,status)
      values ('verify:legacy','workspace:a','claim:legacy','agent:verifier','lean-kernel','high','passed');`);
  await db.exec(schema);
  await db.exec(schema);
  assert.equal((await db.query("select status from claims where id = 'claim:legacy'")).rows[0].status,"needs-review");
  assert.equal((await db.query("select previous_claim from verification_reassessments")).rows[0].previous_claim.status,"accepted");
  for (const [id,role] of [["alice","owner"],["bob","member"],["carol","reviewer"],["dave","reviewer"]]) {
    await db.query("insert into human_users (id,email,name,password_hash) values ($1,$2,$3,$4)",[`human:${id}`,`${id}@example.test`,id,hashPassword("pilot-test-password")]);
    await db.query("insert into workspace_members (workspace_id,human_id,role) values ('workspace:a',$1,$2)",[`human:${id}`,role]);
  }
  await db.exec(`insert into agents (id,workspace_id,name,role,status) values
    ('agent:writer','workspace:a','Writer','researcher','idle'),('agent:verifier','workspace:a','Verifier','verifier','idle'),('agent:foreign','workspace:b','Foreign','researcher','idle');`);
  for (const [id,ws,key] of [["writer","a","writer-key"],["verifier","a","verifier-key"],["foreign","b","foreign-key"]]) {
    await db.query("insert into agent_api_keys (id,workspace_id,agent_id,name,key_hash) values ($1,$2,$3,'test',$4)",[`${id}-key`,`workspace:${ws}`,`agent:${id}`,stableKeyHash(key)]);
  }
  server = createServer();
  await new Promise((resolve,reject) => {server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url,body,auth="pilot-owner-key",method) => {
    const headers = {"content-type":"application/json",...(auth?.startsWith("mfa_session=") ? {cookie:auth,origin:base} : auth ? {authorization:`Bearer ${auth}`} : {})};
    const response = await fetch(base+url,{method:method || (body === undefined ? "GET" : "POST"),headers,...(body === undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json(),headers:response.headers};
  };
  const login = async (id) => (await request("/api/auth/login",{email:`${id}@example.test`,password:"pilot-test-password"},null)).headers.get("set-cookie").split(";")[0];
  const bob = await login("bob"),carol = await login("carol"),dave = await login("dave");
  const progress = {changes:"Reduced to a bounded case",established:"Conditional only",blockers:"One case remains",next_steps:"Check the missing case"};
  const submit = (changes={},auth) => request("/api/contributions",{problem_id:"problem:a",type:"progress-update",evidence_level:"speculative",body:"Partial research",progress,...changes},auth);
  const source = await submit({license:"CC-BY-4.0"});
  assert.equal(source.status,201,JSON.stringify(source.body));
  const sourceId = source.body.post.id;
  const upload = await request("/api/artifacts",{problem_id:"problem:a",kind:"proof",title:"Notes",summary:"Original author's proof notes",file_name:"notes.md",content_text:"Unfinished argument"});
  assert.equal(upload.status,201);
  const goal = "Every integer n satisfies n + 0 = n.";
  const createInput = {source_post_id:sourceId,goal,model:"test-model-v1",budget_tokens:100,paired:true,idempotency_key:"pilot-1"};
  const created = await request("/api/research-pilots",createInput);
  assert.equal(created.status,201,JSON.stringify(created.body));
  const {pilot,runs} = created.body;
  const shared = runs.find((r) => r.mode === "shared"),independent = runs.find((r) => r.mode === "independent");
  assert.equal((await request("/api/research-pilots",createInput)).body.pilot.id,pilot.id);
  assert.equal((await request("/api/research-pilots",{...createInput,goal:"different"})).status,409);
  assert.equal((await request("/api/research-pilots",createInput,"foreign-key")).status,422);
  assert.equal((await request(`/api/research-runs/${shared.id}`,undefined,"foreign-key")).status,404);
  assert.equal((await request("/api/research-pilots",undefined,null)).status,401);
  const transition = (run,action,checkpoint=sourceId,auth="writer-key") => request(`/api/research-runs/${run.id}/transition`,{action,expected_checkpoint_id:checkpoint},auth);
  assert.equal((await transition(shared,"resume")).status,200);
  assert.equal((await transition(shared,"resume",sourceId,bob)).status,409);
  const checkpointInput = {artifact_id:upload.body.artifact.id,idempotency_key:"cp1",research_run:{id:shared.id,expected_checkpoint_id:sourceId,status:"paused",tokens_used:30},
    inference:{provider:"test",model:"test-model-v1",provider_request_id:"call-1",input_tokens:10,output_tokens:20}};
  assert.equal((await submit({...checkpointInput,research_run:{...checkpointInput.research_run,expected_checkpoint_id:"stale"}},"writer-key")).status,409);
  const cp1 = await submit(checkpointInput,"writer-key");
  assert.equal(cp1.status,201,JSON.stringify(cp1.body));
  assert(cp1.body.post.dependencies.includes(sourceId));
  assert.equal(cp1.body.post.provenance.research_run.previous_hash,source.body.post.content_hash);
  assert.equal((await submit(checkpointInput,"writer-key")).body.post.id,cp1.body.post.id);
  assert.equal((await request(`/api/research-runs/${shared.id}`)).body.run.tokens_used,30);
  const persisted = JSON.parse(JSON.stringify((await db.query("select * from posts where id = $1",[cp1.body.post.id])).rows[0]));
  const {workspace_id,content_hash,idempotency_key,request_hash,...hashable} = persisted;
  assert.equal(researchHash(hashable),content_hash,"checkpoint digest survives storage");
  assert.equal((await transition(shared,"resume",cp1.body.post.id,bob)).status,200);
  const useful = await submit({body:"An independently reusable lemma"});
  const contextAdded = await request(`/api/research-runs/${shared.id}/context`,{post_id:useful.body.post.id,expected_checkpoint_id:cp1.body.post.id},bob);
  assert.equal(contextAdded.status,200);
  const cp2 = await submit({type:"proof",evidence_level:"informal-proof",claim_statement:goal,body:"By the definition of adding zero, n + 0 = n.",
    research_run:{id:shared.id,expected_checkpoint_id:cp1.body.post.id,status:"completed",tokens_used:0},idempotency_key:"cp2"},bob);
  assert.equal(cp2.status,201,JSON.stringify(cp2.body));
  assert(cp2.body.post.dependencies.includes(cp1.body.post.id));
  assert(cp2.body.post.dependencies.includes(useful.body.post.id));
  assert.equal(cp2.body.post.author_id,"human:bob");
  assert.equal(cp2.body.claim.status,"needs-review");
  assert.equal((await transition(shared,"resume",cp2.body.post.id)).status,409);
  const audit = {goal_hash:pilot.goal_hash,checkpoint_hash:cp2.body.post.content_hash,verdict:"supported",notes:"Checked the definition and the statement for all integers."};
  assert.equal((await request(`/api/research-runs/${shared.id}/audits`,audit)).status,403,"source author cannot self-review");
  assert.equal((await request(`/api/research-runs/${shared.id}/audits`,audit,"writer-key")).status,403);
  assert.equal((await request(`/api/research-runs/${shared.id}/audits`,{...audit,checkpoint_hash:"stale"},carol)).status,409);
  assert.equal((await request(`/api/research-runs/${shared.id}/audits`,audit,carol)).status,200);
  assert.equal((await transition(independent,"resume")).status,200);
  assert.equal((await request(`/api/research-runs/${independent.id}/context`,{post_id:useful.body.post.id,expected_checkpoint_id:sourceId},"writer-key")).status,422);
  const independentInput = {type:"proof",claim_statement:goal,idempotency_key:"independent-final",research_run:{id:independent.id,expected_checkpoint_id:sourceId,status:"completed",tokens_used:100},
    inference:{provider:"test",model:"test-model-v1",provider_request_id:"independent-call",input_tokens:40,output_tokens:60}};
  assert.equal((await submit({...independentInput,dependencies:[cp2.body.post.id]},"writer-key")).status,422);
  assert.equal((await submit({...independentInput,research_run:{...independentInput.research_run,tokens_used:101},inference:{...independentInput.inference,output_tokens:61}},"writer-key")).status,422);
  assert.equal((await submit({...independentInput,inference:{...independentInput.inference,model:"different-model"}},"writer-key")).status,422);
  const independentResult = await submit(independentInput,"writer-key");
  assert.equal(independentResult.status,201,JSON.stringify(independentResult.body));
  await request(`/api/research-runs/${independent.id}/audits`,{...audit,checkpoint_hash:independentResult.body.post.content_hash},carol);
  let report = (await request(`/api/research-pilots/${pilot.id}/report`)).body;
  assert.equal(report.comparison_ready,true);
  assert.equal(report.formal_proofs_certified,0);
  assert.equal(report.evidence_status,"observational-pilot");
  assert.equal(report.runs.find((r) => r.mode === "shared").human_checkpoints,1);
  await request(`/api/research-runs/${shared.id}/audits`,{...audit,verdict:"needs-work",notes:"Request a clearer statement of the definition."},dave);
  report = (await request(`/api/research-pilots/${pilot.id}/report`)).body;
  assert.equal(report.comparison_ready,false);
  assert.equal(report.runs.find((r) => r.mode === "shared").review_status,"disputed");
  await assert.rejects(db.query("update research_pilots set goal = 'weaker goal' where id = $1",[pilot.id]),/immutable/);
  await assert.rejects(db.query("update research_audits set verdict = 'supported' where run_id = $1",[shared.id]),/immutable/);
  // Real concurrent HTTP requests cannot consume the same checkpoint twice.
  const race = (await request("/api/research-pilots",{...createInput,idempotency_key:"race-pilot",budget_tokens:10})).body;
  const raceShared = race.runs.find((r) => r.mode === "shared"),raceIndependent = race.runs.find((r) => r.mode === "independent");
  await transition(raceShared,"resume");
  const racePayload = {research_run:{id:raceShared.id,expected_checkpoint_id:sourceId,status:"running",tokens_used:5},
    inference:{provider:"test",model:"test-model-v1",provider_request_id:"race-call",input_tokens:2,output_tokens:3}};
  const raced = await Promise.all([
    submit({...racePayload,idempotency_key:"racer-a"},"writer-key"),
    submit({...racePayload,idempotency_key:"racer-b",inference:{...racePayload.inference,provider_request_id:"race-call-b"}},"writer-key")
  ]);
  assert.deepEqual(raced.map((r) => r.status).sort(),[201,409]);
  const won = raced.find((r) => r.status === 201).body.post;
  assert.equal((await request(`/api/research-runs/${raceShared.id}`)).body.run.tokens_used,5);
  await transition(raceIndependent,"resume");
  const otherArmPost = await submit({research_run:{id:raceIndependent.id,expected_checkpoint_id:sourceId,status:"paused",tokens_used:1},
    inference:{provider:"test",model:"test-model-v1",provider_request_id:"other-arm",input_tokens:1,output_tokens:0}},"writer-key");
  const disguisedOtherArm = await submit({dependencies:[otherArmPost.body.post.id],body:"A wrapper around the other arm"});
  assert.equal((await request(`/api/research-runs/${raceShared.id}/context`,{post_id:disguisedOtherArm.body.post.id,expected_checkpoint_id:won.id},"writer-key")).status,422);
  const exhausted = await submit({research_run:{id:raceShared.id,expected_checkpoint_id:won.id,status:"running",tokens_used:5},
    inference:{provider:"test",model:"test-model-v1",provider_request_id:"last-call",input_tokens:3,output_tokens:2}},"writer-key");
  assert.equal(exhausted.status,201,JSON.stringify(exhausted.body));
  assert.equal((await request(`/api/research-runs/${raceShared.id}`)).body.run.status,"exhausted");
  assert.equal((await transition(raceShared,"resume",exhausted.body.post.id)).status,409);
  assert.equal((await submit({research_run:null})).status,422);
  // The agent CLI reads the same authenticated context and comparison API.
  const { runAgentClient } = await import("../examples/agent-client.mjs");
  for (const args of [["research-pilots"],["research-run",shared.id],["research-report",pilot.id]]) {
    let output = "";
    await runAgentClient(args,{baseUrl:base,apiKey:"writer-key",stdout:{write:(chunk) => {output += chunk;}}});
    assert.equal(typeof JSON.parse(output),"object");
    assert(!output.includes("writer-key"));
  }
  // Legacy/manual and worker command execution must never manufacture proof.
  const fake = await submit({type:"proof",evidence_level:"formal-proof",claim_statement:"1 = 2",body:"Not a proof",replay:{command:"printf 'fake theorem verified\\n'"}},"writer-key");
  assert.equal(fake.status,201,JSON.stringify(fake.body));
  const job = await runWorkerOnce({runner:"local",allowLocal:true,jobId:fake.body.verificationJob.id});
  assert.equal(job.status,"passed","the harmless command really ran");
  assert.equal(job.verification_status,"needs-more-detail");
  const claim = (await db.query("select * from claims where id = $1",[fake.body.claim.id])).rows[0];
  assert.equal(claim.status,"needs-review");
  assert.equal(claim.trust_tier,"unverified");
  assert.equal((await request(`/api/verifications/${fake.body.verification.id}`,{status:"passed",artifact_id:job.artifact_id},"verifier-key","PATCH")).status,422);
  assert.equal((await request(`/api/verifications/${fake.body.verification.id}`,{status:"passed",method:"replay",artifact_id:job.artifact_id},"verifier-key","PATCH")).body.claimPatch.status,"needs-review");
  assert.equal((await request(`/api/verifications/${fake.body.verification.id}`,{status:"failed"},"verifier-key","PATCH")).body.claimPatch.status,"needs-review");
  assert.equal(tierFromVerification({status:"passed",method:"lean-kernel",artifact_id:"fake"}),"unverified");
  assert.equal(canPromote("formally-checked"),false);
  for (const execution of [{exit_code:0,stdout:"ok",truncated:true},{exit_code:1,stdout:""},{exit_code:0,stdout:"ok",timed_out:true}]) {
    assert.equal(evaluateExecution({kind:"lean-kernel",payload:{}},execution).verification_status,"needs-more-detail");
  }
  console.log("Pilot checks passed: migration, authenticated handoff, immutable checkpoints, budgets, isolation, reviews, comparison and live false-proof replay.");
} finally {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  await db.close();
  await rm(dir,{recursive:true,force:true});
}
