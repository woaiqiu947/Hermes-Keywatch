# install-service.ps1 - register a Windows scheduled task so the aggregation
# service stays resident and self-heals.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -Remove
#
# Approach: fire run-hidden.vbs once a minute; it launches watchdog.ps1 with no
# console flash, and the watchdog health-checks the service and restarts it if
# it died. Same pattern as commandcode-bridge.
#
# Why schtasks /XML and not Register-ScheduledTask: creating a task with the
# *cmdlet* needs administrator rights (HRESULT 0x80070005). Importing an XML
# that declares a per-user task (UserId + LogonType InteractiveToken) works as a
# normal user, which is why this script ships a template instead of a cmdlet call.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
# (GBK on Chinese Windows) when there is no BOM, so non-ASCII text here gets
# mis-decoded and breaks parsing with a "terminator expected" error.
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$TaskName = 'HermesApiUsage'

$repo     = Split-Path -Parent $PSScriptRoot
$template = Join-Path $PSScriptRoot 'watchdog-task.xml.template'
$watchdog = Join-Path $PSScriptRoot 'watchdog.ps1'
$vbs      = Join-Path $PSScriptRoot 'run-hidden.vbs'

if ($Remove) {
  schtasks /Delete /TN $TaskName /F *> $null
  Write-Host "Removed scheduled task '$TaskName' (if it existed)."
  exit 0
}

foreach ($f in @($template, $watchdog, $vbs)) {
  if (-not (Test-Path $f)) { throw "missing required file: $f" }
}
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node not on PATH. Install Node.js (>=18) first." }

# Fill the template. USERDOMAIN\USERNAME form works for both local and AD accounts.
$user = "$env:USERDOMAIN\$env:USERNAME"
$date = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')

$xml = Get-Content $template -Raw
$xml = $xml.Replace('__USER__', $user)
$xml = $xml.Replace('__DATE__', $date)
$xml = $xml.Replace('__VBS__',  $vbs)

# Generated XML goes to TEMP, never into the repo (it carries real paths).
#
# It must be written as UTF-16LE with a BOM, and the declaration rewritten to
# match. schtasks' XML parser on this machine REJECTS a UTF-8 document outright
# with "task XML is malformed (1,40) cannot switch encoding" -- verified by
# feeding it the known-good commandcode-bridge XML, which now fails the same
# way. UTF-16 is Task Scheduler's own export format and imports cleanly. The
# template itself stays UTF-8 in the repo so it remains readable/diffable in
# git; the encoding conversion happens only here, on the way out.
$tmpXml = Join-Path $env:TEMP 'HermesApiUsage.task.xml'
$xml = $xml -replace 'encoding="UTF-8"', 'encoding="UTF-16"'
[System.IO.File]::WriteAllText($tmpXml, $xml, [System.Text.Encoding]::Unicode)

schtasks /Create /TN $TaskName /XML $tmpXml /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks /Create failed (exit $LASTEXITCODE). See output above." }
Write-Host "Registered scheduled task '$TaskName' (every 1 minute, per-user)."

Write-Host "Running the watchdog once now..."
& wscript.exe $vbs
Start-Sleep -Seconds 4

try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9993/health' -TimeoutSec 6 -UseBasicParsing
  Write-Host "Service ready: $($r.Content)"
} catch {
  Write-Host "Service not answering yet; check $repo\watchdog.log"
}

Write-Host ""
Write-Host "Inspect : schtasks /Query /TN $TaskName /V /FO LIST"
Write-Host "Uninstall: powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Remove"
