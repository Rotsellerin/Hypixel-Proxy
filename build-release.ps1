$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Stop-OnError([int]$ExitCode) {
  if ($ExitCode -ne 0) { exit $ExitCode }
}

& npm.cmd test
Stop-OnError $LASTEXITCODE

$releaseDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".release"))
$payloadDirectory = Join-Path $releaseDirectory "Hypixel-Proxy"
$publishedAppDirectory = Join-Path $releaseDirectory "published-app"
$assetPath = Join-Path $releaseDirectory "Hypixel-Proxy-Windows.zip"
if (-not $releaseDirectory.StartsWith([IO.Path]::GetFullPath($PSScriptRoot), [StringComparison]::OrdinalIgnoreCase)) {
  throw "Release output resolved outside the project directory."
}

if (Test-Path -LiteralPath $releaseDirectory) {
  Remove-Item -LiteralPath $releaseDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $payloadDirectory "app") -Force | Out-Null

$dotnet = Join-Path $PSScriptRoot ".dotnet\dotnet.exe"
if (-not (Test-Path -LiteralPath $dotnet -PathType Leaf)) {
  throw ".NET SDK is missing from .dotnet."
}
& $dotnet publish "launcher\HypixelProxy.App\HypixelProxy.App.csproj" `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:EnableCompressionInSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -o $publishedAppDirectory
Stop-OnError $LASTEXITCODE

$rootFiles = @(
  ".env.example",
  "Hypixel Proxy.vbs",
  "README.md",
  "package-lock.json",
  "package.json",
  "start.bat",
  "start.ps1",
  "tsconfig.json",
  "update.ps1"
)
foreach ($file in $rootFiles) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $payloadDirectory $file) -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "src") -Destination $payloadDirectory -Recurse -Force
Copy-Item -LiteralPath (Join-Path $publishedAppDirectory "Hypixel Proxy.exe") -Destination (Join-Path $payloadDirectory "app\Hypixel Proxy.exe") -Force

Compress-Archive -LiteralPath $payloadDirectory -DestinationPath $assetPath -CompressionLevel Optimal
Write-Host ""
Write-Host "Release asset built: $assetPath"
