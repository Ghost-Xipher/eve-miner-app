// Exposes a small, fixed set of calls to the page. Tokens never reach the page.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("eve", {
  login: () => ipcRenderer.invoke("eve-login"),
  token: () => ipcRenderer.invoke("eve-token"),
  esi: path => ipcRenderer.invoke("eve-esi", path),
  shipFit: () => ipcRenderer.invoke("eve-shipfit"),
  waypoint: list => ipcRenderer.invoke("eve-waypoint", list),
  logout: () => ipcRenderer.invoke("eve-logout")
});
