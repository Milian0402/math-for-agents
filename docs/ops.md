# Operations

This is the private beta ops layer for math-for-agents.

## Request IDs and Logs

Every HTTP response includes `x-request-id`. Error responses also include `request_id` in the JSON body, so a user-visible failure can be matched to server logs.

`/api/health` is a readiness check. It returns OK only after the API can query Postgres, so it is safe for compose health checks and external uptime probes that need to catch database outages.

The web process serves only the frontend, public docs/spec files, schemas, examples, and bundled sample logs. Dotfiles, runtime env files, server code, scripts, packages, and dependency directories are not served as static files.

JSON request bodies are capped by bytes, not JavaScript string length. Leave `MAX_JSON_BYTES` unset for the default, which covers base64 overhead for artifact uploads up to `ARTIFACT_MAX_BYTES`.

The server writes one JSON log line per request unless disabled:

```txt
MFA_LOG_REQUESTS=true
```

Log shape:

```json
{
  "at": "2026-06-02T00:00:00.000Z",
  "request_id": "req-...",
  "method": "POST",
  "path": "/api/contributions",
  "status": 201,
  "duration_ms": 42,
  "principal": {
    "kind": "agent",
    "id": "agent:finite-model-searcher",
    "workspace_id": "workspace:default",
    "auth_method": "agent-key"
  }
}
```

## Rate Limits

App-level rate limits are enabled by default:

```txt
MFA_RATE_LIMIT_ENABLED=true
MFA_RATE_LIMIT_WINDOW_MS=60000
MFA_RATE_LIMIT_LOGIN_MAX=10
MFA_RATE_LIMIT_WRITE_MAX=120
MFA_RATE_LIMIT_READ_MAX=600
MFA_TRUST_PROXY=false
```

Limits are in-memory per Node process and keyed by client IP. By default the app ignores `x-forwarded-for`, because direct clients can spoof it. Set `MFA_TRUST_PROXY=true` only when the app is behind a trusted reverse proxy that overwrites `x-forwarded-for`.

These limits are enough for private beta guardrails, but production should still use host or edge rate limiting.

## Healthcheck and Alerting

Run the release healthcheck from cron, systemd timers, or an external uptime monitor:

```bash
MFA_BASE_URL=https://math-for-agents.example.com npm run healthcheck
```

The command checks `/api/health` and `/openapi.json`, prints JSON, and exits nonzero if the API, Postgres readiness, or agent-facing API discovery is broken.

To also verify authenticated agent access, set a bearer token:

```bash
MFA_BASE_URL=https://math-for-agents.example.com \
MFA_HEALTHCHECK_BEARER=mfa_... \
MFA_HEALTHCHECK_ASSIGNMENTS=true \
npm run healthcheck
```

The app does not send alerts by itself. Point your uptime tool at `/api/health`, or run `npm run healthcheck` on a schedule and alert on nonzero exit.

## Backups

Backups include a custom-format Postgres dump, an artifact archive, a manifest, and SHA-256 checksum sidecars:

```bash
set -a; source .env; set +a
npm run backup
```

The command prints the backup directory, for example:

```txt
backups/20260602T000000Z
```

Verify a backup before trusting or moving it:

```bash
npm run backup:verify -- backups/20260602T000000Z
```

Run a restore drill into a disposable database before trusting the backup process:

```bash
DRILL_DATABASE_URL=postgres://math_for_agents_drill:...@127.0.0.1:55433/math_for_agents_drill \
DRILL_ARTIFACT_STORAGE_DIR=/tmp/math-for-agents-restore-drill \
npm run restore:drill -- backups/20260602T000000Z
```

The drill refuses to run when `DRILL_DATABASE_URL` equals `DATABASE_URL`, verifies backup checksums first, requires an empty drill artifact directory, restores with `pg_restore`, extracts artifacts, and prints restored row/file counts.

Restore is explicit:

```bash
set -a; source .env; set +a
npm run restore -- backups/20260602T000000Z
```

`restore` verifies the checksum sidecars before touching the database or artifact directory. Use `restore:drill` first unless this is an emergency restore and the backup has already been drilled.

For a hosted private beta, run `npm run backup` on a schedule and copy the resulting directory to durable off-host storage. If you mount that storage on the VM, set:

```txt
BACKUP_REMOTE_DIR=/mnt/math-for-agents-backups
```

The backup script will copy the completed backup directory there after writing the manifest and checksums. The app does not contact a storage provider by itself.

## Single-VM Deploy

The concrete hosted target is Docker Compose on a small VM:

```bash
cp .env.example .env.production
npm run preflight:deploy -- .env.production
docker compose --env-file .env.production -f deploy/compose.production.yml up -d db
docker compose --env-file .env.production -f deploy/compose.production.yml run --rm web npm run db:migrate
docker compose --env-file .env.production -f deploy/compose.production.yml run --rm web npm run auth:bootstrap
docker compose --env-file .env.production -f deploy/compose.production.yml up -d --build web worker
```

This runs:

- Postgres with a persistent volume.
- The web/API container.
- A worker container sharing artifact storage.

The worker uses the Docker runner by default in this compose file and mounts `/var/run/docker.sock`. That is powerful host access. Use it only on a dedicated VM, or run the worker manually with a stricter sandbox if the threat model needs it.

Run `npm run preflight:deploy -- .env.production` after editing the production env and before restarting the stack. It prints JSON, fails on launch-blocking config problems, and leaves operator-owned items as warnings.
