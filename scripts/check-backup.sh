#!/usr/bin/env bash
set -euo pipefail

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/mfa-backup-check.XXXXXX")"
artifact_dir="${tmp_dir}/artifact-src"
mkdir -p "$artifact_dir"

write_sha256() {
  local file="$1"
  local output="$2"
  printf "%s  %s\n" "$(hash_file "$file")" "$(basename "$file")" > "$output"
}

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

printf "database bytes\n" > "${tmp_dir}/database.dump"
printf "artifact bytes\n" > "${artifact_dir}/artifact.txt"
tar -czf "${tmp_dir}/artifacts.tar.gz" -C "$artifact_dir" .

write_sha256 "${tmp_dir}/database.dump" "${tmp_dir}/database.dump.sha256"
write_sha256 "${tmp_dir}/artifacts.tar.gz" "${tmp_dir}/artifacts.tar.gz.sha256"

bash scripts/verify-backup.sh "$tmp_dir" >/dev/null

printf "corruption\n" >> "${tmp_dir}/database.dump"
if bash scripts/verify-backup.sh "$tmp_dir" >/dev/null 2>&1; then
  echo "backup verifier accepted a corrupted database dump" >&2
  exit 1
fi

echo "backup verifier checks passed."
