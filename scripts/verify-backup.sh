#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: npm run backup:verify -- <backup-directory>" >&2
  exit 1
fi

backup_path="$1"

verify_file() {
  local file="$1"
  local checksum_file="$2"
  if [[ ! -f "$file" ]]; then
    echo "missing ${file}" >&2
    exit 1
  fi
  if [[ ! -f "$checksum_file" ]]; then
    echo "missing ${checksum_file}" >&2
    exit 1
  fi

  local expected
  expected="$(awk '{print $1; exit}' "$checksum_file")"
  local actual
  actual="$(hash_file "$file")"
  if [[ "$expected" != "$actual" ]]; then
    echo "checksum mismatch for ${file}" >&2
    echo "expected ${expected}" >&2
    echo "actual   ${actual}" >&2
    exit 1
  fi
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

verify_file "${backup_path}/database.dump" "${backup_path}/database.dump.sha256"
verify_file "${backup_path}/artifacts.tar.gz" "${backup_path}/artifacts.tar.gz.sha256"

manifest="${backup_path}/manifest.json"
if [[ ! -f "$manifest" ]]; then
  echo "missing ${manifest}" >&2
  exit 1
fi

node -e 'const fs = require("node:fs"); const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); for (const key of ["created_at", "database", "database_sha256", "artifacts", "artifacts_sha256", "artifact_storage_driver"]) { if (!manifest[key]) throw new Error(`manifest missing ${key}`); }' "$manifest"

echo "backup verified ${backup_path}"
