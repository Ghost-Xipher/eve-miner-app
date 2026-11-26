# Installs EVE Miner as a self-updating app on this computer (no .exe build):
#   - clones the public app repo (Ghost-Xipher/eve-miner-app, branch main; CI publishes it from the private repo) to %LOCALAPPDATA%\Programs\EVE Miner\app and runs npm ci,
#   - writes an icon and adds "EVE Miner" shortcuts to the Start menu and the desktop.
# The shortcuts run tools/launcher.ps1, which pulls the newest main from GitHub before each start and keeps it updated while the app is open.
# Needs git and Node.js 22.13 or newer (no GitHub sign-in: the app repo is public).
#   powershell -ExecutionPolicy Bypass -File tools\install-launcher.ps1              install, or redo the shortcuts
#   powershell -ExecutionPolicy Bypass -File tools\install-launcher.ps1 -Uninstall   remove the copy and shortcuts
# Settings, fit and EVE sign-in live in %APPDATA%\EVE Miner (Electron's own data) and are kept on uninstall.
param(
  # Under Local\Programs like other per-user Electron apps: on some PCs %LOCALAPPDATA% itself carries ACLs that
  # Chromium's GPU sandbox can't read through ("GPU process isn't usable"), while Programs has its own plain ACL.
  [string]$Dir = (Join-Path $env:LOCALAPPDATA "Programs\EVE Miner"),
  [string]$Branch = "main",
  [string]$Repo = "https://github.com/Ghost-Xipher/eve-miner-app.git",  # where the app and its updates come from
  [switch]$NoDesktop,
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
$app = Join-Path $Dir "app"
$links = @((Join-Path ([Environment]::GetFolderPath("Programs")) "EVE Miner.lnk"))
if (-not $NoDesktop) { $links += (Join-Path ([Environment]::GetFolderPath("Desktop")) "EVE Miner.lnk") }

if ($Uninstall) {
  foreach ($l in $links) { if (Test-Path $l) { Remove-Item $l; Write-Output "Removed $l" } }
  if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir; Write-Output "Removed $Dir" }
  Write-Output "EVE Miner launcher uninstalled (settings in $env:APPDATA\EVE Miner are kept)."
  exit 0
}

foreach ($c in "git", "npm.cmd") {
  if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { throw "$c was not found. Install it first (see README)." }
}
$ErrorActionPreference = "Continue"  # git and npm write progress to stderr

if (Test-Path (Join-Path $app ".git")) {
  Write-Output "Already installed in $app; updating it."
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app "tools\launcher.ps1") -NoStart
} else {
  $src = $Repo
  New-Item -ItemType Directory -Force $Dir | Out-Null
  Write-Output "Cloning $src ($Branch) to $app ..."
  & git clone --branch $Branch $src $app
  if ($LASTEXITCODE -ne 0) { throw "git clone failed." }
  Write-Output "Installing Electron (npm ci; this takes a minute) ..."
  & npm.cmd ci --prefix $app --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
}

# Icon: an .ico holding the 32, 64 and 192 px PNGs as they are (Windows Vista and later read PNG icon entries).
$ico = Join-Path $Dir "eve-miner.ico"
$sizes = 32, 64, 192
$pngs = $sizes | ForEach-Object { , [IO.File]::ReadAllBytes((Join-Path $app "assets\icon-$_.png")) }
$ms = New-Object IO.MemoryStream
$bw = New-Object IO.BinaryWriter $ms
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i] % 256
  $bw.Write([byte]$s); $bw.Write([byte]$s); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$pngs[$i].Length); $bw.Write([uint32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Flush()
[IO.File]::WriteAllBytes($ico, $ms.ToArray())

$ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$shell = New-Object -ComObject WScript.Shell
foreach ($l in $links) {
  $s = $shell.CreateShortcut($l)
  $s.TargetPath = $ps
  $s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $app 'tools\launcher.ps1')`""
  $s.WorkingDirectory = $app
  $s.IconLocation = "$ico,0"
  $s.WindowStyle = 7  # minimized, so the PowerShell window barely flashes
  $s.Description = "EVE Miner (updates from GitHub when opened)"
  $s.Save()
  Write-Output "Shortcut: $l"
}
Write-Output "Done. Open EVE Miner from the Start menu or the desktop; it updates itself from GitHub each time it opens."
