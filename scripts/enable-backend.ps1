#requires -Version 5.1
<#
.SYNOPSIS
  Enable the Windows BaseContainer backend that MXC needs, by turning on the "velocity" feature
  flags MXC reports as missing. Uses ViVeTool (installed via winget if absent).

  This flips staged Windows feature flags and requires a reboot to take effect. It is reversible
  (re-run with -Disable). Only relevant on Windows; other OSes use a different backend.
.PARAMETER Ids
  Comma-separated feature IDs to toggle. Default: the keys MXC's error names (61389575, 61155944).
.PARAMETER Disable
  Disable the IDs instead of enabling them (to revert).
.PARAMETER Yes
  Skip the confirmation prompt (for automation).
.PARAMETER NoReboot
  Don't offer to reboot at the end.
.EXAMPLE
  ./scripts/enable-backend.ps1
  ./scripts/enable-backend.ps1 -Yes
  ./scripts/enable-backend.ps1 -Disable
#>
param(
  [string]$Ids = "61389575,61155944",
  [switch]$Disable,
  [switch]$Yes,
  [switch]$NoReboot
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  Write-Host "This step only applies to Windows. On Linux/macOS the sandbox uses bubblewrap/seatbelt." -ForegroundColor Yellow
  exit 0
}

$action = if ($Disable) { "disable" } else { "enable" }
$idList = $Ids.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }

# 1. Re-launch elevated if we aren't already admin (feature flags require admin).
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Administrator rights are required to change Windows feature flags." -ForegroundColor Yellow
  Write-Host "Relaunching elevated (accept the UAC prompt)..."
  $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-Ids", "`"$Ids`"")
  if ($Disable) { $argList += "-Disable" }
  if ($Yes) { $argList += "-Yes" }
  if ($NoReboot) { $argList += "-NoReboot" }
  $p = Start-Process -FilePath "powershell.exe" -ArgumentList $argList -Verb RunAs -PassThru -Wait
  exit $p.ExitCode
}

# 2. Confirm intent.
Write-Host "== MXC backend: $action BaseContainer feature flags ==" -ForegroundColor Cyan
Write-Host "IDs: $($idList -join ', ')"
Write-Host "This changes staged Windows feature flags and needs a reboot. It is reversible." -ForegroundColor Yellow
if (-not $Yes) {
  $ans = Read-Host "Proceed? [y/N]"
  if ($ans -notmatch '^(y|yes)$') { Write-Host "Aborted."; exit 1 }
}

# 3. Locate ViVeTool, installing it via winget if needed.
function Find-ViVeTool {
  $cmd = Get-Command vivetool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $roots = @(
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"),
    (Join-Path $env:ProgramData "chocolatey\lib")
  ) | Where-Object { Test-Path $_ }
  foreach ($r in $roots) {
    $hit = Get-ChildItem -Path $r -Recurse -Filter "ViVeTool.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

$vive = Find-ViVeTool
if (-not $vive) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "ViVeTool not found and winget is unavailable. Install ViVeTool from https://github.com/thebookisclosed/ViVe/releases and re-run."
  }
  Write-Host "Installing ViVeTool via winget..."
  winget install --id thebookisclosed.Vive -e --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Null
  $vive = Find-ViVeTool
  if (-not $vive) { throw "ViVeTool install completed but the executable could not be located." }
}
Write-Host "Using ViVeTool: $vive"

# 4. Toggle the flags.
$idArg = "/id:" + ($idList -join ",")
$flag = if ($Disable) { "/disable" } else { "/enable" }
Write-Host "Running: ViVeTool $flag $idArg"
& $vive $flag $idArg
$rc = $LASTEXITCODE
if ($rc -ne 0) { throw "ViVeTool exited with code $rc." }

Write-Host "`nDone. The feature change takes effect after a reboot." -ForegroundColor Green
Write-Host "After rebooting, verify with: " -NoNewline; Write-Host "mxc-bootstrap selftest" -ForegroundColor Cyan

# 5. Offer to reboot.
if (-not $NoReboot) {
  if ($Yes) {
    Write-Host "(-Yes given but not auto-rebooting; reboot when convenient.)"
  } else {
    $r = Read-Host "Reboot now? [y/N]"
    if ($r -match '^(y|yes)$') { Restart-Computer -Force }
  }
}
