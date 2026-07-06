param(
  [switch]$App
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Stop-OnError($ExitCode) {
  if ($ExitCode -eq 0) {
    return
  }

  if ($App) {
    exit $ExitCode
  }

  Write-Host ""
  Write-Host "Hypixel Proxy kunde inte starta. Felkod: $ExitCode"
  Read-Host "Tryck Enter for att stanga"
  exit $ExitCode
}

if (-not (Test-Path "node_modules")) {
  npm.cmd install
  Stop-OnError $LASTEXITCODE
}

npm.cmd run build
Stop-OnError $LASTEXITCODE
npm.cmd start
Stop-OnError $LASTEXITCODE
