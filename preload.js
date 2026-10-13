"use strict";

// LinguaHub AI - preload (sandboxed, contextIsolation on).
//
// Exposes ONE small, frozen object - window.linguahubDesktop - for the
// custom title bar (www/titlebar.js). Nothing else from Electron or Node is
// reachable from the page: ipcRenderer itself is never exposed, only fixed
// wrappers around the fixed channels below. Channel names are duplicated in
// main.js (a sandboxed preload cannot require local files);
// tests/electron-source.test.js fails if the two lists ever drift apart.

const { contextBridge, ipcRenderer } = require("electron");

const MAXIMIZED_EVENT = "window:maximized-changed";

contextBridge.exposeInMainWorld("linguahubDesktop", Object.freeze({
  platform: process.platform,
  minimize: () => ipcRenderer.send("window:minimize"),
  toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
  close: () => ipcRenderer.send("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  // Reports the theme choice ("system" | "light" | "dark") so main can sync
  // nativeTheme and the window background; main validates it again.
  setTheme: (mode) => {
    if (mode === "system" || mode === "light" || mode === "dark") ipcRenderer.send("window:set-theme", mode);
  },
  // Returns an unsubscribe function. The callback never sees the IPC event.
  onMaximizeChange(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, maximized) => callback(Boolean(maximized));
    ipcRenderer.on(MAXIMIZED_EVENT, listener);
    return () => ipcRenderer.removeListener(MAXIMIZED_EVENT, listener);
  }
}));
