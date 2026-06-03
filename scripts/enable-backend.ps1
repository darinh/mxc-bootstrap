#requires -Version 5.1
<#
.SYNOPSIS
  Enable a Windows containment backend that MXC can use.

  Two backends are selectable via -Backend:
    basecontainer  (default) — turns on the BaseContainer "velocity" feature flags MXC reports
                               as missing, using ViVeTool (installed via winget if absent).
    windowssandbox            — turns on the Windows Sandbox VM backend by enabling the
                               Containers-DisposableClientVM optional feature via DISM.

  Both flip staged Windows state and require a reboot to take effect. basecontainer is reversible
  (re-run with -Disable). Only relevant on Windows; other OSes use a different backend.
.PARAMETER Backend
  Which backend to enable: basecontainer (default) or windowssandbox.
.PARAMETER Ids
  Comma-separated feature IDs to toggle for the basecontainer backend. Default: the keys MXC's
  error names (61389575, 61155944). Ignored for windowssandbox.
.PARAMETER Disable
  Disable instead of enable (to revert). For basecontainer this disables the IDs; for
  windowssandbox this disables the Containers-DisposableClientVM feature.
.PARAMETER Yes
  Skip the confirmation prompt (for automation).
.PARAMETER NoReboot
  Don't offer to reboot at the end.
.EXAMPLE
  ./scripts/enable-backend.ps1
  ./scripts/enable-backend.ps1 -Yes
  ./scripts/enable-backend.ps1 -Disable
  ./scripts/enable-backend.ps1 -Backend windowssandbox
#>
param(
  [ValidateSet("basecontainer", "windowssandbox")]
  [string]$Backend = "basecontainer",
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

# Feature IDs are numeric; reject anything else so the value is safe to embed in the elevated
# relaunch command below (and catches typos early).
if ($Ids -and ($Ids -notmatch '^[0-9,]+$')) {
  throw "Invalid -Ids '$Ids'; expected comma-separated numeric feature IDs (e.g. 61389575,61155944)."
}

# 1. Re-launch elevated if we aren't already admin (feature flags / DISM require admin).
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Administrator rights are required to change Windows features." -ForegroundColor Yellow
  Write-Host "Relaunching elevated (accept the UAC prompt)..."
  # Defeat a TOCTOU swap of this script while the UAC prompt is open: capture the *current*
  # script bytes now and run them via -EncodedCommand after elevation, rather than re-reading
  # $PSCommandPath from a (possibly user-writable) directory once elevated. Embedded values are
  # allow-listed (-Backend via ValidateSet, -Ids validated numeric above), so the constructed
  # command is injection-safe. The script text is base64-carried to avoid quoting pitfalls.
  $scriptB64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes((Get-Content -Raw -LiteralPath $PSCommandPath)))
  $sw = @()
  if ($Disable)  { $sw += "-Disable" }
  if ($Yes)      { $sw += "-Yes" }
  if ($NoReboot) { $sw += "-NoReboot" }
  $payload = @"
`$st = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('$scriptB64'))
& ([scriptblock]::Create(`$st)) -Backend '$Backend' -Ids '$Ids' $($sw -join ' ')
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($payload))
  $p = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded) -Verb RunAs -PassThru -Wait
  exit $p.ExitCode
}

# ---- Windows Sandbox VM backend (Containers-DisposableClientVM) --------------------------------
if ($Backend -eq "windowssandbox") {
  Write-Host "== MXC backend: $action Windows Sandbox (Containers-DisposableClientVM) ==" -ForegroundColor Cyan
  Write-Host "This changes a Windows optional feature and needs a reboot. Requires virtualization in firmware." -ForegroundColor Yellow
  if (-not $Yes) {
    $ans = Read-Host "Proceed? [y/N]"
    if ($ans -notmatch '^(y|yes)$') { Write-Host "Aborted."; exit 1 }
  }
  try {
    if ($Disable) {
      $res = Disable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -NoRestart
    } else {
      $res = Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All -NoRestart
    }
  } catch {
    throw "Failed to $action the Containers-DisposableClientVM feature: $($_.Exception.Message)"
  }
  Write-Host "`nDone. The feature change takes effect after a reboot." -ForegroundColor Green
  Write-Host "After rebooting, verify with: " -NoNewline; Write-Host "mxc-bootstrap selftest" -ForegroundColor Cyan

  if (-not $NoReboot) {
    if ($Yes) {
      Write-Host "(-Yes given but not auto-rebooting; reboot when convenient.)"
    } else {
      $r = Read-Host "Reboot now? [y/N]"
      if ($r -match '^(y|yes)$') { Restart-Computer -Force }
    }
  }
  exit 0
}

# ---- BaseContainer backend (velocity feature flags via ViVeTool) -------------------------------

