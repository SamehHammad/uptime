// End-to-end check through the MCP protocol. Creates test objects and removes them.
// Run with: node --env-file=.env scripts/smoke-test.js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(`http://${process.env.MCP_HOST}:${process.env.MCP_PORT}/mcp`);

// 1) Unauthorized request must be rejected
const unauth = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
console.log("no-token request ->", unauth.status, unauth.status === 401 ? "OK" : "FAIL");

const client = new Client({ name: "smoke", version: "1" });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } } }));

const tools = (await client.listTools()).tools;
console.log(`tools: ${tools.length}`);

let failures = 0;
async function call(name, args = {}) {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    const tag = r.isError ? "FAIL" : "ok  ";
    if (r.isError) {
        failures++;
    }
    console.log(`${tag} ${name} ${JSON.stringify(args).slice(0, 70)} -> ${text.replace(/\s+/g, " ").slice(0, 110)}`);
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

const { monitor_id } = await call("create_monitor", { name: "MCP smoke test", type: "http", url: "https://example.com", interval: 30 });
const group = await call("create_monitor", { name: "MCP smoke group", type: "group" });
await call("update_monitor", { monitor_id, changes: { name: "MCP smoke test (edited)", interval: 45, parent: group.monitor_id } });
await new Promise((r) => setTimeout(r, 6000)); // let a heartbeat land
await call("get_monitor", { monitor_id });
await call("list_monitors", { search: "smoke" });
await call("get_monitor_heartbeats", { monitor_id, hours: 1, limit: 3 });
await call("get_monitor_events", { monitor_id });
await call("get_monitor_chart_data", { monitor_id, period_hours: 1 });
await call("pause_monitor", { monitor_id });
await call("resume_monitor", { monitor_id });

const tag = await call("create_tag", { name: "mcp-smoke", color: "#16A34A" });
await call("set_monitor_tag", { action: "add", tag_id: tag.id, monitor_id, value: "v1" });
await call("update_tag", { tag_id: tag.id, color: "#DC2626" });

const notif = await call("save_notification", {
    name: "MCP smoke webhook",
    config: { type: "webhook", webhookURL: "http://127.0.0.1:9/never", webhookContentType: "json" },
});
await call("save_notification", { notification_id: notif.notification_id, name: "MCP smoke webhook (edited)" });
await call("update_monitor", { monitor_id, notification_ids: [notif.notification_id] });
await call("list_notifications");

await call("create_status_page", { title: "MCP Smoke", slug: "mcp-smoke" });
await call("update_status_page", { slug: "mcp-smoke", changes: { description: "made by MCP" }, groups: [{ name: "Services", monitor_ids: [monitor_id] }] });
await call("post_incident", { slug: "mcp-smoke", title: "Test incident", content: "hello", style: "info" });
await call("get_status_page", { slug: "mcp-smoke" });
await call("unpin_incident", { slug: "mcp-smoke" });
await call("list_status_pages");

const mt = await call("save_maintenance", { title: "MCP smoke maintenance", strategy: "manual", monitor_ids: [monitor_id] });
await call("get_maintenance", { maintenance_id: mt.maintenance_id });
await call("set_maintenance_state", { maintenance_id: mt.maintenance_id, action: "pause" });
await call("list_maintenance");

const key = await call("create_api_key", { name: "mcp-smoke" });
await call("set_api_key_state", { key_id: key.key_id, action: "disable" });

await call("get_overview");
await call("get_settings");
await call("get_database_info");
await call("list_infrastructure");
await call("raw_socket_call", { event: "twoFAStatus" });

// cleanup
await call("set_api_key_state", { key_id: key.key_id, action: "delete" });
await call("set_maintenance_state", { maintenance_id: mt.maintenance_id, action: "delete" });
await call("delete_status_page", { slug: "mcp-smoke" });
await call("delete_notification", { notification_id: notif.notification_id });
await call("delete_tag", { tag_id: tag.id });
await call("delete_monitor", { monitor_id });
await call("delete_monitor", { monitor_id: group.monitor_id });
await call("list_monitors");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
await client.close();
process.exit(failures ? 1 : 0);
