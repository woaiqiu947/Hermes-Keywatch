# watchdog.ps1 - run every minute by the scheduled task: health check, restart if dead.
# Registered by install-service.ps1. Running it manually once is harmless.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
# (GBK on Chinese Windows) when there is no BOM, so non-ASCII text here gets
# mis-decoded and can break quoting with a "terminator expected" parse error.
$ErrorActionPreference = 'SilentlyContinue'

$repo = Split-Path -Parent $PSScriptRoot
$port = if ($env:API_USAGE_PORT) { $env:API_USAGE_PORT } else { 9993 }
$log  = Join-Path $repo 'watchdog.log'

function Write-Log($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
  # keep the log from growing without bound
  $f = Get-Item $log
  if ($f.Length -gt 512KB) {
    $tail = Get-Content $log -Tail 200
    Set-Content -Path $log -Value $tail -Encoding UTF8
  }
}

# 1) is the service answering?
$healthy = $false
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -TimeoutSec 4 -UseBasicParsing
  if ($r.StatusCode -eq 200) { $healthy = $true }
} catch { $healthy = $false }

if ($healthy) { exit 0 }

# 2) not answering - make sure node is available
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Log "node not on PATH; cannot start service"; exit 1 }

# 3) match OUR process exactly, so we never double-start and never touch
#    unrelated node processes (e.g. the commandcode-bridge on :9992)
$existing = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'src[\\/]server\.mjs' }

if ($existing) {
  Write-Log "process alive but /health not answering (busy?); skipping this round"
  exit 0
}

Start-Process -FilePath $node `
  -ArgumentList "`"$repo\src\server.mjs`"" `
  -WorkingDirectory $repo -WindowStyle Hidden

Write-Log "started aggregation service (node src/server.mjs)"
