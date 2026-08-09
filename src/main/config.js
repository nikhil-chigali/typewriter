'use strict';

// User configuration, in the OS-standard config directory (app.getPath('userData')).
// This is the only storage module that depends on Electron.

const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');

const CONFIG_NAME = 'config.json';
const DEFAULTS = { recordsDir: null, activePlan: null, muted: false, scale: null };

function configPath() {
  return path.join(app.getPath('userData'), CONFIG_NAME);
}

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
    return {
      recordsDir: typeof raw.recordsDir === 'string' ? raw.recordsDir : null,
      activePlan: typeof raw.activePlan === 'string' ? raw.activePlan : null,
      muted: raw.muted === true,
      scale: Number.isFinite(raw.scale) && raw.scale > 0 ? raw.scale : null,
    };
  } catch {
    // Missing or malformed config: start fresh rather than fail.
    return { ...DEFAULTS };
  }
}

function writeConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[typewriter] could not write config:', err.message);
    return false;
  }
}

function fallbackRecordsDir() {
  let base;
  try {
    base = app.getPath('documents');
  } catch {
    base = app.getPath('userData');
  }
  return path.join(base, 'Typewriter');
}

/**
 * Resolve the records directory, prompting once on first run.
 * Cancelling the picker falls back to <Documents>/Typewriter so the app stays usable.
 */
async function resolveRecordsDir(cfg, parentWindow) {
  if (cfg.recordsDir) {
    try {
      fs.mkdirSync(cfg.recordsDir, { recursive: true });
      return cfg.recordsDir;
    } catch (err) {
      console.error('[typewriter] records dir unusable, re-picking:', err.message);
    }
  }

  let chosen = null;
  try {
    const res = await dialog.showOpenDialog(parentWindow || null, {
      title: 'Typewriter — where should your plans be kept?',
      message: 'Typewriter copies imported plans here, alongside progress files and session notes.',
      buttonLabel: 'Keep records here',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: fallbackRecordsDir(),
    });
    if (!res.canceled && res.filePaths && res.filePaths[0]) chosen = res.filePaths[0];
  } catch (err) {
    console.error('[typewriter] folder picker failed:', err.message);
  }

  const dir = chosen || fallbackRecordsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error('[typewriter] could not create records dir:', err.message);
  }
  cfg.recordsDir = dir;
  writeConfig(cfg);
  return dir;
}

module.exports = {
  DEFAULTS,
  configPath,
  readConfig,
  writeConfig,
  resolveRecordsDir,
  fallbackRecordsDir,
};
