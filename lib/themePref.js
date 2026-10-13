"use strict";

// LinguaHub AI - desktop theme preference mirror (pure + fs only, no Electron
// import, so it is unit-testable).
//
// The renderer's localStorage ("linguahub-ai:theme", www/theme.js) stays the
// source of truth for the theme choice. But the main process has to pick the
// BrowserWindow backgroundColor and nativeTheme.themeSource BEFORE the page
// exists, and it cannot read renderer localStorage. So www/theme.js reports
// every change over IPC and main.js mirrors the three-value choice
// ("system" | "light" | "dark") into a tiny JSON file in userData. It holds a
// UI preference only - no chat data, no account data.

const fs = require("fs");

const THEME_MODES = ["system", "light", "dark"];

// Must equal --bg in www/theme.css (tests/theme-pref.test.js enforces this).
const BACKGROUND = { light: "#FAF8F5", dark: "#171412" };

function isThemeMode(value) {
  return THEME_MODES.indexOf(value) !== -1;
}

// Missing, unreadable or corrupt file -> "system". Never throws.
function readThemePref(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && isThemeMode(parsed.mode) ? parsed.mode : "system";
  } catch (err) {
    return "system";
  }
}

// Returns false (never throws) when the mode is invalid or the write fails.
function writeThemePref(file, mode) {
  if (!isThemeMode(mode)) return false;
  try {
    fs.writeFileSync(file, JSON.stringify({ mode }), "utf8");
    return true;
  } catch (err) {
    return false;
  }
}

function backgroundFor(isDark) {
  return isDark ? BACKGROUND.dark : BACKGROUND.light;
}

module.exports = { THEME_MODES, BACKGROUND, isThemeMode, readThemePref, writeThemePref, backgroundFor };
