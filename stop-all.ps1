# stop-all.ps1
# ---------------------------------------------------------------------------
# Stops every process started by start-all.ps1 (Hardhat node, IPFS daemon,
# backend server, Vite frontend) - use this instead of closing each window by
# hand, and instead of leaving stray processes running across sessions.
# ---------------------------------------------------------------------------

$targets = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'hardhat|server[/\\]index\.js|vite') -or
    ($_.Name -eq 'ipfs.exe' -and $_.CommandLine -match 'daemon')
}

if (-not $targets) {
    Write-Host "No matching processes found - nothing to stop." -ForegroundColor Yellow
    exit 0
}

$targets | ForEach-Object {
    Write-Host "Stopping PID $($_.ProcessId): $($_.CommandLine)" -ForegroundColor Cyan
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Done. (Any PowerShell windows left open by start-all.ps1 can now be closed.)" -ForegroundColor Green
