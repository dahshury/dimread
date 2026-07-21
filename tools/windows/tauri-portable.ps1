# Portable Windows package builder.
#
# Produces:
#   dist\DimRead.exe            portable-by-default NSIS installer exe
#   dist\DimRead-portable\      self-contained folder (exe + marker + Data\)
#   dist\DimRead-portable.zip   the folder, zipped
#
# The `portable` marker content must match PORTABLE_MARKER_MAGIC in
# src-tauri/src/portable.rs ("<productName> Portable Mode").
#
# Usage:
#   tools\windows\tauri-portable.ps1               # build + package
#   tools\windows\tauri-portable.ps1 -SkipBuild    # package an existing build

param(
    [string] $OutputDir = "",
    [switch] $SkipBuild,
    [switch] $NoZip
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $PSCommandPath
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$ReleaseDir = Join-Path $RepoRoot "src-tauri\target\release"
$DefaultOutput = Join-Path $RepoRoot "dist\DimRead-portable"
$PortableDir = if ($OutputDir) { $OutputDir } else { $DefaultOutput }
$DistDir = Split-Path -Parent $PortableDir
$PortableInstallerExe = Join-Path $DistDir "DimRead.exe"
$BuildScript = Join-Path $ScriptDir "tauri-build.ps1"
$CiBundleConfig = Join-Path $RepoRoot "tools\tauri-ci-artifacts.conf.json"
$PortableMarker = "DimRead Portable Mode"

if (-not $SkipBuild) {
    & $BuildScript -Bundles "nsis" -Config $CiBundleConfig
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri release build failed with exit code $LASTEXITCODE"
    }
}

# `mainBinaryName` in tauri.conf.json renames the cargo bin (dimread.exe)
# to dimread.exe during `tauri build`; accept either so a plain cargo
# build can still be packaged.
$AppExe = @("dimread.exe", "dimread.exe") |
    ForEach-Object { Join-Path $ReleaseDir $_ } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
if ($null -eq $AppExe) {
    throw "Missing release binary in $ReleaseDir - run tools\windows\tauri-build.ps1 first"
}

$NsisDir = Join-Path $ReleaseDir "bundle\nsis"
$NsisExe = Get-ChildItem -Path $NsisDir -Filter "*.exe" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if ($null -eq $NsisExe) {
    throw "Missing portable Windows exe bundle in: $NsisDir"
}

if (Test-Path -LiteralPath $PortableDir) {
    Remove-Item -LiteralPath $PortableDir -Recurse -Force
}
New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
New-Item -ItemType Directory -Path $PortableDir | Out-Null

# App exe (renamed for a friendly double-clickable name), the portable-by-default
# NSIS installer exe, the portable marker, and an empty Data\ dir. This template
# ships no bundle resources; if you add bundle.resources to tauri.conf.json,
# mirror them here.
Copy-Item -LiteralPath $AppExe -Destination (Join-Path $PortableDir "DimRead.exe") -Force
Copy-Item -LiteralPath $NsisExe.FullName -Destination $PortableInstallerExe -Force
Set-Content -LiteralPath (Join-Path $PortableDir "portable") -Value $PortableMarker -NoNewline -Encoding ASCII
New-Item -ItemType Directory -Path (Join-Path $PortableDir "Data") -Force | Out-Null

if (-not $NoZip) {
    $Zip = "$PortableDir.zip"
    if (Test-Path -LiteralPath $Zip) {
        Remove-Item -LiteralPath $Zip -Force
    }
    Compress-Archive -LiteralPath $PortableDir -DestinationPath $Zip -Force
}

Write-Host "Portable package written to: $PortableDir"
Write-Host "Portable Windows installer exe written to: $PortableInstallerExe"
if (-not $NoZip) {
    Write-Host "Portable zip written to: $PortableDir.zip"
}
