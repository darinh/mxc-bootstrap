#requires -Version 5.1
<#
.SYNOPSIS
  Machine setup: deploy the MXC sandbox runtime to an install dir, put `mxc-bootstrap` on PATH,
  and run a repo-agnostic health check. This is phase 1 — onboard individual repos afterwards
  with `mxc-bootstrap init`.
.PARAMETER InstallDir
  Where to deploy the runtime. Default: ~/.mxc
.PARAMETER Register
  Optionally register a global broker now: copilot | claude | codex | cursor | all
.PARAMETER NoPath
  Skip adding <InstallDir>\bin to the user PATH.
.EXAMPLE
  ./scripts/setup.ps1
  ./scripts/setup.ps1 -Register copilot
#>
param(
  [string]$InstallDir = (Join-Path $HOME ".mxc"),
  [ValidateSet("copilot", "claude", "codex", "cursor", "all", "")]
  [string]$Register = "",
  [switch]$NoPath
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$McpDir = Join-Path $InstallDir "mcp"
$BinDir = Join-Path $InstallDir "bin"

function Require-Node {
  $v = (node --version) 2>$null
  if (-not $v) { throw "Node.js is required (>=18). Install it and re-run." }
  $major = [int]($v.TrimStart("v").Split(".")[0])
  if ($major -lt 18) { throw "Node.js >= 18 required; found $v" }
  Write-Host "Node $v OK"
}

Write-Host "== mxc-bootstrap setup ==" -ForegroundColor Cyan
Write-Host "repo:    $RepoRoot"
Write-Host "install: $InstallDir"
Require-Node

# 1. Deploy runtime: mcp server, cli, configure, profiles, examples.
New-Item -ItemType Directory -Force -Path $McpDir | Out-Null
Get-ChildItem -Path (Join-Path $RepoRoot "mcp") -Exclude "node_modules" |
  Copy-Item -Destination $McpDir -Recurse -Force

Copy-Item -Force (Join-Path $RepoRoot "scripts\cli.mjs") (Join-Path $InstallDir "cli.mjs")
Copy-Item -Force (Join-Path $RepoRoot "scripts\configure.mjs") (Join-Path $InstallDir "configure.mjs")

# Profiles live at <install>\profiles (outside any agent's write scope — the trust anchor).
$ProfilesDir = Join-Path $InstallDir "profiles"
New-Item -ItemType Directory -Force -Path $ProfilesDir | Out-Null
Copy-Item -Force (Join-Path $RepoRoot "config\profiles\*.json") $ProfilesDir

# Examples (used to render manual-config snippets during registration).
$ExamplesDir = Join-Path $InstallDir "examples"
New-Item -ItemType Directory -Force -Path $ExamplesDir | Out-Null
Copy-Item -Force (Join-Path $RepoRoot "examples\*") $ExamplesDir

Write-Host "Deployed runtime to $InstallDir" -ForegroundColor Green

# 2. Install dependencies (pulls @microsoft/mxc-sdk with the bundled native binaries).
Push-Location $McpDir
try {
  Write-Host "Installing npm dependencies (this can take a minute)..."
  npm install --no-fund --no-audit
} finally {
  Pop-Location
}

# 3. Create the `mxc-bootstrap` launcher in <install>\bin and add it to PATH.
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$cmdLauncher = Join-Path $BinDir "mxc-bootstrap.cmd"
@(
  '@echo off',
  'node "%~dp0..\cli.mjs" %*'
) | Set-Content -Path $cmdLauncher -Encoding ASCII
# Also drop a POSIX launcher so Git Bash / WSL on the same box can use it.
$shLauncher = Join-Path $BinDir "mxc-bootstrap"
@(
  '#!/usr/bin/env bash',
  'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
  'exec node "$DIR/../cli.mjs" "$@"'
) -join "`n" | Set-Content -Path $shLauncher -Encoding ASCII -NoNewline
Write-Host "Launcher: $cmdLauncher"

if (-not $NoPath) {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($userPath -split ';') -notcontains $BinDir) {
    $newPath = if ($userPath) { "$userPath;$BinDir" } else { $BinDir }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "Added $BinDir to your user PATH (open a new terminal to use 'mxc-bootstrap')." -ForegroundColor Green
  } else {
    Write-Host "$BinDir already on PATH."
  }
}

# 4. Repo-agnostic health check.
Write-Host "`n== health check ==" -ForegroundColor Cyan
node (Join-Path $McpDir "selftest.mjs")

# 5. Optional global registration now (otherwise onboard repos with `mxc-bootstrap init`).
if ($Register) {
  Write-Host "`n== registration ==" -ForegroundColor Cyan
  node (Join-Path $InstallDir "configure.mjs") "--install" $InstallDir "--repo" $InstallDir "--register" $Register
}

Write-Host "`nMachine setup done." -ForegroundColor Green
Write-Host "Next: cd into a repo and run " -NoNewline; Write-Host "mxc-bootstrap init" -ForegroundColor Cyan
