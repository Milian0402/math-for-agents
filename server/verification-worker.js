import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { materializeArtifactContent } from "./artifact-storage.js";
import { query, transaction } from "./db.js";
import { makeId } from "./ids.js";
import { createArtifact, updateVerification } from "./repository.js";

const EXECUTABLE_KINDS = new Set(["replay", "cas", "lean-kernel"]);

export async function runWorkerOnce(options = {}) {
  const runner = resolveRunner(options);
  if (runner === "disabled") {
    return { claimed: false, reason: "worker runner disabled" };
  }

  const job = await claimNextVerificationJob(options);
  if (!job) return { claimed: false, reason: "no runnable jobs" };

  try {
    const command = commandForJob(job);
    if (!command) {
      const reason = "verification job has no replay.command payload";
      await updateVerification(job.workspace_id, job.verification_id, {
        status: "needs-more-detail",
        notes: reason
      });
      await finishVerificationJob(job.id, "blocked", { reason });
      return { claimed: true, job_id: job.id, status: "blocked", reason };
    }

    const execution = await runCommand(command, { ...options, runner, kind: job.kind });
    const verdict = evaluateExecution(job, execution);
    const artifact = await persistExecutionArtifact(job, execution, verdict);
    await updateVerification(job.workspace_id, job.verification_id, {
      status: verdict.verification_status,
      artifact_id: artifact.id,
      notes: verdict.notes
    });
    await finishVerificationJob(job.id, verdict.job_status, {
      ...verdict,
      artifact_id: artifact.id,
      execution
    });
    return {
      claimed: true,
      job_id: job.id,
      status: verdict.job_status,
      verification_status: verdict.verification_status,
      artifact_id: artifact.id
    };
  } catch (error) {
    const status = job.attempts >= maxAttempts(options) ? "error" : "queued";
    await finishVerificationJob(job.id, status, {
      error: error.message,
      attempts: job.attempts
    });
    return { claimed: true, job_id: job.id, status, error: error.message };
  }
}

export async function claimNextVerificationJob(options = {}) {
  const lockSeconds = Number(options.lockSeconds || process.env.MFA_WORKER_LOCK_SECONDS || 300);
  return transaction(async (client) => {
    const result = await client.query(
      `select verification_jobs.*,
              verifications.priority,
              verifications.method,
              verifications.claim_id,
              claims.problem_id,
              claims.statement as claim_statement
         from verification_jobs
         join verifications on verifications.id = verification_jobs.verification_id
        and verifications.workspace_id = verification_jobs.workspace_id
         join claims on claims.id = verifications.claim_id
        and claims.workspace_id = verification_jobs.workspace_id
        where verification_jobs.kind = any($1)
          and verification_jobs.status in ('queued', 'waiting-for-replay')
          and (
            verification_jobs.locked_at is null
            or verification_jobs.locked_at < now() - ($2 * interval '1 second')
          )
        order by
          case verifications.priority when 'high' then 1 when 'medium' then 2 else 3 end,
          verification_jobs.created_at asc
        limit 1
        for update of verification_jobs skip locked`,
      [[...EXECUTABLE_KINDS], lockSeconds]
    );
    const job = result.rows[0] || null;
    if (!job) return null;

    const updated = await client.query(
      `update verification_jobs
          set status = 'running',
              attempts = attempts + 1,
              locked_at = now(),
              updated_at = now()
        where id = $1
        returning *`,
      [job.id]
    );
    return { ...job, ...updated.rows[0] };
  });
}

export async function finishVerificationJob(jobId, status, result) {
  await query(
    `update verification_jobs
        set status = $2,
            result = $3,
            locked_at = null,
            updated_at = now()
      where id = $1`,
    [jobId, status, JSON.stringify(result || {})]
  );
}

export function commandForJob(job) {
  const payload = job?.payload || {};
  return payload.replay?.command?.trim?.() || payload.command?.trim?.() || "";
}

export function stdoutHash(stdout) {
  return `sha256:${createHash("sha256").update(stdout || "").digest("hex")}`;
}

export function evaluateExecution(job, execution) {
  const actualHash = stdoutHash(execution.stdout);
  const expectedHash = normalizeHash(job?.payload?.replay?.output_hash || job?.payload?.output_hash);
  const hashMatches = !expectedHash || expectedHash === actualHash;
  const exitedCleanly = execution.exit_code === 0 && !execution.timed_out;

  if (exitedCleanly && hashMatches) {
    return {
      job_status: "passed",
      verification_status: "passed",
      stdout_hash: actualHash,
      expected_hash: expectedHash,
      notes: expectedHash ? "Worker replay passed and stdout hash matched." : "Worker replay passed."
    };
  }

  if (expectedHash && actualHash !== expectedHash) {
    return {
      job_status: "failed",
      verification_status: "failed",
      stdout_hash: actualHash,
      expected_hash: expectedHash,
      notes: "Worker replay failed: stdout hash did not match the claimed output hash."
    };
  }

  return {
    job_status: "needs-more-detail",
    verification_status: "needs-more-detail",
    stdout_hash: actualHash,
    expected_hash: expectedHash,
    notes: execution.timed_out
      ? "Worker replay timed out before producing a settled result."
      : `Worker replay exited with code ${execution.exit_code}.`
  };
}

