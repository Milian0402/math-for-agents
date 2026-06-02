#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

backup_dir="${BACKUP_DIR:-backups}"
artifact_dir="${ARTIFACT_STORAGE_DIR:-artifacts}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target_dir="${backup_dir}/${timestamp}"

mkdir -p "$target_dir"

if command -v pg_dump >/dev/null 2>&1; then
  pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl --file="${target_dir}/database.dump"
elif command -v docker >/dev/null 2>&1 && docker compose ps -q db >/dev/null 2>&1; then
  docker compose exec -T db pg_dump \
    -U "${POSTGRES_USER:-math_for_agents}" \
    -d "${POSTGRES_DB:-math_for_agents}" \
    --format=custom \
    --no-owner \
    --no-acl > "${target_dir}/database.dump"
else
  echo "pg_dump is required, or run the local Docker Compose db service" >&2
  exit 1
fi

if [[ -d "$artifact_dir" ]]; then
  tar -czf "${target_dir}/artifacts.tar.gz" -C "$artifact_dir" .
else
  tar -czf "${target_dir}/artifacts.tar.gz" --files-from /dev/null
fi

cat > "${target_dir}/manifest.json" <<JSON
{
  "created_at": "${timestamp}",
  "database": "database.dump",
  "artifacts": "artifacts.tar.gz",
  "artifact_storage_dir": "${artifact_dir}"
}
JSON

echo "$target_dir"
