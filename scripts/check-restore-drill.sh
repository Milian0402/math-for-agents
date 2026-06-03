#!/usr/bin/env bash
set -euo pipefail

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/mfa-restore-drill-check.XXXXXX")"
artifact_src="${tmp_dir}/artifact-src"
mkdir -p "$artifact_src"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

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

make_backup() {
  local target="$1"
  mkdir -p "$target"
  printf "database bytes\n" > "${target}/database.dump"
  printf "artifact bytes\n" > "${artifact_src}/artifact.txt"
  tar -czf "${target}/artifacts.tar.gz" -C "$artifact_src" .
  write_sha256 "${target}/database.dump" "${target}/database.dump.sha256"
  write_sha256 "${target}/artifacts.tar.gz" "${target}/artifacts.tar.gz.sha256"
  cat > "${target}/manifest.json" <<JSON
{
  "created_at": "20260602T000000Z",
  "database": "database.dump",
  "database_sha256": "$(hash_file "${target}/database.dump")",
  "artifacts": "artifacts.tar.gz",
  "artifacts_sha256": "$(hash_file "${target}/artifacts.tar.gz")",
  "artifact_storage_driver": "local-file"
}
JSON
}

backup_dir="${tmp_dir}/backup"
make_backup "$backup_dir"

DRILL_DATABASE_URL=postgres://drill.example.invalid/math_for_agents \
DRILL_ARTIFACT_STORAGE_DIR="${tmp_dir}/drill-artifacts" \
MFA_RESTORE_DRILL_VALIDATE_ONLY=true \
bash scripts/restore-drill.sh "$backup_dir" >/dev/null

if DRILL_ARTIFACT_STORAGE_DIR="${tmp_dir}/drill-artifacts-missing-db" \
  MFA_RESTORE_DRILL_VALIDATE_ONLY=true \
  bash scripts/restore-drill.sh "$backup_dir" >/dev/null 2>&1; then
  echo "restore drill accepted missing DRILL_DATABASE_URL" >&2
  exit 1
fi

if DATABASE_URL=postgres://same.example.invalid/math_for_agents \
  DRILL_DATABASE_URL=postgres://same.example.invalid/math_for_agents \
  DRILL_ARTIFACT_STORAGE_DIR="${tmp_dir}/drill-artifacts-same-db" \
  MFA_RESTORE_DRILL_VALIDATE_ONLY=true \
  bash scripts/restore-drill.sh "$backup_dir" >/dev/null 2>&1; then
  echo "restore drill accepted DRILL_DATABASE_URL equal to DATABASE_URL" >&2
  exit 1
fi

mkdir -p "${tmp_dir}/non-empty-artifacts"
printf "existing\n" > "${tmp_dir}/non-empty-artifacts/existing.txt"
if DRILL_DATABASE_URL=postgres://drill.example.invalid/math_for_agents \
  DRILL_ARTIFACT_STORAGE_DIR="${tmp_dir}/non-empty-artifacts" \
  MFA_RESTORE_DRILL_VALIDATE_ONLY=true \
  bash scripts/restore-drill.sh "$backup_dir" >/dev/null 2>&1; then
  echo "restore drill accepted a non-empty artifact directory" >&2
  exit 1
fi

printf "corruption\n" >> "${backup_dir}/database.dump"
if DRILL_DATABASE_URL=postgres://drill.example.invalid/math_for_agents \
  DRILL_ARTIFACT_STORAGE_DIR="${tmp_dir}/drill-artifacts-corrupt" \
  MFA_RESTORE_DRILL_VALIDATE_ONLY=true \
  bash scripts/restore-drill.sh "$backup_dir" >/dev/null 2>&1; then
  echo "restore drill accepted a corrupted backup" >&2
  exit 1
fi

echo "restore drill checks passed."
