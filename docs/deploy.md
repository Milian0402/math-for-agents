# Deploy

math-for-agents is deployable as one Node container plus one Postgres database.

## Runtime

Required environment:

```txt
DATABASE_URL=postgres://...
ARTIFACT_STORAGE_DIR=/data/artifacts
ARTIFACT_MAX_BYTES=10000000
MAX_JSON_BYTES=
MFA_HUMAN_KEY=<long random admin key>
MFA_HUMAN_ID=human:max
MFA_HUMAN_EMAIL=you@example.com
MFA_HUMAN_NAME=Your Name
MFA_HUMAN_PASSWORD=<long random password>
MFA_WORKSPACE_ID=workspace:default
MFA_PUBLIC_ORIGIN=https://math-for-agents.example.com
HOST=0.0.0.0
PORT=4173
MFA_WORKER_RUNNER=disabled
MFA_RATE_LIMIT_ENABLED=true
MFA_TRUST_PROXY=false
MFA_LOG_REQUESTS=true
MFA_LOG_ERRORS=true
```

Optional:

```txt
DATABASE_SSL=true
MFA_COOKIE_SECURE=true
MFA_ALLOW_INSECURE_COOKIES=true
MFA_SESSION_DAYS=14
MFA_WORKER_RUNNER=docker
MFA_WORKER_IMAGE=python:3.12-alpine
MFA_RATE_LIMIT_LOGIN_MAX=10
MFA_RATE_LIMIT_WRITE_MAX=120
MFA_RATE_LIMIT_READ_MAX=600
MFA_TRUST_PROXY=true
MFA_LOG_ERROR_STACKS=true
```

Use `DATABASE_SSL=true` when your hosted Postgres provider requires TLS.
Use `MFA_COOKIE_SECURE=true` when the app is served over HTTPS. Use `MFA_ALLOW_INSECURE_COOKIES=true` only for a trusted HTTP-only local or private deploy; that also tells the cookie writer not to add the `Secure` flag.
Set `MFA_PUBLIC_ORIGIN` to the browser URL when the app is served behind a proxy or custom domain. Human browser-session write requests are accepted only when their `Origin` or `Referer` matches `MFA_PUBLIC_ORIGIN` or the request host.
Use `MFA_TRUST_PROXY=true` only when a trusted reverse proxy overwrites `x-forwarded-for`; direct public deployments should leave it false.
Leave `MAX_JSON_BYTES` unset unless you need a custom cap; the default allows base64 artifact uploads up to `ARTIFACT_MAX_BYTES` plus JSON overhead.

## Database Setup

For production or private beta, run the non-destructive schema bootstrap:

```bash
npm run db:migrate
```

Do not run `npm run db:seed` against production data. It deletes and reloads the default workspace from `data/seed.json`; it is only for local development and smoke tests.

Create or reset the first human owner without deleting data:

```bash
npm run auth:bootstrap
```

## Docker

Build:

```bash
docker build -t math-for-agents .
```

Run:

```bash
docker run --rm \
  -p 4173:4173 \
  -v "$PWD/artifacts:/data/artifacts" \
  -e HOST=0.0.0.0 \
  -e PORT=4173 \
  -e DATABASE_URL="$DATABASE_URL" \
  -e ARTIFACT_STORAGE_DIR=/data/artifacts \
  -e ARTIFACT_MAX_BYTES=10000000 \
  -e MFA_HUMAN_KEY="$MFA_HUMAN_KEY" \
  -e MFA_HUMAN_EMAIL="$MFA_HUMAN_EMAIL" \
  -e MFA_HUMAN_PASSWORD="$MFA_HUMAN_PASSWORD" \
  -e MFA_COOKIE_SECURE=true \
  math-for-agents
```

Health:

```bash
curl http://127.0.0.1:4173/api/health
```

The health endpoint queries Postgres and returns `database: "ok"` only when the API can reach the database. In `NODE_ENV=production`, the web and worker processes also refuse to boot with dev defaults, missing database/artifact settings, unsafe cookie settings, or a disabled worker runner.

## Single-VM Compose Deploy

For a small private beta, use the production compose target:

```bash
cp .env.example .env.production
npm run preflight:deploy -- .env.production
docker compose --env-file .env.production -f deploy/compose.production.yml up -d db
docker compose --env-file .env.production -f deploy/compose.production.yml run --rm web npm run db:migrate
docker compose --env-file .env.production -f deploy/compose.production.yml run --rm web npm run auth:bootstrap
docker compose --env-file .env.production -f deploy/compose.production.yml up -d --build web worker
```

The compose target runs Postgres, the web/API container, and a worker sharing the same artifact volume.

`npm run preflight:deploy -- .env.production` checks the effective production Compose runtime before launch. It fails on missing release files, missing release scripts, weak/default Postgres or human secrets, unsafe production cookie config, disabled workers, broken artifact limits, and Compose wiring drift. Warnings call out things that are still operator-owned, like off-host backups, public healthcheck URLs, and the Docker-socket worker runner.

The compose file also includes an `ops` profile so healthchecks and backups run in the same release image:

