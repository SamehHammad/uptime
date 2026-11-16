// Uptime Kuma's built-in Email (SMTP) notification with Arabic UP/DOWN templates.
// Attached to every existing monitor and made the default for new ones.
// SMTP settings come only from the environment.

export const NOTIFICATION_NAME = "تنبيهات الإيميل (UP/DOWN)";

// Kuma only notifies when a monitor changes state (UP <-> DOWN), so there are no
// duplicate emails for the same status. heartbeatJSON is null for the "Test" button.
const SUBJECT =
    "{% if heartbeatJSON == null %}🧪 اختبار تنبيهات Uptime Kuma" +
    "{% elsif heartbeatJSON.status == 0 %}🔴 الموقع متوقف: {{ name }}" +
    "{% else %}🟢 الموقع عاد للعمل: {{ name }}{% endif %}";

const BODY = `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:15px">
{% if heartbeatJSON == null %}
<h2>🧪 رسالة اختبار</h2>
<p>إعدادات الإيميل في Uptime Kuma تعمل بشكل صحيح.</p>
{% else %}
{% if heartbeatJSON.status == 0 %}<h2 style="color:#b91c1c">🔴 الموقع متوقف: {{ name | escape }}</h2>
{% else %}<h2 style="color:#15803d">🟢 الموقع عاد للعمل: {{ name | escape }}</h2>{% endif %}
<table cellpadding="6" style="border-collapse:collapse">
<tr><th align="right">الموقع</th><td>{{ name | escape }}</td></tr>
<tr><th align="right">الرابط</th><td><a href="{{ hostnameOrURL | escape }}">{{ hostnameOrURL | escape }}</a></td></tr>
<tr><th align="right">الحالة</th><td>{% if heartbeatJSON.status == 0 %}متوقف (DOWN){% else %}يعمل (UP){% endif %}</td></tr>
<tr><th align="right">الرسالة</th><td>{{ heartbeatJSON.msg | escape }}</td></tr>
<tr><th align="right">الوقت ({{ heartbeatJSON.timezone }})</th><td>{{ heartbeatJSON.localDateTime }}</td></tr>
</table>
{% endif %}
</div>`;

export const isEmailConfigured = (env) => ["SMTP_HOST", "SMTP_PORT", "ALERT_FROM", "ALERT_TO"].every((k) => env[k]?.trim());

export function buildEmailNotification(env) {
    const missing = ["SMTP_HOST", "SMTP_PORT", "ALERT_FROM", "ALERT_TO"].filter((k) => !env[k]?.trim());
    if (missing.length) {
        throw new Error(`Missing in .env: ${missing.join(", ")}`);
    }
    const port = Number(env.SMTP_PORT);
    return {
        name: NOTIFICATION_NAME,
        type: "smtp",
        smtpHost: env.SMTP_HOST.trim(),
        smtpPort: port,
        // true = implicit TLS (port 465); false = STARTTLS (port 587)
        smtpSecure: env.SMTP_SECURE ? env.SMTP_SECURE.trim().toLowerCase() === "true" : port === 465,
        smtpIgnoreTLSError: false,
        smtpUsername: env.SMTP_USER?.trim() || "",
        smtpPassword: env.SMTP_PASS || "",
        smtpFrom: env.ALERT_FROM.trim(),
        smtpTo: env.ALERT_TO.trim(),
        customSubject: SUBJECT,
        customBody: BODY,
        htmlBody: true,
        isDefault: true, // new monitors get it automatically
        applyExisting: true, // attach to every monitor already on the dashboard
    };
}

/** Create or update (by name) the email notification. Returns { id, created }. */
export async function configureEmailAlerts(kuma, env, { sendTest = false } = {}) {
    const config = buildEmailNotification(env);
    await kuma.ready();
    const existing = (kuma.cache.notificationList ?? []).find((n) => n.name === NOTIFICATION_NAME);
    const res = await kuma.call("addNotification", config, existing?.id ?? null);
    let test;
    if (sendTest) {
        test = (await kuma.call("testNotification", config)).msg;
    }
    return { id: res.id, created: !existing, test };
}
