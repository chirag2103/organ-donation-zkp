$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try { node scripts/localStack.js } finally { Pop-Location }