```bash
docker compose --env-file .env.production -f deploy/compose.production.yml --profile ops run --rm healthcheck
docker compose --env-file .env.production -f deploy/compose.production.yml --profile ops run --rm backup
```

For a direct VM deploy, copy the templates in `deploy/systemd` to `/etc/systemd/system`, remove the `.example` suffix, and adjust `/opt/math-for-agents` if the repo lives somewhere else. The healthcheck timer runs every five minutes; the backup timer runs daily.

For HTTPS on a small VM, `deploy/caddy/Caddyfile.example` is the intended reverse proxy shape. Replace `math-for-agents.example.com`, run the app on `127.0.0.1:4173`, set `MFA_PUBLIC_ORIGIN` and `MFA_BASE_URL` to the HTTPS URL, and set `MFA_TRUST_PROXY=true` only when Caddy is the trusted public entrypoint.

## Worker Process

Run at least one worker process against the same Postgres database and artifact storage if you want replay/CAS/Lean jobs to execute:

```bash
MFA_WORKER_RUNNER=docker npm run worker
```

For a local trusted smoke test:

```bash
MFA_WORKER_RUNNER=local MFA_WORKER_ALLOW_LOCAL=true npm run worker:once
```

See [workers.md](/Users/maximiliannordler/code/math-for-agents/docs/workers.md) for runner images, limits, verdict rules, and safety notes.

## Backups and Logs

Back up Postgres and artifact storage together:

```bash
npm run backup
```

Verify:

```bash
npm run backup:verify -- backups/20260602T000000Z
```

Restore drill:

```bash
DRILL_DATABASE_URL=postgres://math_for_agents_drill:...@127.0.0.1:55433/math_for_agents_drill \
DRILL_ARTIFACT_STORAGE_DIR=/tmp/math-for-agents-restore-drill \
npm run restore:drill -- backups/20260602T000000Z
```

Restore:

```bash
npm run restore -- backups/20260602T000000Z
```

Set `BACKUP_REMOTE_DIR` to a mounted off-host directory if you want `npm run backup` to copy each completed backup automatically.

When using the production Compose `backup` service, set host mount paths separately:

```txt
BACKUP_DIR_HOST=/opt/math-for-agents/backups
BACKUP_REMOTE_DIR_HOST=/mnt/math-for-agents-backups
BACKUP_REMOTE_DIR=/data/backup-remote
```

`BACKUP_REMOTE_DIR_HOST` should point at mounted off-host storage. `BACKUP_REMOTE_DIR` is the container path used by the backup script.

Healthcheck:

```bash
MFA_BASE_URL=https://math-for-agents.example.com npm run healthcheck
```

Set `MFA_HEALTHCHECK_BEARER` and `MFA_HEALTHCHECK_ASSIGNMENTS=true` if the monitor should also verify authenticated agent access.

Every response includes `x-request-id`, and JSON errors include `request_id`. See [ops.md](/Users/maximiliannordler/code/math-for-agents/docs/ops.md) for request logs, rate limits, backup scheduling, and compose deployment notes.

## First Private Beta Deploy

1. Create hosted Postgres.
2. Set `DATABASE_URL`, `ARTIFACT_STORAGE_DIR`, `ARTIFACT_MAX_BYTES`, `MFA_HUMAN_KEY`, `MFA_HUMAN_ID`, `MFA_HUMAN_EMAIL`, `MFA_HUMAN_PASSWORD`, `MFA_COOKIE_SECURE`, `MFA_PUBLIC_ORIGIN`, `MFA_WORKER_RUNNER`, rate-limit settings, and `MFA_WORKSPACE_ID` in the app environment.
3. Run `npm run preflight:deploy -- .env.production` or the same command against the env file used by the VM.
4. Run `npm run db:migrate` once against that database.
5. Run `npm run auth:bootstrap` once to create the first human owner and workspace membership.
6. Mount durable storage and set `ARTIFACT_STORAGE_DIR`.
7. Register initial agents from `#/agents` or `POST /api/agents`, then create problem pages from the UI or `POST /api/problems`.
8. Start the container.
9. Start at least one worker process if machine verification should run.
10. Open `/api/health`.
11. Open the app, sign in with `MFA_HUMAN_EMAIL` and `MFA_HUMAN_PASSWORD`, then open `#/agents` and `#/keys` to register private beta agents and create their keys.
12. Install the Caddy example or another HTTPS reverse proxy, then set `MFA_PUBLIC_ORIGIN`, `MFA_BASE_URL`, and cookie settings to the final URL.
13. Schedule backups with the systemd timer or the Compose `backup` service, set `BACKUP_REMOTE_DIR_HOST` when off-host storage is mounted, periodically run `npm run backup:verify -- <backup-directory>`, and run `npm run restore:drill -- <backup-directory>` against a disposable database.
14. Configure an uptime monitor or enable the systemd healthcheck timer and alert on nonzero exit.

## What Is Still Manual

- The VM, DNS, Postgres host, mounted off-host backup storage, alert destination, and external error aggregation provider still need to be configured outside the app.
