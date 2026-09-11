# install-service.ps1 — 注册 Windows 计划任务,让聚合服务常驻并自愈。
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -Remove
#
# 做法:每分钟触发一次 watchdog.ps1,它做健康检查,不健康就把服务拉起来。
# 这跟 commandcode-bridge 用的是同一套模式。
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$TaskName = 'HermesApiUsage'

$repo     = Split-Path -Parent $PSScriptRoot
$watchdog = Join-Path $PSScriptRoot 'watchdog.ps1'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "✓ 已移除计划任务 $TaskName"
  exit 0
}

if (-not (Test-Path $watchdog)) { throw "找不到 $watchdog" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node 不在 PATH 上,请先装 Node.js (>=18)" }

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdog`""

# 登录时启动 + 之后每分钟复查一次
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$triggerTick  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
                  -RepetitionInterval (New-TimeSpan -Minutes 1)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $TaskName `
  -Action $action -Trigger @($triggerLogon, $triggerTick) -Settings $settings `
  -Description 'Hermes API 余额聚合服务 (127.0.0.1:9993) 看门狗' -Force | Out-Null

Write-Host "✓ 已注册计划任务 $TaskName"
Write-Host "  现在立即跑一次 watchdog…"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watchdog
Start-Sleep -Seconds 2

try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9993/health' -TimeoutSec 5 -UseBasicParsing
  Write-Host "✓ 服务已就绪: $($r.Content)"
} catch {
  Write-Host "! 服务还没起来,请检查 $repo\watchdog.log"
}

Write-Host ""
Write-Host "卸载: powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Remove"
