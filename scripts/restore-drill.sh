#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: DRILL_DATABASE_URL=postgres://... DRILL_ARTIFACT_STORAGE_DIR=/tmp/mfa-drill npm run restore:drill -- <backup-directory>" >&2
  exit 1
fi

if [[ -z "${DRILL_DATABASE_URL:-}" ]]; then
  echo "DRILL_DATABASE_URL is required and must point at a disposable drill database" >&2
  exit 1
fi

if [[ -n "${DATABASE_URL:-}" && "$DRILL_DATABASE_URL" == "$DATABASE_URL" ]]; then
  echo "DRILL_DATABASE_URL must not equal DATABASE_URL" >&2
  exit 1
fi

if [[ -z "${DRILL_ARTIFACT_STORAGE_DIR:-}" ]]; then
  echo "DRILL_ARTIFACT_STORAGE_DIR is required and must point at an empty disposable directory" >&2
  exit 1
fi

backup_path="$1"
artifact_dir="$DRILL_ARTIFACT_STORAGE_DIR"
database_dump="${backup_path}/database.dump"
artifact_archive="${backup_path}/artifacts.tar.gz"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$artifact_dir" == "/" ]]; then
  echo "DRILL_ARTIFACT_STORAGE_DIR must not be /" >&2
  exit 1
fi

if [[ ! -f "$database_dump" ]]; then
  echo "missing ${database_dump}" >&2
  exit 1
fi

if [[ ! -f "$artifact_archive" ]]; then
  echo "missing ${artifact_archive}" >&2
  exit 1
fi

if [[ -e "$artifact_dir" && ! -d "$artifact_dir" ]]; then
  echo "DRILL_ARTIFACT_STORAGE_DIR exists but is not a directory: ${artifact_dir}" >&2
  exit 1
fi

if [[ -d "$artifact_dir" ]] && find "$artifact_dir" -mindepth 1 -maxdepth 1 | read -r; then
  echo "DRILL_ARTIFACT_STORAGE_DIR must be empty: ${artifact_dir}" >&2
  exit 1
fi

bash "${script_dir}/verify-backup.sh" "$backup_path" >/dev/null

if [[ "${MFA_RESTORE_DRILL_VALIDATE_ONLY:-}" == "true" ]]; then
  echo "restore drill validated ${backup_path}"
  exit 0
fi

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "pg_restore is required for restore drills" >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required for restore drill verification" >&2
  exit 1
fi

pg_restore --clean --if-exists --no-owner --no-acl --dbname="$DRILL_DATABASE_URL" "$database_dump"

mkdir -p "$artifact_dir"
tar -xzf "$artifact_archive" -C "$artifact_dir"

workspace_count="$(psql "$DRILL_DATABASE_URL" -Atc "select count(*) from workspaces")"
problem_count="$(psql "$DRILL_DATABASE_URL" -Atc "select count(*) from problems")"
artifact_rows="$(psql "$DRILL_DATABASE_URL" -Atc "select count(*) from artifacts")"
artifact_files="$(find "$artifact_dir" -type f | wc -l | tr -d ' ')"

cat <<JSON
{
  "ok": true,
  "backup": "${backup_path}",
  "drill_artifact_storage_dir": "${artifact_dir}",
  "workspace_count": ${workspace_count},
  "problem_count": ${problem_count},
  "artifact_rows": ${artifact_rows},
  "artifact_files": ${artifact_files}
}
JSON