export async function runCommand(command, options = {}) {
  const runner = resolveRunner(options);
  if (runner === "local" && process.env.MFA_WORKER_ALLOW_LOCAL !== "true" && options.allowLocal !== true) {
    throw new Error("local worker runner requires MFA_WORKER_ALLOW_LOCAL=true");
  }
  if (runner === "disabled") {
    throw new Error("worker runner disabled");
  }

  const startedAt = Date.now();
  const timeoutMs = Number(options.timeoutMs || process.env.MFA_WORKER_TIMEOUT_MS || 60_000);
  const maxOutputBytes = Number(options.maxOutputBytes || process.env.MFA_WORKER_MAX_OUTPUT_BYTES || 256_000);
  const child = runner === "docker" ? spawnDocker(command, options) : spawn("sh", ["-lc", command], { stdio: ["ignore", "pipe", "pipe"] });

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const appended = appendOutput(stdout, chunk, maxOutputBytes - outputBytes);
      stdout = appended.text;
      outputBytes += appended.bytes;
      truncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk) => {
      const appended = appendOutput(stderr, chunk, maxOutputBytes - outputBytes);
      stderr = appended.text;
      outputBytes += appended.bytes;
      truncated ||= appended.truncated;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        runner,
        command,
        exit_code: typeof code === "number" ? code : null,
        signal,
        timed_out: timedOut,
        truncated,
        duration_ms: Date.now() - startedAt,
        stdout,
        stderr
      });
    });
  });
}

function spawnDocker(command, options) {
  const image = imageForKind(options.kind);
  return spawn(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--cpus",
      process.env.MFA_WORKER_DOCKER_CPUS || "1",
      "--memory",
      process.env.MFA_WORKER_DOCKER_MEMORY || "512m",
      "--pids-limit",
      process.env.MFA_WORKER_DOCKER_PIDS || "256",
      "--tmpfs",
      "/tmp:rw,nosuid,size=64m",
      image,
      "sh",
      "-lc",
      command
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
}

async function persistExecutionArtifact(job, execution, verdict) {
  const content = [
    `verification_job: ${job.id}`,
    `verification_id: ${job.verification_id}`,
    `kind: ${job.kind}`,
    `runner: ${execution.runner}`,
    `command: ${execution.command}`,
    `exit_code: ${execution.exit_code}`,
    `signal: ${execution.signal || ""}`,
    `timed_out: ${execution.timed_out}`,
    `stdout_hash: ${verdict.stdout_hash}`,
    `expected_hash: ${verdict.expected_hash || ""}`,
    "",
    "stdout:",
    execution.stdout || "",
    "",
    "stderr:",
    execution.stderr || ""
  ].join("\n");
  const artifact = await materializeArtifactContent(
    job.workspace_id,
    {
      id: makeId("artifact"),
      created_at: new Date().toISOString(),
      problem_id: job.problem_id,
      owner: "agent:verifier",
      kind: `${job.kind}-worker-log`,
      title: `${labelForKind(job.kind)} worker log`,
      summary: verdict.notes,
      path: "#",
      content_hash: null,
      metadata: {
        verification_job_id: job.id,
        verification_id: job.verification_id,
        runner: execution.runner,
        duration_ms: execution.duration_ms,
        exit_code: execution.exit_code,
        timed_out: execution.timed_out,
        stdout_hash: verdict.stdout_hash,
        expected_hash: verdict.expected_hash || null
      }
    },
    {
      file_name: `${job.id}.txt`,
      content_type: "text/plain; charset=utf-8",
      content_text: content
    }
  );
  return createArtifact(job.workspace_id, artifact);
}

function appendOutput(current, chunk, remainingBytes) {
  if (remainingBytes <= 0) return { text: current, bytes: 0, truncated: true };
  const buffer = Buffer.from(chunk);
  const slice = buffer.subarray(0, Math.max(0, remainingBytes));
  return {
    text: current + slice.toString("utf8"),
    bytes: slice.length,
    truncated: slice.length < buffer.length
  };
}

function resolveRunner(options = {}) {
  return options.runner || process.env.MFA_WORKER_RUNNER || "disabled";
}

function imageForKind(kind) {
  if (kind === "lean-kernel" && process.env.MFA_WORKER_IMAGE_LEAN) return process.env.MFA_WORKER_IMAGE_LEAN;
  if (kind === "cas" && process.env.MFA_WORKER_IMAGE_CAS) return process.env.MFA_WORKER_IMAGE_CAS;
  if (kind === "replay" && process.env.MFA_WORKER_IMAGE_REPLAY) return process.env.MFA_WORKER_IMAGE_REPLAY;
  return process.env.MFA_WORKER_IMAGE || "python:3.12-alpine";
}

function normalizeHash(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.startsWith("sha256:") ? text : `sha256:${text}`;
}

function maxAttempts(options = {}) {
  return Number(options.maxAttempts || process.env.MFA_WORKER_MAX_ATTEMPTS || 3);
}

function labelForKind(kind) {
  if (kind === "lean-kernel") return "Lean";
  if (kind === "cas") return "CAS";
  return "Replay";
}
