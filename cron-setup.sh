#!/bin/bash
# cron-setup.sh — Install Vistage scraper as a cron job (Linux / Proxmox)
# Run ONCE after cloning the repo:
#   bash cron-setup.sh

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$DIR/run.sh"
# Every 30 minutes, all hours — active-hours check is inside run.sh
CRON_ENTRY="*/30 * * * * /bin/bash $RUNNER >> $DIR/run.log 2>&1"

echo ""
echo "Installing Vistage Prospecting Scraper cron job..."
echo "Runner : $RUNNER"
echo "Schedule: every 30 minutes (active-hours gate: 2AM–11PM ET)"
echo ""

# ── Check that run.sh exists and is executable ─────────────────────────────────
if [ ! -f "$RUNNER" ]; then
  echo "ERROR: $RUNNER not found. Make sure you're in the repo directory."
  exit 1
fi
chmod +x "$RUNNER"

# ── Check if cron entry already exists ────────────────────────────────────────
if crontab -l 2>/dev/null | grep -qF "$RUNNER"; then
  echo "✅ Cron job already installed:"
  crontab -l | grep -F "$RUNNER"
  exit 0
fi

# ── Add cron entry ─────────────────────────────────────────────────────────────
(crontab -l 2>/dev/null; echo "$CRON_ENTRY") | crontab -

echo "✅ Cron job installed successfully!"
echo ""
echo "Useful commands:"
echo "  View cron job  : crontab -l"
echo "  Tail live log  : tail -f $DIR/run.log"
echo "  Run manually   : bash $RUNNER"
echo "  Remove cron    : crontab -l | grep -vF '$RUNNER' | crontab -"
echo ""
echo "The scraper will next run within the next 30 minutes."
