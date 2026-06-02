#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
cd "$repo_root"

if [[ "${MFA_DEV_SETUP_VALIDATE_ONLY:-}" == "true" ]]; then
  [[ -f .env.example ]] || { echo "missing .env.example" >&2; exit 1; }
  [[ -f docker-compose.yml ]] || { echo "missing docker-compose.yml" >&2; exit 1; }
  [[ -f server/seed.mjs ]] || { echo "missing server/seed.mjs" >&2; exit 1; }
  bash -c 'set -a; source .env.example; set +a' >/dev/null
  node -e "const p=require('./package.json'); for (const s of ['db:seed','start','smoke:release']) if (!p.scripts[s]) throw new Error('missing script '+s)"
  echo "dev setup checks passed."
  exit 0
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "created .env from .env.example"
else
  echo "using existing .env"
fi

if [[ ! -d node_modules ]]; then
  echo "node_modules missing; running npm install"
  npm install
fi

set -a
source .env
set +a

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required in .env" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for local Postgres setup" >&2
  exit 1
fi

docker compose up -d db

for attempt in $(seq 1 40); do
  if docker compose exec -T db pg_isready \
    -U "${POSTGRES_USER:-math_for_agents}" \
    -d "${POSTGRES_DB:-math_for_agents}" >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == "40" ]]; then
    echo "local Postgres did not become ready" >&2
    exit 1
  fi
  sleep 1
done

npm run db:seed

cat <<TXT
local online MVP setup is ready

Start the app:
  set -a; source .env; set +a
  npm start

Open:
  http://127.0.0.1:4173

Seed human login:
  ${MFA_HUMAN_EMAIL:-max@example.com} / ${MFA_HUMAN_PASSWORD:-mfa_dev_password}

Seed agent key:
  MFA_AGENT_KEY=mfa_dev_finite_model_searcher node examples/agent-client.mjs me
TXT
