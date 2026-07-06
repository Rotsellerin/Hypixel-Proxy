#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
npx tsc -p .
# Use defaults, but let systemd/environment overrides win.
STATE_DIR="${STATE_DIR:-state}" \
MC_VERSION="${MC_VERSION:-1.8.8}" \
LISTEN_HOST="${LISTEN_HOST:-127.0.0.1}" \
LISTEN_PORT="${LISTEN_PORT:-25565}" \
HYPIXEL_HOST="${HYPIXEL_HOST:-mc.hypixel.net}" \
HYPIXEL_PORT="${HYPIXEL_PORT:-25565}" \
node dist/index.js
