# run.ps1 — Vistage Prospecting Scraper Runner
# Called by Windows Task Scheduler every 30 minutes
# Logs output to run.log (last 1000 lines kept)

$ScriptDir = "C:\Users\John Perez\.claude\scheduled-tasks\vistage-prospecting"
$LogFile   = "$ScriptDir\run.log"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) { $NodeExe = $nodeCmd.Source } else { $NodeExe = "C:\Program Files\nodejs\node.exe" }

# Timestamp helper
function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-ddTHH:mm:ss"
    "$ts  $msg" | Tee-Object -FilePath $LogFile -Append
}

Log "==== RUN START ===="

# Check active hours (2 AM – 11 PM ET)
try {
    $etZone = [System.TimeZoneInfo]::FindSystemTimeZoneById("Eastern Standard Time")
    $etNow  = [System.TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $etZone)
    $hour   = $etNow.Hour
    Log "ET hour: $hour"
    if ($hour -lt 2 -or $hour -ge 23) {
        Log "Outside active window (2AM-11PM ET). Skipping."
        exit 0
    }
} catch {
    Log "Could not determine ET hour: $($_.Exception.Message). Proceeding anyway."
}

# Run scraper
Log "Starting scraper..."
$proc = Start-Process -FilePath $NodeExe `
    -ArgumentList "scraper.js" `
    -WorkingDirectory $ScriptDir `
    -RedirectStandardOutput "$ScriptDir\last_stdout.txt" `
    -RedirectStandardError  "$ScriptDir\last_stderr.txt" `
    -NoNewWindow -Wait -PassThru

$exit = $proc.ExitCode
$stdout = Get-Content "$ScriptDir\last_stdout.txt" -Raw -ErrorAction SilentlyContinue
$stderr = Get-Content "$ScriptDir\last_stderr.txt" -Raw -ErrorAction SilentlyContinue

if ($stdout) { $stdout.TrimEnd() -split "`n" | ForEach-Object { Log $_ } }
if ($stderr) { Log "STDERR: $($stderr.TrimEnd())" }

Log "Scraper exited with code: $exit"
Log "==== RUN END ===="

# Keep log to last 1000 lines
$lines = Get-Content $LogFile -ErrorAction SilentlyContinue
if ($lines.Count -gt 1000) {
    $lines[-1000..-1] | Set-Content $LogFile
}
