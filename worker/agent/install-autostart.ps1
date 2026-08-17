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

# Launch the wrapper through wscript with window style 0 = fully hidden. Otherwise
# Windows 11 opens the cmd loop as a visible Windows Terminal tab that a user can close by accident.
$launcher = Join-Path $projectDir "worker\agent\run-nvr-listener-hidden.vbs"
@"
Set sh = CreateObject("WScript.Shell")
sh.Run """$wrapper""", 0, False
"@ | Set-Content -Path $launcher -Encoding ASCII

# Stop any previous instance (old visible window) before re-registering.
Unregister-ScheduledTask -TaskName "TassanaNvrListener" -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "name='cmd.exe'" | Where-Object { $_.CommandLine -like "*run-nvr-listener.cmd*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -like "*nvr-listener*" -or $_.CommandLine -like "*agent:nvr*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$launcher`"" -WorkingDirectory $projectDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "TassanaNvrListener" -Action $action -Trigger $trigger -Settings $settings -Description "Tassana AI - NVR listener (on-site bridge, hidden window)" -Force | Out-Null

Write-Host "ติดตั้งแล้ว: listener จะสตาร์ทเองทุกครั้งที่ล็อกอิน Windows (ทำงานเบื้องหลัง ไม่มีหน้าต่าง)"
Write-Host "log อยู่ที่ $logDir\nvr-listener.log"
Write-Host "เริ่มทันทีเลย: Start-ScheduledTask -TaskName TassanaNvrListener"
