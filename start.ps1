$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path "node_modules")) {
  npm.cmd install
}

npm.cmd run build
npm.cmd start

if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "Hypixel Proxy kunde inte starta. Felkod: $LASTEXITCODE"
  Read-Host "Tryck Enter for att stanga"
}
