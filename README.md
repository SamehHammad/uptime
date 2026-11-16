# Uptime Kuma + MCP

مراقبة المواقع بـ [Uptime Kuma](https://github.com/louislam/uptime-kuma) مع سيرفر MCP يدي Claude تحكم كامل وقراءة كاملة، وتنبيهات إيميل بالعربي لما أي موقع يقع أو يرجع.

## التثبيت على أي VPS (Ubuntu/Debian)

```bash
git clone https://github.com/SamehHammad/uptime.git
cd uptime
cp .env.example .env
nano .env          # اختياري: DOMAIN و SMTP_*  (الباسورد والتوكن بيتعملوا لوحدهم)
sudo ./install.sh
```

السكريبت بيثبّت Docker لو مش موجود، ويولّد الباسورد والتوكن، ويشغّل كل حاجة، ويطبع في الآخر:
رابط اللوحة، بيانات الدخول، رابط الـ MCP، والتوكن، والأمر اللي تربط بيه Claude.

| مع `DOMAIN` (موصى به) | من غير `DOMAIN` |
|---|---|
| `https://DOMAIN` للوحة | `http://IP:3001` للوحة |
| `https://DOMAIN/mcp` للـ MCP | `http://IP:3005/mcp` للـ MCP |
| شهادة HTTPS تلقائية (Caddy). لازم الـ DNS يشاور على السيرفر، والبورتات 80 و 443 مفتوحة | افتح البورتات 3001 و 3005 |

## ربط Claude

**Claude Code:**
```bash
claude mcp add --transport http --scope user uptime-kuma https://DOMAIN/mcp --header "Authorization: Bearer MCP_TOKEN"
```

**Claude Desktop** (`claude_desktop_config.json` جوه `mcpServers`):
```json
"uptime-kuma": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://DOMAIN/mcp", "--header", "Authorization:${AUTH_HEADER}"],
  "env": { "AUTH_HEADER": "Bearer MCP_TOKEN" }
}
```
من غير دومين استخدم `http://IP:3005/mcp` وضيف `"--allow-http"`.

## تنبيهات الإيميل

املا `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `ALERT_FROM`, `ALERT_TO` في `.env`، وبعدين:
```bash
sudo ./install.sh                                                # بيطبّق الإعدادات
docker compose exec mcp node scripts/setup-email-alerts.js --test  # إيميل تجربة
```
- العنوان: «🔴 الموقع متوقف: …» أو «🟢 الموقع عاد للعمل: …»، وفيه الرابط والحالة والرسالة والوقت بتوقيت `TZ`.
- بيتربط بكل المواقع، وبأي موقع جديد يتضاف.
- Uptime Kuma بيبعت لما الحالة تتغيّر بس، فمفيش إيميل مكرر لنفس الحالة.

## أوامر مفيدة

```bash
docker compose ps                         # الحالة
docker compose logs -f mcp uptime-kuma    # الـ logs
git pull && sudo ./install.sh             # تحديث
docker compose down                       # إيقاف (البيانات بتفضل في ./data)
tar czf backup.tgz data .env              # نسخة احتياطية
```

## المكونات

| | |
|---|---|
| `docker-compose.yml` | Uptime Kuma 2.5.11 (الصورة الرسمية) + MCP + Caddy (اختياري للـ HTTPS) |
| `install.sh` | تثبيت وتحديث بأمر واحد |
| `uptime-kuma-mcp/` | سيرفر الـ MCP (47 أداة)، تفاصيله في [README](uptime-kuma-mcp/README.md) |
| `start-all.ps1` / `stop-all.ps1` | تشغيل محلي على Windows (من غير Docker) |

البيانات كلها في `./data`، والأسرار في `.env`، والاتنين مش بيترفعوا على git.
