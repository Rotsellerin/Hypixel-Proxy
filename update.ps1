param(
  [Parameter(Mandatory = $true)][int]$LauncherPid,
  [Parameter(Mandatory = $true)][string]$RootDir,
  [Parameter(Mandatory = $true)][string]$PayloadDir,
  [Parameter(Mandatory = $true)][string]$Version,
  [switch]$SkipDependencies,
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
$resolvedRoot = [IO.Path]::GetFullPath($RootDir)
$resolvedPayload = [IO.Path]::GetFullPath($PayloadDir)
$launcherPath = Join-Path $resolvedRoot "app\Hypixel Proxy.exe"

if (-not (Test-Path -LiteralPath (Join-Path $resolvedRoot "package.json") -PathType Leaf)) {
  throw "The selected installation root is invalid."
}
if (-not (Test-Path -LiteralPath (Join-Path $resolvedPayload "package.json") -PathType Leaf)) {
  throw "The downloaded update package is invalid."
}
if (-not (Test-Path -LiteralPath (Join-Path $resolvedPayload "app\Hypixel Proxy.exe") -PathType Leaf)) {
  throw "The downloaded update does not contain the Windows launcher."
}

try {
  Wait-Process -Id $LauncherPid -Timeout 60 -ErrorAction SilentlyContinue
} catch {
}

function Copy-UpdateTree([string]$Source, [string]$Destination) {
  if (Test-Path -LiteralPath $Source -PathType Container) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($child in Get-ChildItem -LiteralPath $Source -Force) {
      Copy-UpdateTree $child.FullName (Join-Path $Destination $child.Name)
    }
    return
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

$preservedNames = @("state", ".env", ".git", ".lunar-recovery")
foreach ($item in Get-ChildItem -LiteralPath $resolvedPayload -Force) {
  if ($preservedNames -contains $item.Name) { continue }
  Copy-UpdateTree $item.FullName (Join-Path $resolvedRoot $item.Name)
}

$stateDirectory = Join-Path $resolvedRoot "state"
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
Set-Content -LiteralPath (Join-Path $stateDirectory "installed-version.txt") -Value $Version -Encoding UTF8

$updateLog = Join-Path $stateDirectory "update.log"
if (-not $SkipDependencies) {
  Push-Location $resolvedRoot
  try {
    & npm.cmd install --no-audit --no-fund *>> $updateLog
    if ($LASTEXITCODE -ne 0) {
      Add-Content -LiteralPath $updateLog -Value "npm install failed with exit code $LASTEXITCODE."
    }
  } catch {
    Add-Content -LiteralPath $updateLog -Value $_.Exception.Message
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
  throw "The updated launcher could not be found."
}
if (-not $NoRestart) {
  Start-Process -FilePath $launcherPath -WorkingDirectory (Split-Path -Parent $launcherPath)
}
