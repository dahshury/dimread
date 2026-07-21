# Windows release build driver.
#
# Imports the MSVC x64 environment (vcvars64), optionally puts LLVM's lld-link
# on PATH when it is installed (faster linking; never required), then runs
# `bun run tauri build`.
#
# Usage:
#   tools\windows\tauri-build.ps1                       # NSIS bundle (default)
#   tools\windows\tauri-build.ps1 -NoBundle             # binary only
#   tools\windows\tauri-build.ps1 -Bundles nsis -Config tools\tauri-ci-artifacts.conf.json

param(
    [switch] $NoBundle,
    [string] $Bundles = "",
    [string] $Config = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $PSCommandPath
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")

function Find-VcVars64 {
    $Candidates = @()

    $VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path -LiteralPath $VsWhere) {
        $InstallPath = & $VsWhere -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($LASTEXITCODE -eq 0 -and $InstallPath) {
            $Candidates += (Join-Path $InstallPath "VC\Auxiliary\Build\vcvars64.bat")
        }
    }

    $Candidates += @(
        "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\17\Enterprise\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\17\Professional\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\17\Community\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
    )

    foreach ($Candidate in $Candidates | Select-Object -Unique) {
        if (Test-Path -LiteralPath $Candidate) {
            return $Candidate
        }
    }

    throw "Could not find vcvars64.bat. Install Visual Studio Build Tools with the MSVC x64 toolchain."
}

function Import-VcVars {
    param([string] $VcVars)

    cmd /d /s /c "`"$VcVars`" >nul && set" | ForEach-Object {
        if ($_ -match "^([^=]+)=(.*)$") {
            Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
        }
    }
}

# LLVM is OPTIONAL for this template (the crate links fine with stock MSVC
# link.exe). If lld-link is available, prepend it for faster linking.
function Import-LlvmIfPresent {
    $Candidates = @()
    if ($env:LLVM_BIN) {
        $Candidates += $env:LLVM_BIN
    }
    if ($env:LLVM_HOME) {
        $Candidates += (Join-Path $env:LLVM_HOME "bin")
    }
    $Candidates += "C:\Program Files\LLVM\bin"

    foreach ($Candidate in $Candidates | Select-Object -Unique) {
        $Linker = Join-Path $Candidate "lld-link.exe"
        if (Test-Path -LiteralPath $Linker) {
            $env:PATH = "$Candidate;$env:PATH"
            Write-Host "Using LLVM linker from: $Candidate"
            return
        }
    }
}

# Default to an NSIS bundle when no explicit selection was made.
if (-not $NoBundle -and -not $Bundles) {
    $Bundles = "nsis"
}

$BuildArgs = @()
if ($NoBundle) {
    $BuildArgs += "--no-bundle"
}
if ($Bundles) {
    $BuildArgs += @("--bundles", $Bundles)
}
if ($Config) {
    $BuildArgs += @("--config", $Config)
}

Import-VcVars (Find-VcVars64)
Import-LlvmIfPresent

Push-Location $RepoRoot
try {
    $BuildStopwatch = [Diagnostics.Stopwatch]::StartNew()
    bun run tauri build @BuildArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri build failed with exit code $LASTEXITCODE"
    }
    $BuildStopwatch.Stop()
    Write-Host ("Tauri build pipeline: {0:N2}s" -f $BuildStopwatch.Elapsed.TotalSeconds)
} finally {
    Pop-Location
}
