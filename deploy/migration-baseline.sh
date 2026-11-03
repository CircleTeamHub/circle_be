#!/usr/bin/env bash
# Database-contract fingerprint shared by CI and the staged server release.
# Sourcing this file only defines functions; it never invokes the CLI.
migration_baseline_digest() (
  set -euo pipefail
  export LC_ALL=C
  local root="${1:?source root required}" path hash work
  [ ! -L "$root" ] && cd -- "$root" || return 1
  for path in prisma deploy prisma/migrations; do
    if [ -L "$path" ] || [ ! -d "$path" ]; then
      echo "Invalid database-contract directory: $path" >&2
      return 1
    fi
  done
  for path in prisma/schema.prisma deploy/SCHEMA_COMPATIBILITY; do
    if [ -L "$path" ] || [ ! -f "$path" ]; then
      echo "Invalid database-contract file: $path" >&2
      return 1
    fi
  done
  path=deploy/REQUIRES_IRREVERSIBLE_MIGRATION
  if [ -L "$path" ] || { [ -e "$path" ] && [ ! -f "$path" ]; }; then
    echo "Invalid database-contract marker: $path" >&2
    return 1
  fi
  work="$(mktemp -d)" || return 1
  trap 'rm -rf -- "$work"' EXIT
  find prisma/migrations ! -type d ! -type f -print0 > "$work/invalid" || return 1
  if [ -s "$work/invalid" ]; then
    echo 'Database contract contains a symlink or non-regular migration file.' >&2
    return 1
  fi
  find prisma/migrations -type f -print0 > "$work/files" || return 1
  if [ ! -s "$work/files" ]; then
    echo 'Database contract has no migration files.' >&2
    return 1
  fi
  printf '%s\0' prisma/schema.prisma deploy/SCHEMA_COMPATIBILITY >> "$work/files"
  if [ -f deploy/REQUIRES_IRREVERSIBLE_MIGRATION ]; then
    printf '%s\0' deploy/REQUIRES_IRREVERSIBLE_MIGRATION >> "$work/files"
  fi
  sort -z "$work/files" > "$work/sorted" || return 1
  # NUL separates paths and fixed-size content hashes, avoiding ambiguity even
  # for names containing whitespace/newlines. File content hashes include EOF.
  while IFS= read -r -d '' path; do
    hash="$(sha256sum < "$path")" || return 1
    printf '%s\0%s\0' "$path" "${hash%% *}" >> "$work/contract"
  done < "$work/sorted"
  hash="$(sha256sum < "$work/contract")" || return 1
  printf '%s\n' "${hash%% *}"
)

migration_baseline_matches() {
  local root="${1:?source root required}" approved="${2:-}" actual
  if [[ ! "$approved" =~ ^[0-9a-f]{64}$ ]]; then
    echo 'Migration approval must be exactly 64 lowercase SHA-256 hex characters.' >&2
    return 1
  fi
  actual="$(migration_baseline_digest "$root")" || return 1
  if [ "$actual" != "$approved" ]; then
    echo "Database contract differs from the approved migration baseline ($actual)." >&2
    return 1
  fi
}

if [[ "${BASH_SOURCE[0]}" = "$0" ]]; then
  if [ "$#" != 2 ] || [ "$1" != digest ]; then
    echo 'Usage: bash deploy/migration-baseline.sh digest <source-root>' >&2
    exit 1
  fi
  migration_baseline_digest "$2"
fi
