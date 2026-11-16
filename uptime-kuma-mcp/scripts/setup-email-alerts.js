// Create/update the Arabic email alert notification in Uptime Kuma from .env.
// Run:  node --env-file=.env scripts/setup-email-alerts.js [--test]
//       docker compose exec mcp node scripts/setup-email-alerts.js --test
import { KumaClient } from "../src/kuma-client.js";
import { NOTIFICATION_NAME, configureEmailAlerts } from "../src/email-alerts.js";

const env = process.env;
const kuma = new KumaClient({ url: env.KUMA_URL, username: env.KUMA_USERNAME, password: env.KUMA_PASSWORD });
try {
    const { id, created, test } = await configureEmailAlerts(kuma, env, { sendTest: process.argv.includes("--test") });
    console.log(`${created ? "Created" : "Updated"} notification #${id} "${NOTIFICATION_NAME}"`);
    await kuma.call("getMonitorList");
    for (const m of Object.values(kuma.cache.monitorList)) {
        console.log(`  monitor #${m.id} ${m.name} (${m.url || m.hostname}) -> attached: ${!!m.notificationIDList?.[id]}`);
    }
    if (test) {
        console.log("Test email:", test);
    }
    process.exit(0);
} catch (e) {
    console.error("Failed:", e.message);
    process.exit(1);
}
