// One-time: create the first Uptime Kuma admin user from .env credentials.
// Run with: node --env-file=.env scripts/setup-admin.js
import { createAdminIfNeeded } from "../src/bootstrap.js";

const { KUMA_URL, KUMA_USERNAME, KUMA_PASSWORD } = process.env;
try {
    const created = await createAdminIfNeeded(KUMA_URL, KUMA_USERNAME, KUMA_PASSWORD);
    console.log(created ? `Created admin user "${KUMA_USERNAME}".` : "Admin user already exists; nothing to do.");
    process.exit(0);
} catch (e) {
    console.error(e.message);
    process.exit(1);
}
