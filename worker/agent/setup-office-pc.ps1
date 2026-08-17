# Tassana AI — one-shot installer for the on-site bridge PC (Windows).
# Run in PowerShell (right-click Start → Terminal / PowerShell):
#   irm https://raw.githubusercontent.com/vesonwc/tassana-ai/master/worker/agent/setup-office-pc.ps1 | iex
# What it does: installs Git + Node (winget), clones the repo to C:\Tassana ai,
# npm install, asks you to type the DVR password (never leaves this PC),
# writes .env, tests the connection, and registers autostart.

$ErrorActionPreference = "Stop"
$Repo = "https://github.com/vesonwc/tassana-ai.git"
$Dir  = "C:\Tassana ai"

function Say($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }

Say "1/6 ตรวจ Git และ Node.js"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Say "ติดตั้ง Git..."; winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Say "ติดตั้ง Node.js LTS..."; winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
}
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
git --version | Out-Null; node --version | Out-Null
Write-Host "   Git และ Node พร้อม"

Say "2/6 ดึงโค้ด Tassana"
if (Test-Path "$Dir\.git") {
  Set-Location $Dir; git pull --quiet
} else {
  git clone --quiet $Repo $Dir; Set-Location $Dir
}
Write-Host "   โค้ดอยู่ที่ $Dir"

Say "3/6 ติดตั้งไลบรารี (รอสักครู่)"
npm install --no-audit --no-fund --silent
Write-Host "   เสร็จ"

Say "4/6 ตั้งค่า"
$host_ = Read-Host "IP ของ DVR [192.168.1.164]"; if (-not $host_) { $host_ = "192.168.1.164" }
$user_ = Read-Host "ชื่อผู้ใช้ DVR [admin]"; if (-not $user_) { $user_ = "admin" }
$pw = Read-Host "รหัสผ่าน DVR (พิมพ์แล้ว Enter — จะไม่แสดงบนจอ)" -AsSecureString
$pwPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))
$key = Read-Host "Site key ของโครงการ [sk_aaa5def9afde4578b5d5618253e6f201]"; if (-not $key) { $key = "sk_aaa5def9afde4578b5d5618253e6f201" }
$chan = Read-Host "กล้องที่ให้ตรวจเวรดึก คั่นด้วยจุลภาค [1,7,16]"; if (-not $chan) { $chan = "1,7,16" }
$env_ = @"
NVR_HOST=$host_
NVR_PORT=80
NVR_USER=$user_
NVR_PASSWORD=$pwPlain
NVR_WEBHOOK_URL=https://tassana-ai.vercel.app/api/webhook/$key
NVR_PATROL_CHANNELS=$chan
NVR_PATROL_TIMES=19:30,22:00,00:00,03:00
NVR_BUSY_START=08:00
NVR_BUSY_END=19:00
"@
[System.IO.File]::WriteAllText("$Dir\.env", $env_, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "   บันทึก .env แล้ว (อยู่ในเครื่องนี้เท่านั้น)"

Say "5/6 ทดสอบต่อ DVR"
$test = Start-Process -FilePath "npx" -ArgumentList "tsx","worker/tools/nvr-probe.ts" -NoNewWindow -Wait -PassThru -RedirectStandardOutput "$env:TEMP\tassana-probe.txt"
$out = Get-Content "$env:TEMP\tassana-probe.txt" -Raw
if ($out -match "เปิด") { Write-Host "   ✅ ต่อ DVR ได้ รหัสถูกต้อง" -ForegroundColor Green } else { Write-Host "   ⚠️ ต่อ DVR ไม่ได้ — เช็ก IP/รหัส แล้วรันสคริปต์ใหม่" -ForegroundColor Yellow; Write-Host $out; exit 1 }

Say "6/6 ตั้งให้สตาร์ทเองตอนเปิดเครื่อง"
powershell -ExecutionPolicy Bypass -File "$Dir\worker\agent\install-autostart.ps1"
Start-ScheduledTask -TaskName "TassanaNvrListener"
Start-Sleep -Seconds 8
Write-Host ""
Write-Host "🎉 เสร็จสมบูรณ์ — เครื่องนี้เป็นสะพานของ Tassana แล้ว" -ForegroundColor Green
Write-Host "   log: $Dir\logs\nvr-listener.log"
Write-Host "   ปิดหน้าต่างนี้ได้เลย โปรแกรมทำงานเบื้องหลังและเปิดเองทุกครั้งที่เครื่องบูต"
Get-Content "$Dir\logs\nvr-listener.log" -Tail 5 -ErrorAction SilentlyContinue
