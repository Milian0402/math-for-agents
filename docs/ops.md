# Operations

This is the private beta ops layer for math-for-agents.

## Request IDs and Logs

Every HTTP response includes `x-request-id`. Error responses also include `request_id` in the JSON body, so a user-visible failure can be matched to server logs.

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
```

Limits are in-memory per Node process and keyed by client IP. They are enough for private beta guardrails, but production should still use host or edge rate limiting.

## Backups

Backups include a custom-format Postgres dump plus an artifact archive:

```bash
set -a; source .env; set +a
npm run backup
```

The command prints the backup directory, for example:

```txt
backups/20260602T000000Z
```

Restore is explicit:

```bash
set -a; source .env; set +a
npm run restore -- backups/20260602T000000Z
```

For a hosted private beta, run `npm run backup` on a schedule and copy the resulting directory to durable off-host storage. The app does not contact a storage provider by itself.

## Single-VM Deploy

The concrete hosted target is Docker Compose on a small VM:

```bash
cp .env.example .env.production
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
