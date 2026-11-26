# EVE Miner (app files)

EVE Online mining helper: ore values, yield calculator with preset fits, and a mining planner that tells you which system and asteroid belt to go to. Desktop app (Electron) with optional EVE sign-in.

This repository is published automatically from the private development repo on every change: it holds only the files the app needs to run, so installed copies can update themselves without a GitHub sign-in. Don't open pull requests here; changes are overwritten by the next publish. Windows `.exe` builds of each version are under Releases.

## Install (self-updating)

Needs [Git](https://git-scm.com/download/win) and [Node.js](https://nodejs.org/) 22.13 or newer. In PowerShell:

```powershell
git clone https://github.com/Ghost-Xipher/eve-miner-app.git "$env:TEMP\eve-miner-app"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\eve-miner-app\tools\install-launcher.ps1"
```

This puts the app in `%LOCALAPPDATA%\Programs\EVE Miner` with Start menu and desktop shortcuts. While the app is open it checks this repo every 5 minutes and updates itself (it closes, updates and reopens). Uninstall with `install-launcher.ps1 -Uninstall`; your settings are kept.
