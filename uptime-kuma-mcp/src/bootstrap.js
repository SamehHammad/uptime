// First-run setup for a fresh Uptime Kuma: pick SQLite (if Kuma still shows the
// database setup page) and create the admin user from env. Safe to run on every start.
import { io } from "socket.io-client";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function entryPage(url) {
    try {
        const res = await fetch(`${url}/api/entry-page`, { signal: AbortSignal.timeout(3000) });
        return res.ok ? (await res.json()).type ?? "unknown" : null;
    } catch {
        return null;
    }
}

/** Wait until Kuma answers HTTP; returns the entry page type. */
async function waitForKuma(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const type = await entryPage(url);
        if (type) {
            return type;
        }
        await sleep(2000);
    }
    throw new Error(`Uptime Kuma did not answer at ${url} within ${timeoutMs / 1000}s`);
}

async function chooseSqliteIfNeeded(url, timeoutMs) {
    if ((await waitForKuma(url, timeoutMs)) !== "setup-database") {
        return;
    }
    console.log("[bootstrap] Kuma needs a database: choosing SQLite");
    await fetch(`${url}/setup-database`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dbConfig: { type: "sqlite" } }),
    }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const type = await entryPage(url);
        if (type && type !== "setup-database") {
            return;
        }
        await sleep(2000);
    }
    throw new Error("Kuma did not finish database setup");
}

/** Creates the first admin user if Kuma has none yet. Returns true if it created one. */
export function createAdminIfNeeded(url, username, password, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        const socket = io(url, { transports: ["websocket"], reconnection: false });
        const emit = (ev, ...a) => new Promise((r) => socket.emit(ev, ...a, r));
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error("Timed out creating the Kuma admin user"));
        }, timeoutMs);
        const done = (fn, value) => {
            clearTimeout(timer);
            socket.close();
            fn(value);
        };
        // Kuma registers its handlers only after it sends "info" to a new socket.
        socket.once("info", async () => {
            try {
                if (!(await emit("needSetup"))) {
                    return done(resolve, false);
                }
                const res = await emit("setup", username, password);
                if (!res?.ok) {
                    return done(reject, new Error(`Admin setup failed: ${res?.msg}`));
                }
                done(resolve, true);
            } catch (e) {
                done(reject, e);
            }
        });
        socket.on("connect_error", (e) => done(reject, e));
    });
}

export async function bootstrapKuma({ url, username, password, timeoutMs = 300000 }) {
    await chooseSqliteIfNeeded(url, timeoutMs);
    if (await createAdminIfNeeded(url, username, password)) {
        console.log(`[bootstrap] Created Kuma admin user "${username}"`);
    }
}
