# start-all.ps1
# ---------------------------------------------------------------------------
# Launches the full ZKP-PFE Organ Donation stack for local dev/demo:
#   1. Hardhat node          (:8545)
#   2. Deploy contracts      (one-shot, after node is ready)
#   3. IPFS daemon           (:5001 API, :8080 gateway)
#   4. Backend server        (:3001)
#   5. Frontend (Vite)       (:5173)
#
# Each service opens in its own PowerShell window so you can see its logs -
# closing a window stops that service. Run this from the project root:
#   .\start-all.ps1
#
# IMPORTANT: step 2 (deploy) only runs after step 1 confirms it's actually
# accepting RPC calls. Skipping/misordering this is what causes
# "could not decode result data" / stale-contract-address errors in the
# frontend.
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Wait-ForRpc($url, $label, $timeoutSec) {
    Write-Host "Waiting for $label..." -ForegroundColor Yellow
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            Invoke-WebRequest -Uri $url -Method Post `
                -Body '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' `
                -ContentType 'application/json' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop | Out-Null
            Write-Host "$label is ready." -ForegroundColor Green
            return $true
        } catch {
            Start-Sleep -Milliseconds 750
        }
    }
    Write-Host "$label did not become ready within $timeoutSec s." -ForegroundColor Red
    return $false
}

function Wait-ForHttp($url, $label, $timeoutSec) {
    Write-Host "Waiting for $label..." -ForegroundColor Yellow
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop | Out-Null
            Write-Host "$label is ready." -ForegroundColor Green
            return $true
        } catch {
            Start-Sleep -Milliseconds 750
        }
    }
    Write-Host "$label did not become ready within $timeoutSec s." -ForegroundColor Red
    return $false
}

Write-Host "=== ZKP-PFE Organ Donation System - starting full stack ===" -ForegroundColor Cyan

# --- 1. Hardhat node --------------------------------------------------------
Write-Host ""
Write-Host "[1/5] Launching Hardhat node..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    '-NoProfile', '-NoExit', '-Command',
    "cd '$root'; Write-Host 'HARDHAT NODE - leave this window open' -ForegroundColor Magenta; npm run node"
)
if (-not (Wait-ForRpc 'http://127.0.0.1:8545' 'Hardhat node (:8545)' 180)) { exit 1 }

# --- 2. Deploy contracts (one-shot, in THIS window) -------------------------
Write-Host ""
Write-Host "[2/5] Deploying contracts..." -ForegroundColor Cyan
Push-Location $root
npx hardhat run scripts/deploy.js --network localhost
if ($LASTEXITCODE -ne 0) {
    Write-Host "Deployment failed - aborting." -ForegroundColor Red
    Pop-Location
    exit 1
}
Pop-Location

# --- 3. IPFS daemon ----------------------------------------------------------
Write-Host ""
Write-Host "[3/5] Launching IPFS daemon..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    '-NoProfile', '-NoExit', '-Command',
    "Write-Host 'IPFS DAEMON - leave this window open' -ForegroundColor Magenta; ipfs daemon"
)
function Wait-ForIpfs($timeoutSec) {
    Write-Host "Waiting for IPFS API (:5001)..." -ForegroundColor Yellow
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            Invoke-WebRequest -Uri 'http://127.0.0.1:5001/api/v0/version' -Method Post `
                -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop | Out-Null
            Write-Host "IPFS API (:5001) is ready." -ForegroundColor Green
            return $true
        } catch {
            Start-Sleep -Milliseconds 750
        }
    }
    Write-Host "IPFS API (:5001) did not become ready within $timeoutSec s." -ForegroundColor Red
    return $false
}
Wait-ForIpfs 90 | Out-Null
# (Non-fatal if this times out - the backend's /api/status will show ipfs:false
#  and the app degrades gracefully to demo/placeholder ciphertexts.)

# --- 4. Backend server --------------------------------------------------------
Write-Host ""
Write-Host "[4/5] Launching backend server..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    '-NoProfile', '-NoExit', '-Command',
    "cd '$root'; Write-Host 'BACKEND SERVER - leave this window open' -ForegroundColor Magenta; npm run server"
)
Wait-ForHttp 'http://127.0.0.1:3001/api/status' 'Backend server (:3001)' 60 | Out-Null

# --- 5. Frontend ---------------------------------------------------------------
Write-Host ""
Write-Host "[5/5] Launching frontend..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    '-NoProfile', '-NoExit', '-Command',
    "cd '$root'; Write-Host 'FRONTEND (Vite) - leave this window open' -ForegroundColor Magenta; npm run frontend"
)
Wait-ForHttp 'http://127.0.0.1:5173' 'Frontend (:5173)' 90 | Out-Null

Write-Host ""
Write-Host "=== All services launched ===" -ForegroundColor Green
Write-Host "Pre-flight check:  curl http://localhost:3001/api/status"
Write-Host "Opening http://localhost:5173 ..."
Write-Host ""
Start-Sleep -Seconds 1
Start-Process 'http://localhost:5173'

Write-Host "Reminder: every time you restart the Hardhat node, MetaMask's cached" -ForegroundColor Yellow
Write-Host "nonce for your account goes stale. If transactions start failing after" -ForegroundColor Yellow
Write-Host "a restart: MetaMask -> select the account -> Settings -> Advanced ->" -ForegroundColor Yellow
Write-Host "'Clear activity and nonce data' (or 'Clear activity tab data')." -ForegroundColor Yellow
