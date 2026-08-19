# Tassana AI — turn on the on-site object detector (ADR-017) on the bridge PC.
# Run in PowerShell on the bridge PC:
#   irm https://raw.githubusercontent.com/vesonwc/tassana-ai/master/worker/agent/enable-yolo-office-pc.ps1 | iex
#
# What it does: backs up .env, adds NVR_YOLO=1 if missing, pulls the latest
# code, installs dependencies, restarts the hidden listener, then shows whether
# the detector actually came up. Safe to run more than once.

$ErrorActionPreference = "Stop"
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force } catch {}
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
$Dir = "C:\Tassana ai"
$EnvFile = Join-Path $Dir ".env"
function Say($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }

if (-not (Test-Path "$Dir\.git")) {
  Write-Host "ไม่พบโค้ดที่ $Dir — รัน setup-office-pc.ps1 ก่อน" -ForegroundColor Yellow
  return
}
Set-Location $Dir

Say "1/5 สำรองไฟล์ .env"
if (-not (Test-Path $EnvFile)) {
  Write-Host "   ไม่พบ .env ที่ $EnvFile — หยุดก่อน ไม่แตะอะไรทั้งนั้น" -ForegroundColor Yellow
  return
}
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item $EnvFile "$EnvFile.bak-$stamp"
Write-Host "   สำรองไว้ที่ .env.bak-$stamp"

Say "2/5 เปิดใช้ตัวตรวจจับใน .env"
$lines = Get-Content $EnvFile -Encoding UTF8
if ($lines -match '^\s*NVR_YOLO\s*=\s*1\s*$') {
  Write-Host "   NVR_YOLO=1 มีอยู่แล้ว ไม่ต้องแก้"
} elseif ($lines -match '^\s*NVR_YOLO\s*=') {
  $lines = $lines -replace '^\s*NVR_YOLO\s*=.*$', 'NVR_YOLO=1'
  Set-Content $EnvFile $lines -Encoding UTF8
  Write-Host "   แก้ค่าเดิมเป็น NVR_YOLO=1"
} else {
  Add-Content $EnvFile "`r`n# ADR-017: ใช้ตัวตรวจจับภาพแทน cooldown ตามเวลา`r`nNVR_YOLO=1" -Encoding UTF8
  Write-Host "   เพิ่ม NVR_YOLO=1 แล้ว"
}

Say "3/5 ดึงโค้ดล่าสุด"
git pull --quiet
git log -1 --format="   ตอนนี้อยู่ที่: %h %s"

Say "4/5 อัปเดตไลบรารี (ครั้งแรกอาจนานหลายนาที — ต้องโหลดตัวรันโมเดล)"
& npm.cmd install --no-audit --no-fund --silent
if ($LASTEXITCODE -ne 0) { throw "npm install ล้มเหลว (exit $LASTEXITCODE)" }

Say "5/5 รีสตาร์ท listener"
$nodes = Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -like "*nvr-listener*" -or $_.CommandLine -like "*agent:nvr*" }
if ($nodes) {
  $nodes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host "   ปิดตัวเก่าแล้ว — ตัวใหม่จะเปิดเองใน 15 วิ"
} else {
  Start-ScheduledTask -TaskName "TassanaNvrListener"
  Write-Host "   listener ไม่ได้รันอยู่ — สั่งเปิดแล้ว"
}

Write-Host "`n   รอโหลดโมเดลครั้งแรก (~20 MB) สักครู่..."
Start-Sleep -Seconds 60
$log = Join-Path $Dir "logs\nvr-listener.log"
$tail = Get-Content $log -Tail 40 -Encoding UTF8 -ErrorAction SilentlyContinue
Write-Host ""
if ($tail -match "ตัวตรวจจับพร้อม") {
  Write-Host "🎉 ตัวตรวจจับทำงานแล้ว — ตอนนี้ใช้ 'ภาพเปลี่ยนจริงไหม' แทน cooldown ตามเวลา" -ForegroundColor Green
} elseif ($tail -match "ตัวตรวจจับใช้ไม่ได้") {
  Write-Host "⚠️  ตัวตรวจจับโหลดไม่ขึ้น — ระบบยังทำงานปกติด้วย cooldown เดิม (ไม่มีอะไรเสียหาย)" -ForegroundColor Yellow
} else {
  Write-Host "ℹ️  ยังไม่เห็นผลในล็อก อาจกำลังโหลดโมเดลอยู่ — รออีกสักครู่แล้วดูล็อกอีกที" -ForegroundColor Yellow
}
Write-Host "`nล็อก 12 บรรทัดล่าสุด:" -ForegroundColor Cyan
Get-Content $log -Tail 12 -Encoding UTF8 -ErrorAction SilentlyContinue
