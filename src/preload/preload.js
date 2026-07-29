'use strict';

// Narrow IPC surface. The renderer gets these seven calls and nothing else.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('typewriter', {
  /** Resolve records dir (picker on first run) and restore the active plan. */
  init: () => ipcRenderer.invoke('tw:init'),

  importFile: (filePath) => ipcRenderer.invoke('tw:import-file', filePath),
  importText: (text) => ipcRenderer.invoke('tw:import-text', text),

  toggle: (index, done) => ipcRenderer.invoke('tw:toggle', { index, done }),

  /** Append an optional session note, keep the records, clear the active pointer. */
  complete: (note) => ipcRenderer.invoke('tw:complete', note),

  /** action: 'log' | 'discard' */
  abort: (action, doneCount, total) => ipcRenderer.invoke('tw:abort', { action, doneCount, total }),

  setMuted: (muted) => ipcRenderer.send('tw:set-muted', muted),
  resize: (height) => ipcRenderer.send('tw:resize', height),

  /** dir: +1 bigger, -1 smaller, 0 automatic. Resolves to the new scale. */
  setScale: (dir) => ipcRenderer.invoke('tw:set-scale', dir),

  /** Electron removed File.path; this is the supported replacement. */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },
});
