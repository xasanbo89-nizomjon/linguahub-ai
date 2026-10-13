const { app, BrowserWindow, Menu, ipcMain, nativeTheme } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");
const { isTrustedGoogleAuthUrl, isTrustedSenderUrl } = require("./lib/electronSecurity");

const IS_MAC = process.platform === "darwin";
const indexFileUrl = pathToFileURL(path.join(__dirname, "www", "index.html")).href;

// Matches --bg in www/theme.css. Shown while the page loads so there is no
// white flash; the window background follows the OS theme until the
// renderer's own theme preference is known.
const BACKGROUND = { light: "#FAF8F5", dark: "#171412" };

function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light;
}

// The default File/Edit/View/Window/Help bar is gone (the window is
// frameless and www/titlebar.js draws its own title bar), but a minimal
// role-based menu stays installed because it is what makes Cut/Copy/Paste/
// Select All/Undo/Redo work in inputs - mandatory on macOS, harmless and
// invisible elsewhere. Reload and DevTools (Ctrl+R, Ctrl+Shift+I) exist
// only in development, never in a packaged build.
function buildMenu() {
  const template = [];
  if (IS_MAC) template.push({ role: "appMenu" });
  template.push({ role: "editMenu" });
  if (!app.isPackaged) {
    template.push({
      label: "Dev",
      submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }]
    });
  }
  return Menu.buildFromTemplate(template);
}

// Window-control IPC for the custom title bar. These four channels (plus the
// maximize-state event sent below) are the entire IPC surface - keep them in
// sync with preload.js. Every handler first checks that the message came
// from the app's own page, not from an auth popup or any other frame.
function windowForTrustedSender(event) {
  const frameUrl = event.senderFrame && event.senderFrame.url;
  if (!isTrustedSenderUrl(frameUrl, indexFileUrl)) return null;
  return BrowserWindow.fromWebContents(event.sender);
}

ipcMain.on("window:minimize", (event) => {
  const win = windowForTrustedSender(event);
  if (win) win.minimize();
});

ipcMain.on("window:toggle-maximize", (event) => {
  const win = windowForTrustedSender(event);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

ipcMain.on("window:close", (event) => {
  const win = windowForTrustedSender(event);
  if (win) win.close();
});

ipcMain.handle("window:is-maximized", (event) => {
  const win = windowForTrustedSender(event);
  return win ? win.isMaximized() : false;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 360,
    minHeight: 600,
    backgroundColor: windowBackground(),
    // Frameless on Windows/Linux (custom title bar with its own controls);
    // macOS keeps its native traffic lights over the hidden title bar.
    ...(IS_MAC ? { titleBarStyle: "hiddenInset" } : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  win.setMenuBarVisibility(false);

  // Keeps the title bar's maximize/restore icon in sync, however the window
  // was maximized (button, double-click on the drag region, Win+Up, snap).
  const sendMaximized = () => {
    if (!win.isDestroyed()) win.webContents.send("window:maximized-changed", win.isMaximized());
  };
  ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen"].forEach((name) => win.on(name, sendMaximized));

  // Electron denies window.open() by default (no setWindowOpenHandler means
  // every popup request is blocked), which would silently break Firebase's
  // signInWithPopup Google sign-in flow. Allow it only for the Google/Firebase
  // auth domains the popup actually navigates to - not a blanket allow-all.
  // A popup inherits its opener's window options, so it is explicitly given a
  // normal frame (a frameless Google sign-in window could not be moved or
  // closed) and no preload (the title-bar API is for the app's own page only).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isTrustedGoogleAuthUrl(url)) return { action: "deny" };
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        frame: true,
        titleBarStyle: "default",
        autoHideMenuBar: true,
        webPreferences: {
          preload: undefined,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true
        }
      }
    };
  });

  // Separate from the popup handler above: without this, Electron allows the
  // main window's own top-level frame to be navigated to ANY origin by
  // default (e.g. a compromised/malicious link), with no restriction at all.
  // Allows only the app's own local page and the same trusted Google/Firebase
  // auth domains the popup handler allows (needed for signInWithRedirect,
  // which navigates the current window rather than opening a popup) - found
  // missing via a Phase 8 Electron security checklist review. The app has no
  // other legitimate reason to navigate anywhere else.
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== indexFileUrl && !isTrustedGoogleAuthUrl(url)) {
      event.preventDefault();
    }
  });

  win.loadFile(path.join(__dirname, "www", "index.html"));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildMenu());
  createWindow();
});

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
