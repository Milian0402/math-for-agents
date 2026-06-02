#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "sha256sum or shasum is required" >&2
    exit 1
  fi
}

write_sha256() {
  local file="$1"
  local output="$2"
  printf "%s  %s\n" "$(hash_file "$file")" "$(basename "$file")" > "$output"
}

file_bytes() {
  wc -c < "$1" | tr -d ' '
}

json_escape() {
  printf "%s" "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

backup_dir="${BACKUP_DIR:-backups}"
artifact_dir="${ARTIFACT_STORAGE_DIR:-artifacts}"
remote_dir="${BACKUP_REMOTE_DIR:-}"
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

write_sha256 "${target_dir}/database.dump" "${target_dir}/database.dump.sha256"
write_sha256 "${target_dir}/artifacts.tar.gz" "${target_dir}/artifacts.tar.gz.sha256"

database_sha256="$(hash_file "${target_dir}/database.dump")"
artifact_sha256="$(hash_file "${target_dir}/artifacts.tar.gz")"
database_bytes="$(file_bytes "${target_dir}/database.dump")"
artifact_bytes="$(file_bytes "${target_dir}/artifacts.tar.gz")"
remote_target=""
if [[ -n "$remote_dir" ]]; then
  remote_target="${remote_dir%/}/${timestamp}"
fi

cat > "${target_dir}/manifest.json" <<JSON
{
  "created_at": "${timestamp}",
  "database": "database.dump",
  "database_sha256": "${database_sha256}",
  "database_bytes": ${database_bytes},
  "artifacts": "artifacts.tar.gz",
  "artifacts_sha256": "${artifact_sha256}",
  "artifacts_bytes": ${artifact_bytes},
  "artifact_storage_dir": "$(json_escape "$artifact_dir")",
  "remote_copy": "$(json_escape "$remote_target")"
}
JSON

if [[ -n "$remote_dir" ]]; then
  mkdir -p "$remote_target"
  cp -R "${target_dir}/." "$remote_target/"
  echo "copied backup to ${remote_target}" >&2
fi

echo "$target_dir"
