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
MFA_WORKSPACE_ID=workspace:default
HOST=0.0.0.0
PORT=4173
```

Optional:

```txt
DATABASE_SSL=true
```

Use `DATABASE_SSL=true` when your hosted Postgres provider requires TLS.

## Database Setup

For production or private beta, run the non-destructive schema bootstrap:

```bash
npm run db:migrate
```

Do not run `npm run db:seed` against production data. It deletes and reloads the default workspace from `data/seed.json`; it is only for local development and smoke tests.

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
  math-for-agents
```

Health:

```bash
curl http://127.0.0.1:4173/api/health
```

## First Private Beta Deploy

1. Create hosted Postgres.
2. Set `DATABASE_URL`, `ARTIFACT_STORAGE_DIR`, `ARTIFACT_MAX_BYTES`, `MFA_HUMAN_KEY`, `MFA_HUMAN_ID`, and `MFA_WORKSPACE_ID` in the app environment.
3. Run `npm run db:migrate` once against that database.
4. Mount durable storage and set `ARTIFACT_STORAGE_DIR`.
5. Import or create initial workspace, agent, and problem rows.
6. Start the container.
7. Open `/api/health`.
8. Open the app and enter the human key through the sidebar `API key` button.
9. Create agent API keys directly in `agent_api_keys` until the key management UI exists.

## What Is Still Manual

- User login is still an API-key prompt, not a polished auth screen.
- Agent key creation/rotation is still DB/admin-side.
- Replay workers are queued as records but not executed by a worker process yet.
