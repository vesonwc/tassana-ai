# Registers the NVR listener to start automatically at Windows logon on this PC.
# Run once in PowerShell (as the user who stays logged in):
#   powershell -ExecutionPolicy Bypass -File worker\agent\install-autostart.ps1
# Remove later with:  Unregister-ScheduledTask -TaskName "TassanaNvrListener" -Confirm:$false

$projectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$logDir = Join-Path $projectDir "logs"
New-Item -ItemType Directory -Force $logDir | Out-Null

# Wrapper .cmd keeps a rolling log and restarts the listener if it ever exits.
$wrapper = Join-Path $projectDir "worker\agent\run-nvr-listener.cmd"
@"
@echo off
cd /d "$projectDir"
:loop
echo [%date% %time%] starting listener >> "$logDir\nvr-listener.log"
call "$npm" run agent:nvr >> "$logDir\nvr-listener.log" 2>&1
echo [%date% %time%] listener exited, restarting in 15s >> "$logDir\nvr-listener.log"
timeout /t 15 /nobreak > nul
goto loop
"@ | Set-Content -Path $wrapper -Encoding ASCII

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$wrapper`"" -WorkingDirectory $projectDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName "TassanaNvrListener" -Action $action -Trigger $trigger -Settings $settings -Description "Tassana AI - NVR listener (on-site bridge)" -Force | Out-Null

Write-Host "ติดตั้งแล้ว: listener จะสตาร์ทเองทุกครั้งที่ล็อกอิน Windows"
Write-Host "log อยู่ที่ $logDir\nvr-listener.log"
Write-Host "เริ่มทันทีเลย: Start-ScheduledTask -TaskName TassanaNvrListener"
