// MCP tool definitions for Uptime Kuma (full read + write control).
import { z } from "zod";

const STATUS = { 0: "down", 1: "up", 2: "pending", 3: "maintenance" };

// Field defaults the Uptime Kuma web UI sends when creating a monitor
// (src/pages/EditMonitor.vue `monitorDefaults`). The server's "add" handler
// expects a complete object, so new monitors start from these.
const MONITOR_DEFAULTS = {
    type: "http",
    name: "",
    parent: null,
    url: "https://",
    wsSubprotocol: "",
    method: "GET",
    protocol: null,
    location: "world",
    ipFamily: null,
    interval: 60,
    // Anti-flapping: a site is only declared DOWN (and alerted) after the first
    // failure plus 3 failed retries 30s apart (~1.5 min). Short blips send nothing.
    retryInterval: 30,
    resendInterval: 0,
    maxretries: 3,
    retryOnlyOnStatusCodeFailure: false,
    notificationIDList: {},
    ignoreTls: false,
    upsideDown: false,
    expiryNotification: false,
    domainExpiryNotification: true,
    maxredirects: 10,
    accepted_statuscodes: ["200-299"],
    saveResponse: false,
    saveErrorResponse: true,
    responseMaxLength: 1024,
    dns_resolve_type: "A",
    dns_resolve_server: "",
    docker_container: "",
    docker_host: null,
    proxyId: null,
    basic_auth_user: "",
    basic_auth_pass: "",
    bearer_token: "",
    mqttUsername: "",
    mqttPassword: "",
    mqttTopic: "",
    mqttWebsocketPath: "",
    mqttSuccessMessage: "",
    mqttCheckType: "keyword",
    authMethod: null,
    oauth_auth_method: "client_secret_basic",
    httpBodyEncoding: "json",
    kafkaProducerBrokers: [],
    kafkaProducerSaslOptions: { mechanism: "None" },
    cacheBust: false,
    kafkaProducerSsl: false,
    kafkaProducerAllowAutoTopicCreation: false,
    gamedigGivenPortOnly: true,
    gamedigToken: "",
    remote_browser: null,
    screenshot_delay: 0,
    rabbitmqNodes: [],
    rabbitmqUsername: "",
    rabbitmqPassword: "",
    conditions: [],
    system_service_name: "",
    sshAuthMethod: "password",
    ntpStratumThreshold: 5,
    ntpTimeOffsetThreshold: 1000,
    ntpRootDispersionThreshold: 500,
};

const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const anyObject = z.record(z.string(), z.any());

/** Server-side JSON columns come back as strings in toJSON(); the edit handler wants them parsed. */
function normalizeMonitorForEdit(m) {
    const out = { ...m };
    for (const key of ["kafkaProducerBrokers", "kafkaProducerSaslOptions", "conditions", "rabbitmqNodes"]) {
        if (typeof out[key] === "string") {
            try {
                out[key] = JSON.parse(out[key]);
            } catch {
                /* leave as is */
            }
        }
    }
    if (Array.isArray(out.accepted_statuscodes)) {
        out.accepted_statuscodes = out.accepted_statuscodes.map(String);
    }
    return out;
}

function toNotificationIDList(ids) {
    if (!ids) {
        return undefined;
    }
    return Object.fromEntries(ids.map((id) => [String(id), true]));
}

