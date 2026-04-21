#!/bin/bash
# run.sh — Vistage Prospecting Scraper Runner (Linux / Proxmox)
# Invoked by cron every 30 minutes.
# Logs output to run.log (keeps last 1000 lines).

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$DIR/run.log"
MAX_LOG_LINES=1000

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)  $1" | tee -a "$LOG"
}

log "==== RUN START ===="

# ── Active hours check (2 AM – 11 PM ET) ──────────────────────────────────────
ET_HOUR=$(TZ="America/New_York" date +%-H 2>/dev/null || date +%k | tr -d ' ')
if [ -n "$ET_HOUR" ] && { [ "$ET_HOUR" -lt 2 ] || [ "$ET_HOUR" -ge 23 ]; }; then
  log "Outside active window (2AM-11PM ET, current ET hour: $ET_HOUR). Skipping."
  log "==== RUN END ===="
  exit 0
fi

log "ET hour: $ET_HOUR"

# ── Load .env if present ───────────────────────────────────────────────────────
if [ -f "$DIR/.env" ]; then
  set -o allexport
  # shellcheck disable=SC1091
  source "$DIR/.env"
  set +o allexport
fi

# ── Validate required env vars ─────────────────────────────────────────────────
if [ -z "$VISTAGE_EMAIL" ] || [ -z "$VISTAGE_PASSWORD" ]; then
  log "ERROR: VISTAGE_EMAIL or VISTAGE_PASSWORD not set. Create a .env file. See .env.example."
  log "==== RUN END ===="
  exit 1
fi

# ── Run scraper ────────────────────────────────────────────────────────────────
log "Starting scraper..."
cd "$DIR" || exit 1

node scraper.js >> "$LOG" 2>&1
EXIT_CODE=$?

log "Scraper exited with code: $EXIT_CODE"
log "==== RUN END ===="

# ── Rotate log (keep last 1000 lines) ─────────────────────────────────────────
LINES=$(wc -l < "$LOG" 2>/dev/null || echo 0)
if [ "$LINES" -gt "$MAX_LOG_LINES" ]; then
  tail -n "$MAX_LOG_LINES" "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

exit $EXIT_CODE
