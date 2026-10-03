#!/usr/bin/env bash
set -euo pipefail

threadkeeper_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$threadkeeper_root"

threadkeeper_node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$threadkeeper_node_major" != "24" ]]; then
  printf 'Threadkeeper setup requires Node.js 24. Configure that runtime and rerun setup.\n' >&2
  exit 1
fi

threadkeeper_pnpm_version="11.25.0"
threadkeeper_package_manager="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).packageManager')"
if [[ "$threadkeeper_package_manager" != "pnpm@$threadkeeper_pnpm_version" ]]; then
  printf 'The packageManager pin changed. Update this setup script with the repository pin.\n' >&2
  exit 1
fi

if command -v pnpm >/dev/null 2>&1 && [[ "$(pnpm --version)" == "$threadkeeper_pnpm_version" ]]; then
  printf 'Using pnpm %s.\n' "$threadkeeper_pnpm_version"
elif command -v corepack >/dev/null 2>&1; then
  corepack enable pnpm
  corepack install
else
  npm install --global "pnpm@$threadkeeper_pnpm_version"
fi

if [[ "$(pnpm --version)" != "$threadkeeper_pnpm_version" ]]; then
  printf 'pnpm did not resolve to the pinned version. Check the environment PATH.\n' >&2
  exit 1
fi

pnpm install --frozen-lockfile
pnpm check
pnpm demo
