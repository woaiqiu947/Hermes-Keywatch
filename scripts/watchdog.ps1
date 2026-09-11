# watchdog.ps1 — 每分钟由计划任务调用:健康检查,挂了就拉起来。
# 由 install-service.ps1 注册,不直接手动跑(手动跑一次也无害)。
$ErrorActionPreference = 'SilentlyContinue'

$repo = Split-Path -Parent $PSScriptRoot          # 本文件在 scripts/ 下
$port = if ($env:API_USAGE_PORT) { $env:API_USAGE_PORT } else { 9993 }
$log  = Join-Path $repo 'watchdog.log'

function Write-Log($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
  # 日志简单轮转,避免无限增长
  $f = Get-Item $log
  if ($f.Length -gt 512KB) {
    $tail = Get-Content $log -Tail 200
    Set-Content -Path $log -Value $tail -Encoding UTF8
  }
}

# 1) 服务活着吗?
$healthy = $false
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -TimeoutSec 4 -UseBasicParsing
  if ($r.StatusCode -eq 200) { $healthy = $true }
} catch { $healthy = $false }

if ($healthy) { exit 0 }

# 2) 不通 —— 但有可能是端口被别的进程占着(不是我们的服务)
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Log "node 不在 PATH,无法启动"; exit 1 }

# 3) 精确匹配"我们的"服务进程,避免重复拉起
$existing = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'src[\\/]server\.mjs' }

if ($existing) {
  Write-Log "进程在但 /health 不通(可能正忙),跳过本轮"
  exit 0
}

Start-Process -FilePath $node `
  -ArgumentList "`"$repo\src\server.mjs`"" `
  -WorkingDirectory $repo -WindowStyle Hidden

Write-Log "已拉起聚合服务 (node src/server.mjs)"
