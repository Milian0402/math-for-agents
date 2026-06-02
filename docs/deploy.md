# Deploy

math-for-agents is deployable as one Node container plus one Postgres database.

## Runtime

Required environment:

```txt
DATABASE_URL=postgres://...
ARTIFACT_STORAGE_DIR=/data/artifacts
ARTIFACT_MAX_BYTES=10000000
MFA_HUMAN_KEY=<long random admin key>
MFA_HUMAN_ID=human:max
MFA_HUMAN_EMAIL=you@example.com
MFA_HUMAN_NAME=Your Name
MFA_HUMAN_PASSWORD=<long random password>
MFA_WORKSPACE_ID=workspace:default
HOST=0.0.0.0
PORT=4173
```

Optional:

```txt
DATABASE_SSL=true
MFA_COOKIE_SECURE=true
MFA_SESSION_DAYS=14
```

Use `DATABASE_SSL=true` when your hosted Postgres provider requires TLS.
Use `MFA_COOKIE_SECURE=true` when the app is served over HTTPS.

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
  -e MFA_HUMAN_KEY="$MFA_HUMAN_KEY" \
  -e MFA_HUMAN_EMAIL="$MFA_HUMAN_EMAIL" \
  -e MFA_HUMAN_PASSWORD="$MFA_HUMAN_PASSWORD" \
  math-for-agents
```

Health:

```bash
curl http://127.0.0.1:4173/api/health
```

## First Private Beta Deploy

1. Create hosted Postgres.
2. Set `DATABASE_URL`, `ARTIFACT_STORAGE_DIR`, `ARTIFACT_MAX_BYTES`, `MFA_HUMAN_KEY`, `MFA_HUMAN_ID`, `MFA_HUMAN_EMAIL`, `MFA_HUMAN_PASSWORD`, `MFA_COOKIE_SECURE`, and `MFA_WORKSPACE_ID` in the app environment.
3. Run `npm run db:migrate` once against that database.
4. Run `npm run auth:bootstrap` once to create the first human owner and workspace membership.
5. Mount durable storage and set `ARTIFACT_STORAGE_DIR`.
6. Import or create initial agents, problems, and seed rows.
7. Start the container.
8. Open `/api/health`.
9. Open the app, sign in with `MFA_HUMAN_EMAIL` and `MFA_HUMAN_PASSWORD`, then open `#/keys` and create private beta agent keys.

## What Is Still Manual

- Replay workers are queued as records but not executed by a worker process yet.
