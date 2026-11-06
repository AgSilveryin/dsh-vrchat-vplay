# install-drivers.ps1 - register the bundled OpenVR drivers (dsh_hmd + vmt) with SteamVR.
#
# ASCII only on purpose: Windows PowerShell 5.1 parses .ps1 as ANSI unless a BOM is present.
#
# Usage (no admin needed, SteamVR does NOT need to run):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-drivers.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-drivers.ps1 -WhatIf
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-drivers.ps1 -Force
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-drivers.ps1 -SteamPath "<Steam 安装目录>"
#
# Behaviour:
#   * finds Steam via HKCU\Software\Valve\Steam\SteamPath (falls back to C:\Program Files (x86)\Steam)
#   * uses <Steam>\steamapps\common\SteamVR\bin\win64\vrpathreg.exe adddriver <dir>
#   * idempotent: a driver already registered from the SAME folder is skipped
#   * if the same driver name is registered from ANOTHER folder, it aborts unless -Force is given
#   * -WhatIf only prints what would happen (safe dry run)
#   * after success SteamVR must be RESTARTED to load the drivers
param(
  [switch]$WhatIf,
  [switch]$Force,
  [string]$SteamPath = ''
)
$ErrorActionPreference = 'Continue'

$Here = $PSScriptRoot
$DriverNames = @('dsh_hmd', 'vmt')

function Info($m) { Write-Host "[info ] $m" }
function Ok($m)   { Write-Host "[ok   ] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[warn ] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[error] $m" -ForegroundColor Red; exit 1 }

Write-Host "=== dsh-vrchat-vplay - OpenVR driver installer ==="
Info "drivers folder: $Here"

# --- locate Steam -----------------------------------------------------------
if (-not $SteamPath) {
  try {
    $reg = Get-ItemProperty -Path 'HKCU:\Software\Valve\Steam' -Name 'SteamPath' -ErrorAction Stop
    if ($reg -and $reg.SteamPath) { $SteamPath = [string]$reg.SteamPath }
  } catch { }
}
if (-not $SteamPath) {
  $SteamPath = 'C:\Program Files (x86)\Steam'
  Warn "SteamPath not found in registry, using default: $SteamPath"
}
$SteamPath = $SteamPath.Trim().Replace('/', '\').TrimEnd('\')
Info "Steam path: $SteamPath"

$VrPathReg = Join-Path $SteamPath 'steamapps\common\SteamVR\bin\win64\vrpathreg.exe'
if (-not (Test-Path $VrPathReg)) {
  Fail "vrpathreg.exe not found: $VrPathReg  (is SteamVR installed? pass -SteamPath <steam dir>)"
}
Ok "vrpathreg: $VrPathReg"

# --- validate bundled drivers ----------------------------------------------
$Targets = @()
foreach ($name in $DriverNames) {
  $dir = Join-Path $Here $name
  if (-not (Test-Path $dir)) { Fail "driver folder missing: $dir" }
  $dir = (Get-Item $dir).FullName
  $manifest = Join-Path $dir 'driver.vrdrivermanifest'
  if (-not (Test-Path $manifest)) { Fail "manifest missing: $manifest" }
  $dll = Join-Path $dir ('bin\win64\driver_' + $name + '.dll')
  if (-not (Test-Path $dll)) { Fail "DLL missing: $dll" }
  $Targets += [pscustomobject]@{ Name = $name; Dir = $dir; Dll = $dll }
  Info ("bundled driver ready: {0} -> {1}" -f $name, $dll)
}

# --- read current registrations --------------------------------------------
$showText = (& $VrPathReg show 2>&1 | Out-String)
$registered = @{}
foreach ($line in ($showText -split "`r?`n")) {
  $m = [regex]::Match($line, '^\s*([^\s:]+)\s*:\s*(.+?)\s*$')
  if (-not $m.Success) { continue }
  $n = $m.Groups[1].Value
  $p = $m.Groups[2].Value
  if ($n -ieq 'Runtime' -or $n -ieq 'Config' -or $n -ieq 'Log') { continue }
  if (-not $registered.ContainsKey($n)) { $registered[$n] = $p }
}
if ($registered.Count -gt 0) {
  Info ("currently registered external drivers: " + (($registered.Keys | Sort-Object) -join ', '))
} else {
  Info "no external drivers currently registered"
}

# --- register ---------------------------------------------------------------
$errors = 0
foreach ($t in $Targets) {
  $existing = $null
  if ($registered.ContainsKey($t.Name)) { $existing = $registered[$t.Name] }
  if ($existing -and ($existing.TrimEnd('\') -ieq $t.Dir.TrimEnd('\'))) {
    Ok "already registered from this folder, nothing to do: $($t.Dir)"
    continue
  }
  if ($existing) {
    if (-not $Force) {
      Warn ("driver '{0}' is already registered from a DIFFERENT folder: {1}" -f $t.Name, $existing)
      Warn  "re-run with -Force to unregister the old folder first and use the bundled one"
      $errors++
      continue
    }
    if ($WhatIf) {
      Write-Host ("[WhatIf] would run: vrpathreg removedriver `"{0}`"" -f $existing)
    } else {
      Info ("removing old registration: {0}" -f $existing)
      & $VrPathReg removedriver $existing 2>&1 | ForEach-Object { Write-Host "        $_" }
      if ($LASTEXITCODE -ne 0) { Warn "removedriver returned exit $LASTEXITCODE (continuing)"; }
    }
  }
  if ($WhatIf) {
    Write-Host ("[WhatIf] would run: vrpathreg adddriver `"{0}`"" -f $t.Dir)
  } else {
    Info ("adding driver: {0}" -f $t.Dir)
    & $VrPathReg adddriver $t.Dir 2>&1 | ForEach-Object { Write-Host "        $_" }
    if ($LASTEXITCODE -ne 0) {
      Warn ("adddriver failed for {0} (exit {1})" -f $t.Dir, $LASTEXITCODE)
      $errors++
    } else {
      Ok ("registered: {0}" -f $t.Dir)
    }
  }
}

if ($errors -gt 0) {
  Fail ("{0} problem(s). Fix them and re-run (or run with -Force)." -f $errors)
}

if ($WhatIf) {
  Write-Host ""
  Ok "dry run finished, nothing was changed (-WhatIf)."
  exit 0
}

# --- final status -----------------------------------------------------------
Write-Host ""
Info "current registrations:"
(& $VrPathReg show 2>&1 | Out-String) -split "`r?`n" | Where-Object { $_.Trim() } | ForEach-Object { Write-Host "        $_" }

$running = Get-Process -Name 'vrserver' -ErrorAction SilentlyContinue
Write-Host ""
if ($running) {
  Warn "SteamVR is RUNNING. Restart it now so the drivers are loaded:"
} else {
  Info "SteamVR is not running. Next time you start SteamVR the drivers will be loaded:"
}
Write-Host "        1. quit SteamVR (VR menu -> Exit, or close vrmonitor.exe)"
Write-Host "        2. start SteamVR again (vrstartup.exe) - or use the plugin one-click launcher"
Write-Host "        3. check these lines in <Steam>\logs\vrserver.txt:"
Write-Host "             Loaded server driver dsh_hmd (IServerTrackedDeviceProvider_004) ..."
Write-Host "             Loaded server driver vmt (IServerTrackedDeviceProvider_004) ..."
Ok "install-drivers done."
exit 0
