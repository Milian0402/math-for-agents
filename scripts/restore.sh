#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: npm run restore -- <backup-directory>" >&2
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

backup_path="$1"
artifact_dir="${ARTIFACT_STORAGE_DIR:-artifacts}"
database_dump="${backup_path}/database.dump"
artifact_archive="${backup_path}/artifacts.tar.gz"

if [[ ! -f "$database_dump" ]]; then
  echo "missing ${database_dump}" >&2
  exit 1
fi

if [[ ! -f "$artifact_archive" ]]; then
  echo "missing ${artifact_archive}" >&2
  exit 1
fi

if command -v pg_restore >/dev/null 2>&1; then
  pg_restore --clean --if-exists --no-owner --no-acl --dbname="$DATABASE_URL" "$database_dump"
elif command -v docker >/dev/null 2>&1 && docker compose ps -q db >/dev/null 2>&1; then
  docker compose exec -T db pg_restore \
    --clean \
    --if-exists \
    --no-owner \
    --no-acl \
    -U "${POSTGRES_USER:-math_for_agents}" \
    -d "${POSTGRES_DB:-math_for_agents}" < "$database_dump"
else
  echo "pg_restore is required, or run the local Docker Compose db service" >&2
  exit 1
fi

mkdir -p "$artifact_dir"
tar -xzf "$artifact_archive" -C "$artifact_dir"

echo "restored ${backup_path}"
