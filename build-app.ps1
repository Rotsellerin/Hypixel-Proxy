$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$dotnet = Join-Path $PSScriptRoot ".dotnet\dotnet.exe"
if (-not (Test-Path $dotnet)) {
  Write-Host ".NET SDK saknas i .dotnet. Installera SDK:n forst."
  exit 1
}

& $dotnet publish "launcher\HypixelProxy.App\HypixelProxy.App.csproj" `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:EnableCompressionInSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -o app

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Built app\Hypixel Proxy.exe"
