# EVE Miner launcher: keeps this copy of the app identical to GitHub, starts it, and keeps it up to date while it is open.
# The "EVE Miner" shortcuts made by tools/install-launcher.ps1 run this (hidden window) from the copy at
# %LOCALAPPDATA%\Programs\EVE Miner\app, a clone of the public repo Ghost-Xipher/eve-miner-app (app files only,
# published by CI from the private repo on every push to main).
#   1. git fetch, then reset --hard to origin/<branch> (any local changes or extra commits in that copy are
#      thrown away). Offline, it starts the version it has.
#   2. npm ci when package.json / package-lock.json changed (or Electron is missing).
#   3. Starts Electron on this folder, then stays running in the background while the app is open: every
#      -CheckMinutes it asks GitHub for the branch's newest commit (git ls-remote). When there is a new one it
#      closes the app, updates (steps 1-2) and opens it again. When the update changed this script, the new
#      launcher takes over. It ends when the app is closed.
#   A second shortcut click while a launcher is watching just opens the app (the first launcher keeps watching).
# Log: launcher.log next to the app folder (%LOCALAPPDATA%\Programs\EVE Miner\launcher.log; the last launcher only).
# Works in Windows PowerShell 5.1 and PowerShell 7.
param(
  [switch]$NoStart,                                     # update only, no app, no watching (installer and testing)
  [string]$AppDir = (Split-Path $PSScriptRoot -Parent), # the app copy to update and start
  [double]$CheckMinutes = 5,                            # how often to look for a new commit while the app is open
  # Where updates come from: the public copy CI publishes on every push to main (no GitHub sign-in needed).
  # An install that still points somewhere else (e.g. the private dev repo) is switched to it. "" keeps origin as is.
  [string]$Repo = "https://github.com/Ghost-Xipher/eve-miner-app.git"
)
$ErrorActionPreference = "Continue"
$env:GIT_TERMINAL_PROMPT = "0"; $env:GCM_INTERACTIVE = "never"  # never pop up a sign-in from the hidden window
$log = Join-Path (Split-Path $AppDir -Parent) "launcher.log"
$electron = Join-Path $AppDir "node_modules\electron\dist\electron.exe"
$self = Join-Path $AppDir "tools\launcher.ps1"

function Write-Log([string]$text) { Add-Content $log "$(Get-Date -Format s) $text" }
function Invoke-Logged([string]$exe, [string[]]$argv) {
  Write-Log "> $exe $($argv -join ' ')"
  $out = & $exe @argv 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  if ($out) { Add-Content $log $out }
  Add-Content $log "  (exit $code)"
  return $code
}
function Get-Git([string[]]$argv) { (& git -C $AppDir @argv 2>$null | Select-Object -First 1) }
function Show-Problem([string]$text) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show("$text`n`nDetails: $log", "EVE Miner") | Out-Null
}
function Get-Branch {
  $b = Get-Git @("rev-parse", "--abbrev-ref", "HEAD")
  if (-not $b -or $b -eq "HEAD") { "main" } else { $b }
}
# Newest commit of the branch on GitHub, or $null when it cannot be reached.
function Get-RemoteHead {
  $lines = @(& git -C $AppDir ls-remote origin "refs/heads/$(Get-Branch)" 2>$null)  # no Select-Object -First: it makes $LASTEXITCODE -1
  if ($LASTEXITCODE -ne 0 -or -not $lines.Count -or -not $lines[0]) { return $null }
  return ($lines[0] -split "\s+")[0]
}
# Makes the copy match origin/<branch> exactly, then installs dependencies if they changed.
# Returns the list of files that changed (empty when nothing did).
function Update-App {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Log "git not found; not updating."; return @() }
  if ($Repo -and (Get-Git @("remote", "get-url", "origin")) -ne $Repo) {
    Write-Log "Switching the update source to $Repo."
    Invoke-Logged git @("-C", $AppDir, "remote", "set-url", "origin", $Repo) | Out-Null
  }
  $branch = Get-Branch
  $before = Get-Git @("rev-parse", "HEAD")
  if ((Invoke-Logged git @("-C", $AppDir, "fetch", "--quiet", "origin", $branch)) -ne 0) {
    Write-Log "Could not reach GitHub; keeping the version already here."
  } else {
    if (& git -C $AppDir status --porcelain --untracked-files=no 2>$null) { Write-Log "Throwing away local changes in this copy." }
    Invoke-Logged git @("-C", $AppDir, "reset", "--hard", "--quiet", "origin/$branch") | Out-Null
    Invoke-Logged git @("-C", $AppDir, "clean", "-fdq") | Out-Null   # untracked files only; node_modules (ignored) stays
  }
  $after = Get-Git @("rev-parse", "HEAD")
  Write-Log "Version: $before -> $after"
  $changed = @()
  if ($before -and $after -and $before -ne $after) { $changed = @(& git -C $AppDir diff --name-only $before $after 2>$null) }
  if (($changed -contains "package.json") -or ($changed -contains "package-lock.json") -or -not (Test-Path $electron)) {
    if ((Invoke-Logged "npm.cmd" @("ci", "--prefix", $AppDir, "--no-audit", "--no-fund")) -ne 0) {
      Write-Log "npm ci failed; keeping the parts already installed."
    }
  }
  return $changed
}
function Get-AppProcesses { @(Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $electron }) }
function Start-App {
  if (-not (Test-Path $electron)) { Show-Problem "Electron is missing in $AppDir. Run npm ci there."; exit 1 }
  Start-Process -FilePath $electron -ArgumentList "`"$AppDir`"" -WorkingDirectory $AppDir
  Write-Log "Started the app."
}
# Closes the app like the window's X button (settings and sign-in are saved), then makes sure it is gone.
function Stop-App {
  foreach ($p in Get-AppProcesses) { if ($p.MainWindowHandle -ne 0) { $p.CloseMainWindow() | Out-Null } }
  $t = Get-Date
  while ((Get-AppProcesses).Count -and ((Get-Date) - $t).TotalSeconds -lt 15) { Start-Sleep -Milliseconds 500 }
  Get-AppProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Write-Log "Closed the app for an update."
}

# Only one launcher watches; another click just opens the app.
$mutex = New-Object System.Threading.Mutex($false, "Local\EVE-Miner-launcher")
$watcher = $false
try { $watcher = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $watcher = $true }
if (-not $watcher -and -not $NoStart) { Write-Log "Another launcher is watching; just opening the app."; Start-App; exit 0 }

Set-Content $log "EVE Miner launcher $(Get-Date -Format s) in $AppDir (checks every $CheckMinutes min)"
Update-App | Out-Null
if ($NoStart) { exit 0 }
Start-App

while ($true) {
  Start-Sleep -Seconds ([int][Math]::Max(5, $CheckMinutes * 60))
  if (-not (Get-AppProcesses).Count) { Write-Log "The app was closed; launcher done."; break }
  $remote = Get-RemoteHead
  if (-not $remote -or $remote -eq (Get-Git @("rev-parse", "HEAD"))) { continue }
  Write-Log "GitHub has $remote; updating."
  Stop-App
  $changed = Update-App
  if ($changed -contains "tools/launcher.ps1") {
    Write-Log "The launcher changed; handing over to the new one."
    $mutex.ReleaseMutex(); $mutex.Dispose()
    $ps = (Get-Process -Id $PID).Path
    Start-Process -FilePath $ps -WindowStyle Hidden -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", "`"$self`"", "-AppDir", "`"$AppDir`"", "-CheckMinutes", "$CheckMinutes", "-Repo", "`"$Repo`"")
    exit 0
  }
  Start-App
}
