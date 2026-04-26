# Vistage Prospecting — n8n Import & Production Hand-off

**Repository:** https://github.com/crmexpertsnyc/vistage-prospecting
**n8n Instance:** https://n8n.crmexpertsonline.com
**Owner:** John Perez — jperez@service-push.com
**Google Sheet (output):** https://docs.google.com/spreadsheets/d/1GuQN_MF7HnV96Sml7l7s8V_inVefTUMSYf3hif4inqs/edit

---

## TL;DR — Two Deployment Paths

| Path | What you get | When to use |
|------|--------------|-------------|
| **A. n8n workflow** (this doc) | Visual workflow with HTTP-based login | Quick prototype/visualisation; will likely fail Vistage bot detection |
| **B. Proxmox + Playwright** (`HANDOFF.md`) | Headless Playwright scraper that's already collected 838+ prospects | **Production — recommended** |

**John's strong recommendation:** deploy **Path B** for production. Use Path A only if you specifically want the workflow visible in n8n. Vistage's bot detection blocks plain HTTP requests, which is exactly what Path A uses. The scraper.js in this repo uses `playwright-extra` + `puppeteer-extra-plugin-stealth` precisely because plain requests don't work.

---

## Path A — Import the n8n Workflow

### Step 1 — Sign in to n8n
Go to https://n8n.crmexpertsonline.com and sign in with John's credentials.

### Step 2 — Import the workflow JSON

> **Note:** The n8n public API (`POST /api/v1/workflows`) currently hangs server-side, even for tiny payloads. Use the UI import below — do not waste time scripting against the API until that endpoint is fixed at the server level.

1. Top-left → **Workflows**
2. Click **+ Add workflow** → in the dropdown, choose **Import from File**
3. Select: `vistage-prospecting-n8n-workflow.json` (in this repo's root)
4. The workflow appears as **inactive** with the name **Vistage Community Prospecting — Hourly**
5. Do NOT activate yet — credentials need wiring first

### Step 3 — Wire credentials & environment variables

The workflow expects:

#### Credential: Google Sheets OAuth2
- **Type:** Google Sheets OAuth2 API
- **Name:** Google Sheets Account *(must match exactly — workflow node references this name)*

Setup:
1. Go to [console.cloud.google.com](https://console.cloud.google.com) → project `vistagescrape` (or create new)
2. Enable **Google Sheets API**
3. Credentials → Create Credentials → OAuth 2.0 Client ID → Web application
4. Authorized redirect URI: `https://n8n.crmexpertsonline.com/rest/oauth2-credential/callback`
5. Copy Client ID + Secret into n8n's credential form
6. Click "Connect my account" → sign in with the Google account that owns the Sheet

After creating, replace `REPLACE_WITH_YOUR_CREDENTIAL_ID` in the **Append to Google Sheet** node.

#### Environment variables (n8n → Settings → Environment Variables)

| Variable | Value | Notes |
|----------|-------|-------|
| `VISTAGE_EMAIL` | `jperez@crmexpertsny.com` | Vistage login |
| `VISTAGE_PASSWORD` | *(ask John)* | Vistage password |
| `VISTAGE_SHEET_ID` | `1GuQN_MF7HnV96Sml7l7s8V_inVefTUMSYf3hif4inqs` | Google Sheet ID |
| `ANTHROPIC_API_KEY` | *(ask John — stored at console.anthropic.com)* | For Claude scoring |

### Step 4 — Test
1. Click **Test workflow** (manual single run)
2. Check the **Time Window Check** node — should pass during 9 AM–8 PM ET
3. Check the **POST Login** node — verify `loggedIn: true` in response
4. **If `loggedIn: false`** → Vistage's bot detection blocked the HTTP login. **Fall back to Path B below.**

### Step 5 — Activate
Toggle **Active** in the top-right.

Schedule: every hour (the **Time Window Check** node self-gates to 9 AM–8 PM ET).

---

## Path B — Proxmox Deployment (Recommended for Production)

The scraper that's already collected 838+ prospects uses Playwright + stealth in headless Chromium. This bypasses Vistage's bot detection.

**Full instructions:** `HANDOFF.md` in this repo.

Quick summary:
1. Spin up Ubuntu 22.04 / Debian 12 VM on Proxmox (2 vCPU, 2 GB RAM, 10 GB disk)
2. `apt install nodejs` (Node.js 20 LTS) + Playwright system deps
3. `git clone https://github.com/crmexpertsnyc/vistage-prospecting.git`
4. `npm install && npx playwright install chromium`
5. Copy secrets from John: `.env`, `credentials.json`, `alert-config.json`
6. Run `node auth.js` once to generate `token.json` (Google OAuth2)
7. `bash cron-setup.sh` to install the cron job (every 30 min, 2 AM–11 PM ET)

Verify with: `tail -f run.log` and `crontab -l`.

---

## Why Path B beats Path A

| Capability | n8n HTTP workflow | Playwright scraper |
|------------|-------------------|--------------------|
| Bypasses Vistage bot detection | ❌ | ✅ |
| Renders JavaScript-heavy pages | ❌ | ✅ |
| Uses stealth plugins | ❌ | ✅ |
| Persists browser session | ❌ (per-run cookie scrape) | ✅ (`browser-state.json`) |
| Already proven (838+ prospects) | ❌ | ✅ |
| Visual editing | ✅ | ❌ |

---

## Files in This Repo

| File | Purpose |
|------|---------|
| `vistage-prospecting-n8n-workflow.json` | n8n workflow — import via UI (Path A) |
| `scraper.js` | Production Playwright scraper (Path B) |
| `auth.js` | One-time Google OAuth2 setup |
| `email-alert.js` | Keyword alert sender |
| `package.json` | Node dependencies |
| `.env.example` | Template for `.env` |
| `alert-config.example.json` | Template for SMTP config |
| `run.sh` / `cron-setup.sh` | Linux cron deployment |
| `run.ps1` / `install-task.ps1` | Windows Task Scheduler (legacy reference) |
| `HANDOFF.md` | Full Proxmox deployment guide (Path B) |
| `N8N_IMPORT_HANDOFF.md` | This file (Path A) |

**Files NOT in repo (gitignored secrets — get from John):**
`.env`, `credentials.json`, `token.json`, `alert-config.json`, `state.json`, `browser-state.json`

---

## Operations

### Logs (Path B)
```bash
tail -f /opt/vistage-prospecting/run.log
journalctl -u cron -f                          # cron-level logs
```

### State / dedup (Path B)
- `state.json` — tracks 838+ discovered prospects, do NOT delete
- `browser-state.json` — Vistage session cookies

### Manual run (Path B)
```bash
cd /opt/vistage-prospecting && node scraper.js
```

### Update code
```bash
cd /opt/vistage-prospecting
git pull origin main
npm install                                    # if package.json changed
# cron picks up changes on next run
```

### Stop temporarily (Path B)
```bash
crontab -l | grep -vF 'run.sh' | crontab -
```

---

## Support

**John Perez** — jperez@service-push.com

For questions about scoring rules, Google Sheet schema, or business logic, contact John.
