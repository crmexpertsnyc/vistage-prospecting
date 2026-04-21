---
name: vistage-prospecting
description: Vistage scraper — every other day, 2 logins/day (8am + 2pm), thread/comment activity feeds only, no People Search, stealth Playwright + Sheets API
---

Run the headless Vistage prospecting scraper. This is a fully autonomous Node.js script — no browser extension or clicks needed.

STEP 1 — Check active hours (2AM–11PM ET):
  Run via Bash: powershell -Command "[System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::Now,'Eastern Standard Time').Hour"
  If hour < 2 or hour >= 23: print "Outside active window. Stopping." and EXIT.

STEP 2 — Run the scraper:
  Execute via Bash (timeout: 1260000ms = 21 minutes):
    cd "C:\Users\John Perez\.claude\scheduled-tasks\vistage-prospecting" && node scraper.js

STEP 3 — Report results:
  Print the full stdout output from scraper.js so the run summary is visible.
  If scraper.js exits with a non-zero code, print the stderr output.

ERROR HANDLING:
  - If output contains "token.json not found": notify the user to run: node auth.js
  - If output contains "CAPTCHA": log it and stop — do not retry
  - If output contains "Could not log in": log it and stop
  - If node is not found: try "C:\Program Files\nodejs\node.exe" scraper.js instead