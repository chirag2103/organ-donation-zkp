$ErrorActionPreference = 'Stop'
$recordFile = Join-Path $PSScriptRoot 'runtime/local-stack/processes.json'
if (-not (Test-Path -LiteralPath $recordFile)) { Write-Host 'No recorded local stack.'; exit 0 }
$entries = Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
foreach ($entry in $entries) {
    $process = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    $actualStart = $process.StartTime.ToUniversalTime().Ticks.ToString()
    if (-not $entry.createdTicks -or $actualStart -ne $entry.createdTicks) {
        Write-Host "Skipping reused or unverified PID $($entry.pid)"; continue
    }
    Stop-Process -Id $entry.pid -ErrorAction SilentlyContinue
}
Write-Host 'Stopped verified processes recorded by this workspace stack.'
