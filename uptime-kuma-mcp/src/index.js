// Uptime Kuma MCP server: Streamable HTTP transport, Bearer-token protected.
import express from "express";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { KumaClient } from "./kuma-client.js";
import { registerTools } from "./tools.js";
import { bootstrapKuma } from "./bootstrap.js";
import { configureEmailAlerts, isEmailConfigured } from "./email-alerts.js";

const { KUMA_URL = "http://localhost:3001", KUMA_USERNAME, KUMA_PASSWORD, MCP_TOKEN, MCP_HOST = "127.0.0.1", MCP_PORT = "3005" } = process.env;

if (!KUMA_USERNAME || !KUMA_PASSWORD || !MCP_TOKEN) {
    console.error("Missing KUMA_USERNAME, KUMA_PASSWORD or MCP_TOKEN (see .env)");
    process.exit(1);
}

// In Docker (AUTO_SETUP=true) a fresh Kuma is set up automatically: SQLite + admin user.
if (process.env.AUTO_SETUP === "true") {
    await bootstrapKuma({ url: KUMA_URL, username: KUMA_USERNAME, password: KUMA_PASSWORD });
}

const kuma = new KumaClient({ url: KUMA_URL, username: KUMA_USERNAME, password: KUMA_PASSWORD });

if (process.env.AUTO_SETUP === "true" && isEmailConfigured(process.env)) {
    configureEmailAlerts(kuma, process.env)
        .then(({ id, created }) => console.log(`[bootstrap] Email alerts notification #${id} ${created ? "created" : "updated"}`))
        .catch((e) => console.error("[bootstrap] Email alerts setup failed:", e.message));
}

const app = express();
app.use(express.json({ limit: "10mb" }));

const expected = Buffer.from(`Bearer ${MCP_TOKEN}`);
function auth(req, res, next) {
    const got = Buffer.from(req.headers.authorization ?? "");
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
        return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    }
    next();
}

app.get("/health", (_req, res) => res.json({ ok: true, kumaConnected: kuma.loggedIn }));

// Stateless mode: a fresh MCP server + transport per request, sharing one Kuma connection.
app.post("/mcp", auth, async (req, res) => {
    const server = new McpServer({ name: "uptime-kuma", version: "1.0.0" });
    registerTools(server, kuma);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
        transport.close();
        server.close();
    });
    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (e) {
        console.error("[mcp] request error:", e);
        if (!res.headersSent) {
            res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
        }
    }
});

const methodNotAllowed = (_req, res) =>
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
app.get("/mcp", auth, methodNotAllowed);
app.delete("/mcp", auth, methodNotAllowed);

app.listen(Number(MCP_PORT), MCP_HOST, () => {
    console.log(`Uptime Kuma MCP listening on http://${MCP_HOST}:${MCP_PORT}/mcp -> ${KUMA_URL}`);
});
