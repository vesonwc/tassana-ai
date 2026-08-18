# Tassana AI — update the on-site bridge PC to the latest code and restart the listener.
# Run in PowerShell on the bridge PC:
#   irm https://raw.githubusercontent.com/vesonwc/tassana-ai/master/worker/agent/update-office-pc.ps1 | iex
# Safe to run any time: pulls code, installs deps, restarts the hidden listener (autostart task stays).

$ErrorActionPreference = "Stop"
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force } catch {}
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
$Dir = "C:\Tassana ai"
function Say($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }

if (-not (Test-Path "$Dir\.git")) { Write-Host "ไม่พบโค้ดที่ $Dir — รัน setup-office-pc.ps1 ก่อน" -ForegroundColor Yellow; return }
Set-Location $Dir

Say "1/3 ดึงโค้ดล่าสุด"
git pull --quiet
git log -1 --format="   ตอนนี้อยู่ที่: %h %s"

Say "2/3 อัปเดตไลบรารี"
& npm.cmd install --no-audit --no-fund --silent
if ($LASTEXITCODE -ne 0) { throw "npm install ล้มเหลว (exit $LASTEXITCODE)" }

Say "3/3 รีสตาร์ท listener"
# The wrapper .cmd loop restarts node within 15s, so killing node is enough.
# If the task is not running at all (e.g. after a reboot without logon), start it.
$nodes = Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -like "*nvr-listener*" -or $_.CommandLine -like "*agent:nvr*" }
if ($nodes) {
  $nodes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host "   ปิดตัวเก่าแล้ว — ตัวใหม่จะเปิดเองใน 15 วิ"
} else {
  Start-ScheduledTask -TaskName "TassanaNvrListener"
  Write-Host "   listener ไม่ได้รันอยู่ — สั่งเปิดแล้ว"
}
Start-Sleep -Seconds 25
Write-Host ""
Write-Host "🎉 อัปเดตเสร็จ — log 6 บรรทัดล่าสุด:" -ForegroundColor Green
Get-Content "$Dir\logs\nvr-listener.log" -Tail 6 -Encoding UTF8 -ErrorAction SilentlyContinue
