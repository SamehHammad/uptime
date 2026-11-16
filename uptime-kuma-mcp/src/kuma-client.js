// Persistent, authenticated socket.io connection to Uptime Kuma.
// Uptime Kuma's web UI talks to the server almost entirely over socket.io, so this
// client speaks the same protocol: it logs in, caches the lists the server pushes
// after login (monitors, notifications, status pages, ...) and exposes `call()` for
// request/ack style events.
import { io } from "socket.io-client";

const LIST_EVENTS = [
    "monitorList",
    "notificationList",
    "proxyList",
    "dockerHostList",
    "apiKeyList",
    "remoteBrowserList",
    "maintenanceList",
    "statusPageList",
    "monitorTypeList",
    "info",
];

export class KumaClient {
    constructor({ url, username, password, timeoutMs = 30000 }) {
        this.url = url.replace(/\/+$/, "");
        this.username = username;
        this.password = password;
        this.timeoutMs = timeoutMs;
        this.token = null;
        this.loggedIn = false;
        this.cache = {
            monitorList: {},
            heartbeat: {}, // monitorID -> latest heartbeat
            uptime: {}, // monitorID -> { "24": x, "720": y, "1y": z }
            avgPing: {}, // monitorID -> ms
            certInfo: {}, // monitorID -> tls info
        };
        this._readyPromise = null;
        this._connect();
    }

    _connect() {
        this.socket = io(this.url, {
            transports: ["websocket"],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 10000,
        });

        for (const ev of LIST_EVENTS) {
            this.socket.on(ev, (data) => {
                this.cache[ev] = data;
            });
        }
        this.socket.on("updateMonitorIntoList", (partial) => {
            Object.assign(this.cache.monitorList, partial);
        });
        this.socket.on("deleteMonitorFromList", (monitorID) => {
            delete this.cache.monitorList[monitorID];
        });
        this.socket.on("heartbeat", (beat) => {
            this.cache.heartbeat[beat.monitor_id ?? beat.monitorID] = beat;
        });
        this.socket.on("heartbeatList", (monitorID, list) => {
            if (Array.isArray(list) && list.length) {
                this.cache.heartbeat[monitorID] = list[list.length - 1];
            }
        });
        this.socket.on("uptime", (monitorID, period, value) => {
            (this.cache.uptime[monitorID] ??= {})[String(period)] = value;
        });
        this.socket.on("avgPing", (monitorID, value) => {
            this.cache.avgPing[monitorID] = value;
        });
        this.socket.on("certInfo", (monitorID, info) => {
            try {
                this.cache.certInfo[monitorID] = typeof info === "string" ? JSON.parse(info) : info;
            } catch {
                this.cache.certInfo[monitorID] = info;
            }
        });

        // Uptime Kuma registers its socket handlers only after it has sent the "info"
        // event to a new connection (server.js: `await sendInfo(socket)`); anything emitted
        // before that is silently dropped. So log in on "info", not on "connect".
        this.socket.on("connect", () => {
            this.loggedIn = false;
            this._gotInfo = false;
        });
        this.socket.on("info", () => {
            if (this._gotInfo) {
                return;
            }
            this._gotInfo = true;
            this._startLogin();
        });
        this.socket.on("disconnect", (reason) => {
            this.loggedIn = false;
            console.error("[kuma] disconnected:", reason);
        });
        this.socket.on("connect_error", (e) => {
            console.error("[kuma] connect error:", e.message);
        });
    }

    _rawEmit(event, ...args) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`Timed out waiting for Uptime Kuma to answer "${event}"`)),
                this.timeoutMs
            );
            this.socket.emit(event, ...args, (res) => {
                clearTimeout(timer);
                resolve(res);
            });
        });
    }

    async _login() {
        let res = null;
        if (this.token) {
            res = await this._rawEmit("loginByToken", this.token);
        }
        if (!res?.ok) {
            res = await this._rawEmit("login", {
                username: this.username,
                password: this.password,
                token: "",
            });
        }
        if (!res?.ok) {
            throw new Error(`Uptime Kuma login failed: ${res?.msg ?? "unknown error"}`);
        }
        this.token = res.token ?? this.token;
        this.loggedIn = true;
        // Make sure the monitor list cache is populated before the first tool call.
        await this._rawEmit("getMonitorList");
    }

    _startLogin() {
        this._readyPromise = this._login();
        this._readyPromise.catch((e) => {
            console.error("[kuma] login failed:", e.message);
            this._readyPromise = null;
        });
        return this._readyPromise;
    }

    /** Resolve once connected and logged in (waits for reconnects, retries a failed login). */
    async ready() {
        const deadline = Date.now() + this.timeoutMs;
        let lastError;
        while (Date.now() < deadline) {
            if (this.loggedIn) {
                return;
            }
            if (!this._readyPromise && this.socket.connected && this._gotInfo) {
                this._startLogin();
            }
            if (this._readyPromise) {
                try {
                    await this._readyPromise;
                } catch (e) {
                    lastError = e;
                    if (/login failed/i.test(e.message)) {
                        throw e; // wrong credentials: retrying will not help
                    }
                }
                continue;
            }
            await new Promise((r) => setTimeout(r, 200));
        }
        throw new Error(`Could not connect to Uptime Kuma at ${this.url}${lastError ? `: ${lastError.message}` : ""}`);
    }

    /**
     * Emit an event that answers through a callback, and throw on `{ ok: false }`.
     * @returns {Promise<any>} the server's callback payload
     */
    async call(event, ...args) {
        await this.ready();
        const res = await this._rawEmit(event, ...args);
        if (res && typeof res === "object" && res.ok === false) {
            throw new Error(res.msg || `Uptime Kuma rejected "${event}"`);
        }
        return res;
    }

    /** Fire-and-forget emit for events that take no callback. */
    async emitNoAck(event, ...args) {
        await this.ready();
        this.socket.emit(event, ...args);
    }

    /** Wait briefly for a pushed list event after an action that triggers it. */
    waitForEvent(event, ms = 3000) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.socket.off(event, handler);
                resolve(undefined);
            }, ms);
            const handler = (data) => {
                clearTimeout(timer);
                resolve(data);
            };
            this.socket.once(event, handler);
        });
    }

    /**
     * Some lists (e.g. statusPageList) are only pushed by the server right after a login.
     * A short-lived second socket logging in with our token makes the server re-broadcast
     * them to every socket of this user, which refreshes this client's cache too.
     */
    async refreshLoginLists(waitEvent = "statusPageList") {
        await this.ready();
        const s = io(this.url, { transports: ["websocket"], reconnection: false });
        try {
            const got = new Promise((resolve) => this.socket.once(waitEvent, resolve));
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("refresh timed out")), this.timeoutMs);
                s.once("info", () =>
                    s.emit("loginByToken", this.token, (res) => {
                        clearTimeout(timer);
                        res?.ok ? resolve() : reject(new Error(res?.msg ?? "loginByToken failed"));
                    })
                );
                s.on("connect_error", (e) => {
                    clearTimeout(timer);
                    reject(e);
                });
            });
            await Promise.race([got, new Promise((r) => setTimeout(r, this.timeoutMs))]);
        } finally {
            s.close();
        }
    }

    /** GET a public (unauthenticated) HTTP endpoint on the Kuma server. */
    async httpGet(path) {
        const res = await fetch(this.url + path);
        const text = await res.text();
        let body;
        try {
            body = JSON.parse(text);
        } catch {
            body = text;
        }
        if (!res.ok) {
            throw new Error(`GET ${path} -> HTTP ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
        }
        return body;
    }
}
