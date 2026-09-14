# Verification Workers

The web app records machine-checkable verification work in `verification_jobs`. The worker process claims those jobs, runs the recorded command, stores the execution log as an artifact, and patches the verification with that artifact.

## Run Modes

Default:

```txt
MFA_WORKER_RUNNER=disabled
```

This is safe for web-only development. The worker exits without claiming jobs.

Local trusted smoke test:

```bash
MFA_WORKER_RUNNER=local \
MFA_WORKER_ALLOW_LOCAL=true \
npm run worker:once
```

Use local mode only for trusted commands on your own machine.

Private beta runner:

```bash
MFA_WORKER_RUNNER=docker \
MFA_WORKER_IMAGE=python:3.12-alpine \
npm run worker
```

Docker jobs run with no network, CPU/memory limits, a PID limit, and a temporary `/tmp`. Use method-specific images when needed:

```txt
MFA_WORKER_IMAGE_REPLAY=python:3.12-alpine
MFA_WORKER_IMAGE_CAS=sagemath/sagemath:latest
MFA_WORKER_IMAGE_LEAN=leanprover/lean4:latest
```

## What Gets Executed

The worker only processes `replay`, `cas`, and `lean-kernel` jobs with a payload command:

```json
{
  "replay": {
    "command": "python check.py --seed 7",
    "seed": "7",
    "env": "python 3.12",
    "output_hash": "sha256:..."
  }
}
```

If the command is missing, the job is marked `blocked` and the verification asks for more detail.

## Verdicts

- Exit code `0` with complete output, and a matching `output_hash` if supplied, passes the execution job only.
- Every generic replay leaves mathematical verification at `needs-more-detail`.
- Hash mismatch fails the execution job, without refuting the theorem.
- Timeout, truncated output or non-zero exit also asks for more detail.

Every executed job creates a stored artifact containing stdout, stderr, exit status, command, runner, duration, and hashes. A log, printed success string or manual pass cannot certify a theorem, even for a job labeled `lean-kernel`. Automatic acceptance remains disabled pending a trusted checker that binds the exact theorem, artifact and environment. See [research pilot verification](research-pilot.md#verification-boundary).

## Operational Knobs

```txt
MFA_WORKER_POLL_MS=5000
MFA_WORKER_TIMEOUT_MS=60000
MFA_WORKER_MAX_OUTPUT_BYTES=256000
MFA_WORKER_MAX_ATTEMPTS=3
MFA_WORKER_LOCK_SECONDS=300
MFA_WORKER_DOCKER_CPUS=1
MFA_WORKER_DOCKER_MEMORY=512m
MFA_WORKER_DOCKER_PIDS=256
```

For production, run the web process and at least one worker process against the same Postgres database and artifact storage volume.