export function registerTools(server, kuma) {
    /** Register a tool with uniform error handling. */
    const tool = (name, description, inputSchema, handler, { readOnly = false, destructive = false } = {}) => {
        server.registerTool(
            name,
            {
                description,
                inputSchema,
                annotations: { readOnlyHint: readOnly, destructiveHint: destructive },
            },
            async (args) => {
                try {
                    return json(await handler(args ?? {}));
                } catch (e) {
                    return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
                }
            }
        );
    };

    const monitorSummary = (m) => {
        const beat = kuma.cache.heartbeat[m.id];
        return {
            id: m.id,
            name: m.name,
            type: m.type,
            target: m.url && m.url !== "https://" ? m.url : (m.hostname ?? null),
            port: m.port ?? undefined,
            active: !!m.active,
            status: beat ? STATUS[beat.status] : "unknown",
            last_check: beat?.time ?? null,
            last_msg: beat?.msg || undefined,
            ping_ms: beat?.ping ?? null,
            uptime_24h: kuma.cache.uptime[m.id]?.["24"] ?? null,
            avg_ping_24h: kuma.cache.avgPing[m.id] ?? null,
            interval: m.interval,
            parent: m.parent ?? null,
            tags: (m.tags ?? []).map((t) => (t.value ? `${t.name}:${t.value}` : t.name)),
        };
    };

    const getMonitorRaw = async (monitorId) => (await kuma.call("getMonitor", monitorId)).monitor;

    // ------------------------------------------------------------------ overview
    tool(
        "get_overview",
        "Dashboard overview: counts of monitors by status, list of monitors currently down, server info and version.",
        {},
        async () => {
            await kuma.refreshLoginLists("statusPageList");
            const monitors = Object.values(kuma.cache.monitorList).map(monitorSummary);
            const counts = { total: monitors.length, up: 0, down: 0, pending: 0, maintenance: 0, paused: 0, unknown: 0 };
            for (const m of monitors) {
                if (!m.active) {
                    counts.paused++;
                } else {
                    counts[m.status] = (counts[m.status] ?? 0) + 1;
                }
            }
            return {
                server: kuma.cache.info,
                counts,
                down: monitors.filter((m) => m.active && m.status === "down"),
                status_pages: (Object.values(kuma.cache.statusPageList ?? {})).length,
                active_maintenance: Object.values(kuma.cache.maintenanceList ?? {}).filter((x) => x.status === "under-maintenance").map((x) => ({ id: x.id, title: x.title })),
            };
        },
        { readOnly: true }
    );

    // ------------------------------------------------------------------ monitors
    tool(
        "list_monitors",
        "List all monitors with current status (up/down/pending/maintenance), last ping, 24h uptime, tags. Optional filters.",
        {
            status: z.enum(["up", "down", "pending", "maintenance", "unknown", "paused"]).optional(),
            type: z.string().optional().describe("Monitor type, e.g. http, keyword, ping, port, dns, docker, group, push"),
            search: z.string().optional().describe("Case-insensitive match on name or target"),
        },
        async ({ status, type, search }) => {
            await kuma.ready();
            let list = Object.values(kuma.cache.monitorList).map(monitorSummary);
            if (status === "paused") {
                list = list.filter((m) => !m.active);
            } else if (status) {
                list = list.filter((m) => m.active && m.status === status);
            }
            if (type) {
                list = list.filter((m) => m.type === type);
            }
            if (search) {
                const s = search.toLowerCase();
                list = list.filter((m) => m.name?.toLowerCase().includes(s) || String(m.target ?? "").toLowerCase().includes(s));
            }
            return list.sort((a, b) => a.id - b.id);
        },
        { readOnly: true }
    );

    tool(
        "get_monitor",
        "Full configuration of one monitor plus its latest heartbeat, uptime (24h/30d/1y), average ping and TLS certificate info.",
        { monitor_id: z.number().int() },
        async ({ monitor_id }) => ({
            monitor: await getMonitorRaw(monitor_id),
            latest_heartbeat: kuma.cache.heartbeat[monitor_id] ?? null,
            uptime: kuma.cache.uptime[monitor_id] ?? null,
            avg_ping_24h: kuma.cache.avgPing[monitor_id] ?? null,
            cert_info: kuma.cache.certInfo[monitor_id] ?? null,
        }),
        { readOnly: true }
    );

    tool(
        "get_monitor_heartbeats",
        "Heartbeat history for a monitor over the last N hours (newest last). Use limit to cap output.",
        {
            monitor_id: z.number().int(),
            hours: z.number().positive().default(24),
            limit: z.number().int().positive().default(100).describe("Return only the most recent N beats"),
            only_failures: z.boolean().default(false),
        },
        async ({ monitor_id, hours, limit, only_failures }) => {
            const res = await kuma.call("getMonitorBeats", monitor_id, hours);
            let data = res.data ?? [];
            if (only_failures) {
                data = data.filter((b) => b.status !== 1);
            }
            return {
                total_in_period: res.data?.length ?? 0,
                returned: Math.min(limit, data.length),
                beats: data.slice(-limit).map((b) => ({ time: b.time, status: STATUS[b.status], ping: b.ping, msg: b.msg, duration: b.duration })),
            };
        },
        { readOnly: true }
    );

    tool(
        "get_monitor_events",
        "Important events (status changes up<->down) for a monitor, newest first, paged.",
        { monitor_id: z.number().int(), offset: z.number().int().min(0).default(0), count: z.number().int().positive().default(25) },
        async ({ monitor_id, offset, count }) => {
            const total = await kuma.call("monitorImportantHeartbeatListCount", monitor_id);
            const res = await kuma.call("monitorImportantHeartbeatListPaged", monitor_id, offset, count);
            return {
                total: total?.count ?? null,
                events: (res.data ?? []).map((b) => ({ time: b.time, status: STATUS[b.status], msg: b.msg, ping: b.ping })),
            };
        },
        { readOnly: true }
    );

    tool(
        "get_monitor_chart_data",
        "Aggregated uptime/ping buckets for a monitor (minutely <=24h, hourly <=720h, daily above).",
        { monitor_id: z.number().int(), period_hours: z.number().int().positive().default(24) },
        async ({ monitor_id, period_hours }) => (await kuma.call("getMonitorChartData", monitor_id, period_hours)).data,
        { readOnly: true }
    );

    tool(
        "create_monitor",
        "Create a monitor. Common types: http, keyword, json-query, ping, port, dns, push, group, docker, real-browser, " +
            "mysql, postgres, sqlserver, mongodb, redis, mqtt, grpc-keyword, tailscale-ping, snmp, smtp, websocket-upgrade. " +
            "Any additional Uptime Kuma monitor field can be passed in `extra` (e.g. keyword, invertKeyword, jsonPath, expectedValue, " +
            "body, headers, basic_auth_user, databaseConnectionString, docker_container, docker_host, dns_resolve_type).",
        {
            name: z.string(),
            type: z.string().default("http"),
            url: z.string().optional().describe("For http/keyword/json-query/real-browser/websocket"),
            hostname: z.string().optional().describe("For ping/port/dns/etc."),
            port: z.number().int().optional(),
            method: z.string().optional(),
            keyword: z.string().optional().describe("Required for type=keyword"),
            interval: z.number().int().min(20).optional().describe("Seconds between checks (default 60)"),
            retry_interval: z.number().int().optional(),
            max_retries: z.number().int().optional(),
            timeout: z.number().optional().describe("Request timeout seconds"),
            accepted_status_codes: z.array(z.string()).optional().describe('e.g. ["200-299"]'),
            parent_id: z.number().int().optional().describe("Group monitor id"),
            description: z.string().optional(),
            notification_ids: z.array(z.number().int()).optional(),
            ignore_tls: z.boolean().optional(),
            upside_down: z.boolean().optional(),
            expiry_notification: z.boolean().optional(),
            extra: anyObject.optional().describe("Any other raw monitor fields"),
        },
        async (a) => {
            const monitor = { ...MONITOR_DEFAULTS, name: a.name, type: a.type };
            if (a.type === "websocket-upgrade") {
                monitor.url = "wss://";
                monitor.accepted_statuscodes = ["1000"];
            }
            const set = (k, v) => v !== undefined && (monitor[k] = v);
            set("url", a.url);
            set("hostname", a.hostname);
            set("port", a.port);
            set("method", a.method);
            set("keyword", a.keyword);
            set("interval", a.interval);
            set("retryInterval", a.retry_interval);
            set("maxretries", a.max_retries);
            set("timeout", a.timeout ?? (a.interval ? Math.min(48, a.interval * 0.8) : 48));
            set("accepted_statuscodes", a.accepted_status_codes);
            set("parent", a.parent_id);
            set("description", a.description);
            set("notificationIDList", toNotificationIDList(a.notification_ids));
            set("ignoreTls", a.ignore_tls);
            set("upsideDown", a.upside_down);
            set("expiryNotification", a.expiry_notification);
            Object.assign(monitor, a.extra ?? {});
            const res = await kuma.call("add", monitor);
            return { ok: true, monitor_id: res.monitorID, msg: res.msg };
        }
    );

    tool(
        "update_monitor",
        "Update any fields of an existing monitor. Pass only the fields to change in `changes` using Uptime Kuma field names " +
            "(e.g. name, url, hostname, port, interval, retryInterval, maxretries, timeout, keyword, method, headers, body, " +
            "accepted_statuscodes, parent, description, ignoreTls, upsideDown, expiryNotification). " +
            "`notification_ids` replaces the attached notifications.",
        { monitor_id: z.number().int(), changes: anyObject.default({}), notification_ids: z.array(z.number().int()).optional() },
        async ({ monitor_id, changes, notification_ids }) => {
            const current = normalizeMonitorForEdit(await getMonitorRaw(monitor_id));
            const updated = { ...current, ...changes, id: monitor_id };
            if (notification_ids) {
                updated.notificationIDList = toNotificationIDList(notification_ids);
            }
            const res = await kuma.call("editMonitor", updated);
            return { ok: true, monitor_id: res.monitorID ?? monitor_id, msg: res.msg };
        }
    );

    tool(
        "set_alert_policy",
        "Control WHEN alerts fire, for all monitors (default) or selected ones. Anti-flapping: `retries` failed re-checks, " +
            "`retry_interval` seconds apart, must ALL fail before a monitor is declared DOWN and an alert is sent; if the site " +
            "recovers during the retries nothing is sent (UP->PENDING->UP is silent). DOWN after ≈ retries × retry_interval seconds. " +
            "`resend_every` = re-send the DOWN alert every N checks while still down (0 = never). " +
            "Example: retries 3, retry_interval 30 → alert only after ~1.5 min of continuous failure.",
        {
            retries: z.number().int().min(0).max(20).optional(),
            retry_interval: z.number().int().min(20).optional().describe("Seconds between retries (min 20)"),
            resend_every: z.number().int().min(0).optional().describe("Resend DOWN alert every N checks while down; 0 = never"),
            monitor_ids: z.array(z.number().int()).optional().describe("Default: every monitor"),
        },
        async ({ retries, retry_interval, resend_every, monitor_ids }) => {
            await kuma.ready();
            const ids = monitor_ids ?? Object.values(kuma.cache.monitorList).filter((m) => m.type !== "group").map((m) => m.id);
            const results = [];
            for (const id of ids) {
                try {
                    const current = normalizeMonitorForEdit(await getMonitorRaw(id));
                    const updated = { ...current, id };
                    if (retries !== undefined) {
                        updated.maxretries = retries;
                    }
                    if (retry_interval !== undefined) {
                        updated.retryInterval = retry_interval;
                    }
                    if (resend_every !== undefined) {
                        updated.resendInterval = resend_every;
                    }
                    await kuma.call("editMonitor", updated);
                    results.push({
                        id,
                        name: current.name,
                        retries: updated.maxretries,
                        retry_interval: updated.retryInterval,
                        resend_every: updated.resendInterval,
                        down_alert_after_seconds: updated.maxretries * updated.retryInterval,
                    });
                } catch (e) {
                    results.push({ id, error: e.message });
                }
            }
            return results;
        }
    );

    tool(
        "delete_monitor",
        "Permanently delete a monitor and its history. For group monitors, delete_children also deletes the child monitors.",
        { monitor_id: z.number().int(), delete_children: z.boolean().default(false) },
        async ({ monitor_id, delete_children }) => kuma.call("deleteMonitor", monitor_id, delete_children),
        { destructive: true }
    );

    tool("pause_monitor", "Pause (stop checking) a monitor.", { monitor_id: z.number().int() }, async ({ monitor_id }) =>
        kuma.call("pauseMonitor", monitor_id)
    );

    tool("resume_monitor", "Resume (start checking) a paused monitor.", { monitor_id: z.number().int() }, async ({ monitor_id }) =>
        kuma.call("resumeMonitor", monitor_id)
    );

    tool(
        "clear_monitor_history",
        "Delete stored history of a monitor: 'heartbeats' (all beats) or 'events' (important events only).",
        { monitor_id: z.number().int(), what: z.enum(["heartbeats", "events"]) },
        async ({ monitor_id, what }) => kuma.call(what === "heartbeats" ? "clearHeartbeats" : "clearEvents", monitor_id),
        { destructive: true }
    );

    tool(
        "clear_all_statistics",
        "Delete ALL heartbeat/uptime statistics for ALL monitors. Irreversible.",
        { confirm: z.literal(true) },
        async () => kuma.call("clearStatistics"),
        { destructive: true }
    );

    tool(
        "get_push_url",
        "Get the push URL for a push-type monitor (external services call it to report status).",
        { monitor_id: z.number().int() },
        async ({ monitor_id }) => {
            const m = await getMonitorRaw(monitor_id);
            if (m.type !== "push") {
                throw new Error(`Monitor ${monitor_id} is type "${m.type}", not "push".`);
            }
            const base = kuma.cache.info?.primaryBaseURL || kuma.url;
            return { push_url: `${base}/api/push/${m.pushToken}?status=up&msg=OK&ping=` };
        },
        { readOnly: true }
    );

    // ------------------------------------------------------------------ tags
    tool("list_tags", "List all tags.", {}, async () => (await kuma.call("getTags")).tags, { readOnly: true });

    tool(
        "create_tag",
        "Create a tag.",
        { name: z.string(), color: z.string().default("#2563EB").describe("Hex color") },
        async ({ name, color }) => (await kuma.call("addTag", { name, color, new: true })).tag
    );

    tool(
        "update_tag",
        "Rename or recolor a tag.",
        { tag_id: z.number().int(), name: z.string().optional(), color: z.string().optional() },
        async ({ tag_id, name, color }) => {
            const tags = (await kuma.call("getTags")).tags;
            const tag = tags.find((t) => t.id === tag_id);
            if (!tag) {
                throw new Error(`Tag ${tag_id} not found`);
            }
            return (await kuma.call("editTag", { id: tag_id, name: name ?? tag.name, color: color ?? tag.color })).tag;
        }
    );

    tool("delete_tag", "Delete a tag (removes it from all monitors).", { tag_id: z.number().int() }, async ({ tag_id }) => kuma.call("deleteTag", tag_id), {
        destructive: true,
    });

    tool(
        "set_monitor_tag",
        "Attach (action=add) or detach (action=remove) a tag on a monitor, with an optional value.",
        { action: z.enum(["add", "remove"]), tag_id: z.number().int(), monitor_id: z.number().int(), value: z.string().default("") },
        async ({ action, tag_id, monitor_id, value }) => kuma.call(action === "add" ? "addMonitorTag" : "deleteMonitorTag", tag_id, monitor_id, value)
    );

    // ------------------------------------------------------------------ notifications
    tool(
        "list_notifications",
        "List configured notification channels (Telegram, Slack, Discord, email, webhook, ...) with their config.",
        {},
        async () => {
            await kuma.ready();
            return (kuma.cache.notificationList ?? []).map((n) => {
                let config = n.config;
                try {
                    config = JSON.parse(n.config);
                } catch {
                    /* keep string */
                }
                return { id: n.id, name: n.name, active: !!n.active, isDefault: !!n.isDefault, config };
            });
        },
        { readOnly: true }
    );

    tool(
        "save_notification",
        "Create (omit notification_id) or update a notification channel. `config` holds provider fields, e.g. " +
            '{"type":"telegram","telegramBotToken":"...","telegramChatID":"..."} or {"type":"webhook","webhookURL":"...","webhookContentType":"json"} ' +
            'or {"type":"discord","discordWebhookUrl":"..."}. On update, config is merged into the existing config.',
        {
            notification_id: z.number().int().optional(),
            name: z.string().optional(),
            config: anyObject.default({}),
            is_default: z.boolean().optional().describe("Enable by default for new monitors"),
            apply_existing: z.boolean().default(false).describe("Also attach to all existing monitors"),
        },
        async ({ notification_id, name, config, is_default, apply_existing }) => {
            let base = {};
            if (notification_id) {
                await kuma.ready();
                const existing = (kuma.cache.notificationList ?? []).find((n) => n.id === notification_id);
                if (!existing) {
                    throw new Error(`Notification ${notification_id} not found`);
                }
                base = JSON.parse(existing.config);
                base.isDefault = !!existing.isDefault;
            }
            const notification = { ...base, ...config, applyExisting: apply_existing };
            if (name !== undefined) {
                notification.name = name;
            }
            if (is_default !== undefined) {
                notification.isDefault = is_default;
            }
            if (!notification.name || !notification.type) {
                throw new Error("A new notification needs `name` and `config.type`.");
            }
            const res = await kuma.call("addNotification", notification, notification_id ?? null);
            return { ok: true, notification_id: res.id, msg: res.msg };
        }
    );

    tool("delete_notification", "Delete a notification channel.", { notification_id: z.number().int() }, async ({ notification_id }) =>
        kuma.call("deleteNotification", notification_id), { destructive: true }
    );

    tool(
        "test_notification",
        "Send a test message through a saved notification (by id) or an unsaved config.",
        { notification_id: z.number().int().optional(), config: anyObject.optional() },
        async ({ notification_id, config }) => {
            let n = config;
            if (notification_id) {
                await kuma.ready();
                const existing = (kuma.cache.notificationList ?? []).find((x) => x.id === notification_id);
                if (!existing) {
                    throw new Error(`Notification ${notification_id} not found`);
                }
                n = JSON.parse(existing.config);
            }
            if (!n) {
                throw new Error("Pass notification_id or config");
            }
            return kuma.call("testNotification", n);
        }
    );

    // ------------------------------------------------------------------ status pages
    tool(
        "list_status_pages",
        "List public status pages.",
        {},
        async () => {
            await kuma.refreshLoginLists("statusPageList");
            return Object.values(kuma.cache.statusPageList ?? {}).map((p) => ({
                id: p.id,
                slug: p.slug,
                title: p.title,
                published: p.published,
                url: `${kuma.cache.info?.primaryBaseURL || kuma.url}/status/${p.slug}`,
            }));
        },
        { readOnly: true }
    );

    tool(
        "get_status_page",
        "Full status page config, monitor groups, pinned incident and maintenance.",
        { slug: z.string() },
        async ({ slug }) => {
            const config = (await kuma.call("getStatusPage", slug)).config;
            let publicData = null;
            try {
                publicData = await kuma.httpGet(`/api/status-page/${encodeURIComponent(slug)}`);
            } catch (e) {
                publicData = { error: e.message };
            }
            return {
                config,
                groups: publicData?.publicGroupList ?? null,
                incident: publicData?.incident ?? null,
                maintenance: publicData?.maintenanceList ?? null,
            };
        },
        { readOnly: true }
    );

    tool("create_status_page", "Create a new (empty) status page.", { title: z.string(), slug: z.string().describe("lowercase a-z0-9 and dashes") }, async ({ title, slug }) =>
        kuma.call("addStatusPage", title, slug)
    );

    tool(
        "update_status_page",
        "Update a status page. `changes` may include title, description, slug, theme (light/dark/auto), published, showTags, " +
            "footerText, customCSS, showPoweredBy, showCertificateExpiry, autoRefreshInterval, domainNameList, logo (URL or PNG data URL). " +
            "`groups` (optional) REPLACES the monitor groups: [{name, monitor_ids:[...]}].",
        {
            slug: z.string(),
            changes: anyObject.default({}),
            groups: z.array(z.object({ name: z.string(), monitor_ids: z.array(z.number().int()) })).optional(),
        },
        async ({ slug, changes, groups }) => {
            const config = (await kuma.call("getStatusPage", slug)).config;
            const merged = { ...config, ...changes };
            merged.logo = changes.logo ?? config.icon ?? "/icon.svg";
            let publicGroupList;
            if (groups) {
                publicGroupList = groups.map((g) => ({ name: g.name, monitorList: g.monitor_ids.map((id) => ({ id })) }));
            } else {
                const pub = await kuma.httpGet(`/api/status-page/${encodeURIComponent(slug)}`);
                publicGroupList = (pub.publicGroupList ?? []).map((g) => ({
                    id: g.id,
                    name: g.name,
                    monitorList: (g.monitorList ?? []).map((m) => ({ id: m.id, sendUrl: m.sendUrl, url: m.url })),
                }));
            }
            return kuma.call("saveStatusPage", slug, merged, merged.logo, publicGroupList);
        }
    );

    tool("delete_status_page", "Delete a status page.", { slug: z.string() }, async ({ slug }) => kuma.call("deleteStatusPage", slug), {
        destructive: true,
    });

    tool(
        "post_incident",
        "Post (pin) an incident banner on a status page.",
        {
            slug: z.string(),
            title: z.string(),
            content: z.string().describe("Markdown supported"),
            style: z.enum(["info", "warning", "danger", "primary", "light", "dark"]).default("warning"),
        },
        async ({ slug, title, content, style }) => kuma.call("postIncident", slug, { title, content, style })
    );

    tool("unpin_incident", "Remove the pinned incident from a status page.", { slug: z.string() }, async ({ slug }) => kuma.call("unpinIncident", slug));

    // ------------------------------------------------------------------ maintenance
    tool(
        "list_maintenance",
        "List maintenance windows with status (scheduled/under-maintenance/ended/inactive).",
        {},
        async () => {
            await kuma.ready();
            return Object.values(kuma.cache.maintenanceList ?? {});
        },
        { readOnly: true }
    );

    tool(
        "get_maintenance",
        "One maintenance window with its affected monitors and status pages.",
        { maintenance_id: z.number().int() },
        async ({ maintenance_id }) => ({
            maintenance: (await kuma.call("getMaintenance", maintenance_id)).maintenance,
            monitors: (await kuma.call("getMonitorMaintenance", maintenance_id)).monitors,
            status_pages: (await kuma.call("getMaintenanceStatusPage", maintenance_id)).statusPages,
        }),
        { readOnly: true }
    );

    tool(
        "save_maintenance",
        "Create (omit maintenance_id) or update a maintenance window. Strategies: manual (active until paused), single " +
            '(dateRange ["YYYY-MM-DD HH:mm","YYYY-MM-DD HH:mm"]), recurring-interval (intervalDay + timeRange), recurring-weekday ' +
            "(weekdays 0-6 + timeRange), recurring-day-of-month (daysOfMonth + timeRange), cron (cron + durationMinutes). " +
            "Other fields go in `fields` (dateRange, timeRange [{hours,minutes},{hours,minutes}], weekdays, daysOfMonth, intervalDay, cron, " +
            "durationMinutes, timezoneOption e.g. SAME_AS_SERVER/UTC/Africa/Cairo). monitor_ids / status_page_ids REPLACE the affected lists.",
        {
            maintenance_id: z.number().int().optional(),
            title: z.string().optional(),
            description: z.string().optional(),
            strategy: z.enum(["manual", "single", "recurring-interval", "recurring-weekday", "recurring-day-of-month", "cron"]).optional(),
            fields: anyObject.default({}),
            monitor_ids: z.array(z.number().int()).optional(),
            status_page_ids: z.array(z.number().int()).optional(),
        },
        async ({ maintenance_id, title, description, strategy, fields, monitor_ids, status_page_ids }) => {
            let base;
            if (maintenance_id) {
                base = (await kuma.call("getMaintenance", maintenance_id)).maintenance;
            } else {
                base = {
                    title: "",
                    description: "",
                    strategy: "single",
                    active: 1,
                    cron: "30 3 * * *",
                    durationMinutes: 60,
                    intervalDay: 1,
                    dateRange: [],
                    timeRange: [
                        { hours: 2, minutes: 0 },
                        { hours: 3, minutes: 0 },
                    ],
                    weekdays: [],
                    daysOfMonth: [],
                    timezoneOption: "SAME_AS_SERVER",
                };
            }
            const m = { ...base, ...fields };
            if (title !== undefined) {
                m.title = title;
            }
            if (description !== undefined) {
                m.description = description;
            }
            if (strategy !== undefined) {
                m.strategy = strategy;
            }
            if (!m.title) {
                throw new Error("title is required");
            }
            let id = maintenance_id;
            if (id) {
                await kuma.call("editMaintenance", { ...m, id });
            } else {
                id = (await kuma.call("addMaintenance", m)).maintenanceID;
            }
            if (monitor_ids) {
                await kuma.call("addMonitorMaintenance", id, monitor_ids.map((x) => ({ id: x })));
            }
            if (status_page_ids) {
                await kuma.call("addMaintenanceStatusPage", id, status_page_ids.map((x) => ({ id: x })));
            }
            return { ok: true, maintenance_id: id };
        }
    );

    tool(
        "set_maintenance_state",
        "Pause, resume, or delete a maintenance window.",
        { maintenance_id: z.number().int(), action: z.enum(["pause", "resume", "delete"]) },
        async ({ maintenance_id, action }) =>
            kuma.call({ pause: "pauseMaintenance", resume: "resumeMaintenance", delete: "deleteMaintenance" }[action], maintenance_id)
    );

    // ------------------------------------------------------------------ infra: proxies, docker hosts, remote browsers
    tool(
        "list_infrastructure",
        "List proxies, Docker hosts, remote browsers and the available monitor types.",
        {},
        async () => {
            await kuma.ready();
            return {
                proxies: kuma.cache.proxyList ?? [],
                docker_hosts: kuma.cache.dockerHostList ?? [],
                remote_browsers: kuma.cache.remoteBrowserList ?? [],
                monitor_types: kuma.cache.monitorTypeList ?? null,
            };
        },
        { readOnly: true }
    );

    tool(
        "save_proxy",
        "Create (omit proxy_id) or update a proxy.",
        {
            proxy_id: z.number().int().optional(),
            protocol: z.enum(["http", "https", "socks", "socks5", "socks5h", "socks4"]),
            host: z.string(),
            port: z.number().int(),
            username: z.string().optional(),
            password: z.string().optional(),
            is_default: z.boolean().default(false),
            apply_existing: z.boolean().default(false),
        },
        async (a) =>
            kuma.call(
                "addProxy",
                {
                    protocol: a.protocol,
                    host: a.host,
                    port: a.port,
                    auth: !!a.username,
                    username: a.username ?? "",
                    password: a.password ?? "",
                    active: true,
                    default: a.is_default,
                    applyExisting: a.apply_existing,
                },
                a.proxy_id ?? null
            )
    );

    tool("delete_proxy", "Delete a proxy.", { proxy_id: z.number().int() }, async ({ proxy_id }) => kuma.call("deleteProxy", proxy_id), { destructive: true });

    tool(
        "save_docker_host",
        "Create (omit docker_host_id) or update a Docker host for docker-container monitors.",
        {
            docker_host_id: z.number().int().optional(),
            name: z.string(),
            docker_type: z.enum(["socket", "tcp"]),
            docker_daemon: z.string().describe("e.g. /var/run/docker.sock, //./pipe/docker_engine, or tcp://host:2375"),
        },
        async (a) => kuma.call("addDockerHost", { name: a.name, dockerType: a.docker_type, dockerDaemon: a.docker_daemon }, a.docker_host_id ?? null)
    );

    tool("delete_docker_host", "Delete a Docker host.", { docker_host_id: z.number().int() }, async ({ docker_host_id }) =>
        kuma.call("deleteDockerHost", docker_host_id), { destructive: true }
    );

    // ------------------------------------------------------------------ API keys
    tool(
        "list_api_keys",
        "List Uptime Kuma API keys (used for /metrics).",
        {},
        async () => {
            await kuma.ready();
            return kuma.cache.apiKeyList ?? [];
        },
        { readOnly: true }
    );

    tool(
        "create_api_key",
        "Create an API key (for the Prometheus /metrics endpoint). The clear key is only shown once.",
        { name: z.string(), expires: z.string().optional().describe("YYYY-MM-DD HH:mm:ss; omit for never") },
        async ({ name, expires }) => {
            const res = await kuma.call("addAPIKey", { name, expires: expires ?? null, active: 1 });
            return { key_id: res.keyID, key: res.key };
        }
    );

    tool(
        "set_api_key_state",
        "Enable, disable, or delete an API key.",
        { key_id: z.number().int(), action: z.enum(["enable", "disable", "delete"]) },
        async ({ key_id, action }) => kuma.call({ enable: "enableAPIKey", disable: "disableAPIKey", delete: "deleteAPIKey" }[action], key_id)
    );

    // ------------------------------------------------------------------ settings & system
    tool("get_settings", "Server settings (primary base URL, timezone, retention, TLS expiry days, search engine visibility, ...).", {}, async () =>
        (await kuma.call("getSettings")).data, { readOnly: true }
    );

    tool(
        "update_settings",
        "Change server settings. Pass only the keys to change, e.g. {primaryBaseURL, serverTimezone, keepDataPeriodDays, " +
            "tlsExpiryNotifyDays, searchEngineIndex, entryPage, trustProxy, chromeExecutable}.",
        { changes: anyObject },
        async ({ changes }) => {
            const current = (await kuma.call("getSettings")).data;
            return kuma.call("setSettings", { ...current, ...changes }, kuma.password);
        }
    );

    tool(
        "get_database_info",
        "SQLite database size.",
        {},
        async () => kuma.call("getDatabaseSize"),
        { readOnly: true }
    );

    tool("shrink_database", "Run VACUUM to shrink the SQLite database.", {}, async () => kuma.call("shrinkDatabase"));

    // ------------------------------------------------------------------ escape hatch
    tool(
        "raw_socket_call",
        "Advanced: call ANY Uptime Kuma socket.io event directly (the same API the web UI uses) and return its callback result. " +
            "Use for anything not covered by the other tools, e.g. event='getMonitorList', 'getGameList', 'checkApprise', " +
            "'addRemoteBrowser', 'editIncident', 'getIncidentHistory', 'twoFAStatus'. `args` are positional arguments BEFORE the callback.",
        { event: z.string(), args: z.array(z.any()).default([]), no_callback: z.boolean().default(false) },
        async ({ event, args, no_callback }) => {
            if (no_callback) {
                await kuma.emitNoAck(event, ...args);
                return { ok: true, note: "Emitted without waiting for a reply" };
            }
            return kuma.call(event, ...args);
        },
        { destructive: true }
    );
}
