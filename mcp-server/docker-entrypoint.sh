#!/bin/sh
set -eu
mkdir -p "$HOME" "$HYPIT_WORKSPACE" "$HYPIT_JOBS_DIR"
exec node /app/mcp-server/dist/server.js
