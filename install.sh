#!/usr/bin/env bash
# One-command install/update of Uptime Kuma + its MCP server on a Linux VPS.
#   git clone https://github.com/SamehHammad/uptime.git && cd uptime && sudo ./install.sh
# Re-running is safe: it keeps your .env and data, and rebuilds/restarts the containers.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- Docker ------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
    say "Installing Docker"
    curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose ...)"

# --- .env --------------------------------------------------------------------
[ -f .env ] || { cp .env.example .env; say "Created .env from .env.example"; }

get_var() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true; }
set_var() {
    if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
rand_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

[ -n "$(get_var KUMA_USERNAME)" ] || set_var KUMA_USERNAME admin
[ -n "$(get_var KUMA_PASSWORD)" ] || { set_var KUMA_PASSWORD "Kuma-$(rand_hex 10)-A9"; say "Generated KUMA_PASSWORD"; }
[ -n "$(get_var MCP_TOKEN)" ] || { set_var MCP_TOKEN "$(rand_hex 32)"; say "Generated MCP_TOKEN"; }
chmod 600 .env
mkdir -p data/uptime-kuma data/caddy

DOMAIN="$(get_var DOMAIN)"
if [ -n "$DOMAIN" ]; then
    # Behind Caddy: keep the raw ports private to the server
    set_var KUMA_PORT_BIND 127.0.0.1:3001
    set_var MCP_PORT_BIND 127.0.0.1:3005
    PROFILE=(--profile https)
else
    set_var KUMA_PORT_BIND 3001
    set_var MCP_PORT_BIND 3005
    PROFILE=()
fi

# --- Start -------------------------------------------------------------------
say "Starting containers"
docker compose ${PROFILE[@]+"${PROFILE[@]}"} up -d --build --remove-orphans

say "Waiting for Uptime Kuma + MCP (first start can take a couple of minutes)"
ok=""
for _ in $(seq 1 90); do
    if curl -fsS http://127.0.0.1:3005/health 2>/dev/null | grep -q '"kumaConnected":true'; then ok=1; break; fi
    sleep 3
done
[ -n "$ok" ] || die "MCP did not connect to Kuma. Check: docker compose logs mcp uptime-kuma"

# --- Summary -----------------------------------------------------------------
if [ -n "$DOMAIN" ]; then
    KUMA_PUBLIC="https://$DOMAIN"
    MCP_PUBLIC="https://$DOMAIN/mcp"
else
    IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    KUMA_PUBLIC="http://${IP:-SERVER_IP}:3001"
    MCP_PUBLIC="http://${IP:-SERVER_IP}:3005/mcp"
fi
TOKEN="$(get_var MCP_TOKEN)"

cat <<EOF

============================================================
 Uptime Kuma : $KUMA_PUBLIC
 Login       : $(get_var KUMA_USERNAME) / $(get_var KUMA_PASSWORD)
 MCP URL     : $MCP_PUBLIC
 MCP token   : $TOKEN
============================================================

Claude Code:
  claude mcp add --transport http --scope user uptime-kuma $MCP_PUBLIC --header "Authorization: Bearer $TOKEN"

Claude Desktop (claude_desktop_config.json -> "mcpServers"):
  "uptime-kuma": {
    "command": "npx",
    "args": ["-y", "mcp-remote", "$MCP_PUBLIC", "--allow-http", "--header", "Authorization:\${AUTH_HEADER}"],
    "env": { "AUTH_HEADER": "Bearer $TOKEN" }
  }
EOF

if [ -z "$DOMAIN" ]; then
    echo
    echo "NOTE: without DOMAIN the MCP token travels over plain HTTP. Set DOMAIN in .env and re-run ./install.sh for HTTPS."
fi
