# install-task.ps1 — Register Vistage scraper as a Windows Scheduled Task
# Run this ONCE as Administrator:
#   Right-click PowerShell → "Run as Administrator"
#   cd "C:\Users\John Perez\.claude\scheduled-tasks\vistage-prospecting"
#   .\install-task.ps1

$TaskName   = "VistageProspectingScraper"
$ScriptDir  = "C:\Users\John Perez\.claude\scheduled-tasks\vistage-prospecting"
$RunScript  = "$ScriptDir\run.ps1"
$Username   = $env:USERNAME   # runs as your account (has node, file access)

# Remove old task if it exists
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

# Trigger: every 30 minutes, starting now
$trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 30) -Once -At (Get-Date)

# Action: powershell -NonInteractive -WindowStyle Hidden -File run.ps1
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RunScript`"" `
    -WorkingDirectory $ScriptDir

# Settings: run whether logged on or not, do NOT start a new instance if already running
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 22) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -WakeToRun:$false `
    -RunOnlyIfNetworkAvailable:$true

# Register — prompts for your Windows password so it can run when screen is locked
Register-ScheduledTask `
    -TaskName   $TaskName `
    -Trigger    $trigger `
    -Action     $action `
    -Settings   $settings `
    -RunLevel   Limited `
    -Force

Write-Host ""
Write-Host "✅ Task '$TaskName' registered." -ForegroundColor Green
Write-Host "   Runs every 30 min, 2AM-11PM ET, even when screen is locked."
Write-Host "   Logs: $ScriptDir\run.log"
Write-Host ""
Write-Host "Useful commands:"
Write-Host "  View task    : Get-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Run now      : Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  View log     : Get-Content '$ScriptDir\run.log' -Tail 50"
Write-Host "  Remove task  : Unregister-ScheduledTask -TaskName '$TaskName'"
