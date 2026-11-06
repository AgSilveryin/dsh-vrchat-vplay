# uninstall-drivers.ps1 - unregister the bundled OpenVR drivers (dsh_hmd + vmt) from SteamVR.
#
# ASCII only on purpose: Windows PowerShell 5.1 parses .ps1 as ANSI unless a BOM is present.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-drivers.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-drivers.ps1 -WhatIf
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-drivers.ps1 -SteamPath "<Steam 安装目录>"
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-drivers.ps1 -DeleteFiles
#
# Behaviour:
#   * finds Steam via HKCU\Software\Valve\Steam\SteamPath (fallback C:\Program Files (x86)\Steam)
#   * uses vrpathreg.exe removedriver for <drivers>\dsh_hmd and <drivers>\vmt
#   * idempotent: a driver that is not registered is skipped
#   * -Force removes registrations that point to a DIFFERENT folder with the same name
#   * -DeleteFiles also deletes the two copied driver folders (only inside this drivers folder)
#   * -WhatIf only prints what would happen
#   * SteamVR must be RESTARTED afterwards for the change to take effect
param(
  [switch]$WhatIf,
  [switch]$Force,
  [switch]$DeleteFiles,
  [string]$SteamPath = ''
)
$ErrorActionPreference = 'Continue'

$Here = $PSScriptRoot
$DriverNames = @('dsh_hmd', 'vmt')

function Info($m) { Write-Host "[info ] $m" }
function Ok($m)   { Write-Host "[ok   ] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[warn ] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[error] $m" -ForegroundColor Red; exit 1 }

Write-Host "=== dsh-vrchat-vplay - OpenVR driver uninstaller ==="
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

# --- unregister -------------------------------------------------------------
$errors = 0
foreach ($name in $DriverNames) {
  $localDir = Join-Path $Here $name
  $localFull = if (Test-Path $localDir) { (Get-Item $localDir).FullName } else { $null }
  $existing = if ($registered.ContainsKey($name)) { $registered[$name] } else { $null }
  if (-not $existing) {
    Ok "driver '{0}' is not registered, nothing to do" -f $name
    continue
  }
  $isLocal = $localFull -and ($existing.TrimEnd('\') -ieq $localFull.TrimEnd('\'))
  if (-not $isLocal -and -not $Force) {
    Warn ("driver '{0}' is registered from a different folder: {1}" -f $name, $existing)
    Warn "skip it (use -Force if you really want to remove that registration)"
    continue
  }
  if ($WhatIf) {
    Write-Host ("[WhatIf] would run: vrpathreg removedriver `"{0}`"" -f $existing)
  } else {
    Info ("removing driver registration: {0}" -f $existing)
    & $VrPathReg removedriver $existing 2>&1 | ForEach-Object { Write-Host "        $_" }
    if ($LASTEXITCODE -ne 0) {
      Warn ("removedriver failed for {0} (exit {1})" -f $existing, $LASTEXITCODE)
      $errors++
    } else {
      Ok ("unregistered: {0}" -f $existing)
    }
  }
}

# --- optionally delete copied driver folders --------------------------------
if ($DeleteFiles) {
  foreach ($name in $DriverNames) {
    $localDir = Join-Path $Here $name
    if (-not (Test-Path $localDir)) { continue }
    if ($WhatIf) {
      Write-Host ("[WhatIf] would delete folder: {0}" -f $localDir)
    } else {
      Info ("deleting folder: {0}" -f $localDir)
      try {
        Remove-Item -LiteralPath $localDir -Recurse -Force -ErrorAction Stop
        Ok ("deleted: {0}" -f $localDir)
      } catch {
        Warn ("failed to delete {0}: {1}" -f $localDir, $_.Exception.Message)
        $errors++
      }
    }
  }
}

if ($errors -gt 0) {
  Fail ("{0} problem(s). SteamVR may still be holding files; quit SteamVR and re-run." -f $errors)
}

if ($WhatIf) {
  Write-Host ""
  Ok "dry run finished, nothing was changed (-WhatIf)."
  exit 0
}

Write-Host ""
$running = Get-Process -Name 'vrserver' -ErrorAction SilentlyContinue
if ($running) {
  Warn "SteamVR is RUNNING. Restart it now for the change to take effect."
} else {
  Info "SteamVR is not running; the change applies next time SteamVR starts."
}
Write-Host "        the plugin's one-click launcher (ensureGameStack) will start it with the remaining drivers"
Ok "uninstall-drivers done."
exit 0
