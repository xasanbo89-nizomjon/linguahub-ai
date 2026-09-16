const { app, BrowserWindow } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");
const { isTrustedGoogleAuthUrl } = require("./lib/electronSecurity");

function createWindow() {
const win = new BrowserWindow({
width: 1400,
height: 900,
minWidth: 360,
minHeight: 600,
webPreferences: {
nodeIntegration: false,
contextIsolation: true
}
});

// Electron denies window.open() by default (no setWindowOpenHandler means
// every popup request is blocked), which would silently break Firebase's
// signInWithPopup Google sign-in flow. Allow it only for the Google/Firebase
// auth domains the popup actually navigates to - not a blanket allow-all.
win.webContents.setWindowOpenHandler(({ url }) => {
return isTrustedGoogleAuthUrl(url) ? { action: "allow" } : { action: "deny" };
});

// Separate from the popup handler above: without this, Electron allows the
// main window's own top-level frame to be navigated to ANY origin by
// default (e.g. a compromised/malicious link), with no restriction at all.
// Allows only the app's own local page and the same trusted Google/Firebase
// auth domains the popup handler allows (needed for signInWithRedirect,
// which navigates the current window rather than opening a popup) - found
// missing via a Phase 8 Electron security checklist review. The app has no
// other legitimate reason to navigate anywhere else.
const indexFileUrl = pathToFileURL(path.join(__dirname, "www", "index.html")).href;
win.webContents.on("will-navigate", (event, url) => {
if (url !== indexFileUrl && !isTrustedGoogleAuthUrl(url)) {
event.preventDefault();
}
});

win.loadFile(path.join(__dirname, "www", "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
if (process.platform !== "darwin") {
app.quit();
}
});

app.on("activate", () => {
if (BrowserWindow.getAllWindows().length === 0) {
createWindow();
}
});
