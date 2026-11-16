# Uptime Kuma MCP

MCP server (Streamable HTTP, Bearer auth) that gives full read/write control over the
local Uptime Kuma at `http://localhost:3001`. It talks to Kuma over socket.io, the same
API the web UI uses.

- Endpoint: `http://127.0.0.1:3005/mcp` (bound to localhost only)
- Config/secrets: `.env` (`KUMA_USERNAME`, `KUMA_PASSWORD`, `MCP_TOKEN`). Not committed.
- Registered in Claude Code (user scope) as `uptime-kuma`.

## Run

On a server, use the Docker setup in the repo root (`./install.sh`). There the container
starts with `AUTO_SETUP=true`, which creates the Kuma admin from env on first run and
creates/updates the Arabic email alert notification when `SMTP_*` is set.

Local Windows (no Docker):

```powershell
d:\UPTIME\start-all.ps1   # starts Kuma (3001) + MCP (3005) hidden; logs in d:\UPTIME\logs
d:\UPTIME\stop-all.ps1
```

```bash
npm start                  # MCP only, foreground
npm run setup-admin        # first-run: create the Kuma admin from .env
node --env-file=.env scripts/smoke-test.js   # end-to-end test of every tool area (cleans up after itself)
```

## Tools (47)

| Area | Tools |
|---|---|
| Overview | `get_overview` |
| Monitors | `list_monitors`, `get_monitor`, `get_monitor_heartbeats`, `get_monitor_events`, `get_monitor_chart_data`, `create_monitor`, `update_monitor`, `delete_monitor`, `pause_monitor`, `resume_monitor`, `clear_monitor_history`, `clear_all_statistics`, `get_push_url` |
| Tags | `list_tags`, `create_tag`, `update_tag`, `delete_tag`, `set_monitor_tag` |
| Notifications | `list_notifications`, `save_notification`, `delete_notification`, `test_notification` |
| Status pages | `list_status_pages`, `get_status_page`, `create_status_page`, `update_status_page`, `delete_status_page`, `post_incident`, `unpin_incident` |
| Maintenance | `list_maintenance`, `get_maintenance`, `save_maintenance`, `set_maintenance_state` |
| Infrastructure | `list_infrastructure`, `save_proxy`, `delete_proxy`, `save_docker_host`, `delete_docker_host` |
| API keys | `list_api_keys`, `create_api_key`, `set_api_key_state` |
| System | `get_settings`, `update_settings`, `get_database_info`, `shrink_database` |
| Anything else | `raw_socket_call` (any Kuma socket event, e.g. `getIncidentHistory`, `addRemoteBrowser`) |

## Notes

- Kuma registers its socket handlers only after it emits `info` to a new connection, so
  the client logs in on `info`, not on `connect` (logging in on `connect` is silently dropped).
- The status-page list is only pushed by Kuma at login; `list_status_pages` refreshes it
  with a short-lived second login.
- `editMonitor` overwrites every field, so `update_monitor` reads the monitor, merges your
  changes, and sends the full object.
