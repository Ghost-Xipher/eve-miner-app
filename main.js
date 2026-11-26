const { app, BrowserWindow, shell, session, ipcMain, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");

const core = require("./lib/eve-core");

// Same callback as EVE Hub Trader, so the same EVE application (client ID) works for both apps.
const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;
const UA = `eve-miner/${app.getVersion ? app.getVersion() : "1"} (Electron ${process.versions.electron})`;

let sess = null; // { clientId, accessToken, refreshToken, expiresAt, characterId, characterName }
const sessFile = () => path.join(app.getPath("userData"), "eve-session.bin");

function persist() {
  try {
    if (!sess) { fs.rmSync(sessFile(), { force: true }); return; }
    if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(sessFile(), safeStorage.encryptString(JSON.stringify(sess)));
  } catch (e) { /* session stays in memory only */ }
}
function restore() {
  try {
    if (safeStorage.isEncryptionAvailable() && fs.existsSync(sessFile())) sess = JSON.parse(safeStorage.decryptString(fs.readFileSync(sessFile())));
    if (sess && sess.clientId !== core.CLIENT_ID) { sess = null; persist(); } // signed in through another EVE app: sign in again
  } catch (e) { sess = null; }
}

function waitForCode(state, openBrowser) {
  return new Promise((resolve, reject) => {
    let timer;
    const page = ok => `<!doctype html><meta charset="utf-8"><title>EVE Miner</title><body style="font:18px system-ui;background:#07100c;color:#e2eee6;display:grid;place-items:center;height:100vh;margin:0"><p>${ok ? "Signed in. You can close this tab and go back to EVE Miner." : "Sign-in failed. Close this tab and try again from the app."}</p></body>`;
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, `http://localhost:${PORT}`);
      if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const code = u.searchParams.get("code"), good = code && u.searchParams.get("state") === state;
      res.writeHead(good ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page(good));
      clearTimeout(timer); srv.close();
      good ? resolve(code) : reject(new Error("EVE returned an error, or the login state did not match. Try signing in again."));
    });
    timer = setTimeout(() => { srv.close(); reject(new Error("Sign-in timed out after 5 minutes. Try again.")); }, 300000);
    srv.on("error", e => { clearTimeout(timer); reject(new Error(e.code === "EADDRINUSE" ? `Port ${PORT} is in use (is EVE Hub Trader signing in right now?). Finish or close that sign-in and try again.` : e.message)); });
    srv.listen(PORT, "127.0.0.1", openBrowser);
  });
}

ipcMain.handle("eve-login", async () => {
  const clientId = core.CLIENT_ID; // built in: every account signs in through the same EVE application
  const { verifier, challenge, state } = core.pkce();
  const url = core.authorizeUrl({ clientId, redirect: REDIRECT, challenge, state });
  const code = await waitForCode(state, () => shell.openExternal(url));
  sess = await core.exchangeCode(clientId, code, verifier, UA);
  persist();
  return { characterId: sess.characterId, characterName: sess.characterName };
});

async function freshSession() {
  const next = await core.freshen(sess, UA);
  if (next !== sess) { sess = next; persist(); }
  return sess;
}

ipcMain.handle("eve-token", async () => { const s = await freshSession(); return s ? { characterId: s.characterId, characterName: s.characterName } : null; });
ipcMain.handle("eve-esi", async (_e, p) => { const s = await freshSession(); return s ? core.esiGet(s, p, UA) : { ok: false, status: 401 }; });
ipcMain.handle("eve-shipfit", async () => { const s = await freshSession(); return s ? core.shipFit(s, UA) : { ok: false, status: 401 }; });
ipcMain.handle("eve-waypoint", async (_e, list) => { const s = await freshSession(); return s ? core.setWaypoints(s, list, UA) : { ok: false, status: 401 }; });
ipcMain.handle("eve-logout", async () => { sess = null; persist(); });

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 900, minWidth: 760,
    backgroundColor: "#07100c", title: "EVE Miner", autoHideMenuBar: true, icon: path.join(__dirname, "assets", "icon-512.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadFile(path.join(__dirname, "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file://")) e.preventDefault(); });
}

app.whenReady().then(() => {
  restore();
  // ESI asks apps to identify themselves with a User-Agent.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["https://esi.evetech.net/*"] }, (details, callback) => {
    details.requestHeaders["User-Agent"] = UA;
    callback({ requestHeaders: details.requestHeaders });
  });
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
