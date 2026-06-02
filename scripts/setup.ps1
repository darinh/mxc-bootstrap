#requires -Version 5.1
<#
.SYNOPSIS
  Deploy the MXC sandbox MCP server to an install dir and smoke-test it.
.PARAMETER InstallDir
  Where to deploy the runtime. Default: ~/.mxc
.PARAMETER Register
  Optional harness to register with: copilot | claude | codex | cursor
.EXAMPLE
  ./scripts/setup.ps1
  ./scripts/setup.ps1 -Register copilot
#>
param(
  [string]$InstallDir = (Join-Path $HOME ".mxc"),
  [ValidateSet("copilot", "claude", "codex", "cursor", "all", "")]
  [string]$Register = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$McpDir = Join-Path $InstallDir "mcp"

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

# 1. Deploy server + config (skip node_modules; npm install regenerates it in the target)
New-Item -ItemType Directory -Force -Path $McpDir | Out-Null
Get-ChildItem -Path (Join-Path $RepoRoot "mcp") -Exclude "node_modules" |
  Copy-Item -Destination $McpDir -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "config") | Out-Null
Copy-Item -Recurse -Force (Join-Path $RepoRoot "config\*") (Join-Path $InstallDir "config")
Write-Host "Deployed server files to $McpDir"

# 2. Install dependencies (pulls @microsoft/mxc-sdk with the bundled native binaries)
Push-Location $McpDir
try {
  Write-Host "Installing npm dependencies (this can take a minute)..."
  npm install --no-fund --no-audit
} finally {
  Pop-Location
}

# 3. Smoke test
Write-Host "`n== self-test ==" -ForegroundColor Cyan
node (Join-Path $McpDir "selftest.mjs")

# 4. Render snippets / optional registration
Write-Host "`n== registration ==" -ForegroundColor Cyan
$configureArgs = @((Join-Path $RepoRoot "scripts\configure.mjs"), "--install", $InstallDir, "--repo", $RepoRoot)
if ($Register) { $configureArgs += @("--register", $Register) }
node @configureArgs

Write-Host "`nDone." -ForegroundColor Green