# 2. Confirm intent.
Write-Host "== MXC backend: $action BaseContainer feature flags ==" -ForegroundColor Cyan
Write-Host "IDs: $($idList -join ', ')"
Write-Host "This changes staged Windows feature flags and needs a reboot. It is reversible." -ForegroundColor Yellow
if (-not $Yes) {
  $ans = Read-Host "Proceed? [y/N]"
  if ($ans -notmatch '^(y|yes)$') { Write-Host "Aborted."; exit 1 }
}

# 3. Locate a *real* ViVeTool, installing it via winget if needed.
#
# ViVeTool is an unsigned, per-user tool (winget installs it under %LOCALAPPDATA%), and we must run
# it elevated — so we cannot simply exclude user-writable locations without breaking normal installs.
# Instead we defend by validating what we run: (a) reject empty/placeholder decoys, (b) prefer the
# official `thebookisclosed.Vive` package, (c) confirm the binary actually behaves like ViVeTool
# before trusting it, and (d) after enabling, re-query to confirm the feature really flipped — so a
# fake or no-op tool cannot masquerade as a successful enable and send the user into a useless reboot.

function Invoke-ViVe {
  param([Parameter(Mandatory)][string]$Path, [string[]]$VtArgs = @())
  $out = [System.IO.Path]::GetTempFileName(); $err = "$out.err"
  try {
    $p = Start-Process -FilePath $Path -ArgumentList $VtArgs -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $out -RedirectStandardError $err -ErrorAction Stop
    $text = ((Get-Content $out -Raw -ErrorAction SilentlyContinue), (Get-Content $err -Raw -ErrorAction SilentlyContinue)) -join ""
    return [pscustomobject]@{ ExitCode = $p.ExitCode; Output = $text }
  } finally { Remove-Item $out, $err -ErrorAction SilentlyContinue }
}

function Test-ViVeTool {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  if ((Get-Item -LiteralPath $Path).Length -le 0) { return $false }   # reject 0-byte decoys
  try { return ((Invoke-ViVe -Path $Path -VtArgs @("/?")).Output -match 'ViVeTool') }
  catch { return $false }
}

function Find-ViVeTool {
  $roots = @(
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"),   # per-user winget — the common case
    (Join-Path $env:ProgramFiles "WinGet\Packages"),
    (Join-Path $env:ProgramData  "Microsoft\WinGet\Packages"),
    (Join-Path $env:ProgramData  "chocolatey\lib")
  ) | Where-Object { $_ -and (Test-Path $_) }
  $cands = New-Object System.Collections.Generic.List[string]
  $cmd = Get-Command vivetool.exe -ErrorAction SilentlyContinue
  if ($cmd) { $cands.Add($cmd.Source) }
  foreach ($r in $roots) {
    Get-ChildItem -Path $r -Recurse -Filter "ViVeTool.exe" -ErrorAction SilentlyContinue |
      ForEach-Object { $cands.Add($_.FullName) }
  }
  # Non-empty only; official package first, then largest — then behaviourally verify before trusting.
  $ordered = $cands |
    Select-Object -Unique |
    Where-Object { (Test-Path -LiteralPath $_) -and ((Get-Item -LiteralPath $_).Length -gt 0) } |
    Sort-Object `
      @{ Expression = { if ($_ -match 'thebookisclosed\.Vive') { 0 } else { 1 } } }, `
      @{ Expression = { (Get-Item -LiteralPath $_).Length }; Descending = $true }
  foreach ($c in $ordered) { if (Test-ViVeTool -Path $c) { return $c } }
  return $null
}

$vive = Find-ViVeTool
if (-not $vive) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "No working ViVeTool found and winget is unavailable. Install ViVeTool from https://github.com/thebookisclosed/ViVe/releases and re-run."
  }
  Write-Host "Installing ViVeTool via winget..."
  winget install --id thebookisclosed.Vive -e --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Null
  $vive = Find-ViVeTool
  if (-not $vive) { throw "ViVeTool install completed but no working executable could be located (only empty/placeholder copies were found)." }
}
Write-Host "Using ViVeTool: $vive"

# 4. Toggle the flags.
$idArg = "/id:" + ($idList -join ",")
$flag = if ($Disable) { "/disable" } else { "/enable" }
Write-Host "Running: ViVeTool $flag $idArg"
$res = Invoke-ViVe -Path $vive -VtArgs @($flag, $idArg)
if ($res.Output) { Write-Host $res.Output.TrimEnd() }
if ($res.ExitCode -ne 0) { throw "ViVeTool exited with code $($res.ExitCode)." }

# 4b. Confirm the configuration store actually changed. A fake/no-op tool — or a silent failure —
# would otherwise look like success and send the user into a reboot that fixes nothing.
if (-not $Disable) {
  foreach ($id in $idList) {
    $q = Invoke-ViVe -Path $vive -VtArgs @("/query", "/id:$id")
    if ($q.Output -notmatch 'State\s*:\s*Enabled') {
      throw "ViVeTool reported success but feature $id is not Enabled afterward — the change did not take effect. Output: $($q.Output.Trim())"
    }
  }
  Write-Host "Verified: the feature flags now report Enabled in the configuration store." -ForegroundColor Green
}

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
