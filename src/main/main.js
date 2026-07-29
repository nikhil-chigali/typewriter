'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const md = require('./markdown');
const store = require('./records');

// The design is authored at 420x720 (focused) / 420x950 (list) CSS pixels.
// `scale` blows that up via the page zoom factor, so the artwork keeps its
// proportions and stays pixel-crisp — only the device size changes.
const WIDTH = 420;
const H_FOCUSED = 720;
const H_LIST = 950;
const SCALES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];

let win = null;
let cfg = store.readConfig();
let recordsDir = null;
let scale = 1;
let baseHeight = H_FOCUSED;

/** How large we can go before the focused window stops fitting on screen. */
function screenCap(display) {
  return Math.min(display.workAreaSize.height / H_FOCUSED, display.workAreaSize.width / WIDTH);
}

/**
 * A readable default for this display. A 7px font on a scaleFactor-1 monitor is
 * seven actual pixels, so aim for roughly 2x apparent size and back off if the
 * OS is already scaling or the screen is short.
 */
function autoScale(display) {
  const cap = screenCap(display);
  const readable = 2.25 / (display.scaleFactor || 1);
  let best = SCALES[0];
  for (const s of SCALES) if (s <= cap && s <= readable) best = s;
  return best;
}

function currentDisplay() {
  return win && !win.isDestroyed()
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getPrimaryDisplay();
}

/** Resize to the current base height at the current scale, never past the screen. */
function applyBounds() {
  if (!win || win.isDestroyed()) return;
  const wa = currentDisplay().workAreaSize;
  const w = Math.min(Math.round(WIDTH * scale), wa.width);
  const h = Math.min(Math.round(baseHeight * scale), wa.height);

  // `resizable: false` blocks programmatic resizing on Windows; toggle around it.
  win.setResizable(true);
  win.setContentSize(w, h, false);
  win.setResizable(false);
}

function applyScale() {
  if (!win || win.isDestroyed()) return;
  win.webContents.setZoomFactor(scale);
  applyBounds();
}

function createWindow() {
  win = new BrowserWindow({
    width: WIDTH,
    height: H_FOCUSED,
    useContentSize: true,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    show: false,
    title: 'Typewriter',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // An always-on-top widget is usually unfocused; keep its timers running.
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Zoom must be re-applied per load, and re-clamped when dragged to another screen.
  win.webContents.on('did-finish-load', applyScale);
  win.on('moved', applyBounds);
  win.once('ready-to-show', () => win.show());

  // Keep every navigation inside the app; open real links in the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function setHeight(height) {
  baseHeight = height === H_LIST ? H_LIST : H_FOCUSED;
  applyBounds();
}

function saveConfig() {
  store.writeConfig({ recordsDir, activePlan: cfg.activePlan, muted: cfg.muted, scale });
}

function setActivePlan(planPath) {
  cfg.activePlan = planPath;
  saveConfig();
}

/** Shape a loaded plan for the renderer. */
function payload(plan) {
  return {
    path: plan.path,
    name: plan.name,
    title: plan.title,
    items: plan.items.map((it) => ({ text: it.text, done: !!it.done, at: it.at || null, section: it.section })),
  };
}

function fail(message) {
  return { ok: false, error: message };
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('tw:init', async () => {
  recordsDir = await store.resolveRecordsDir(cfg, win);
  scale = cfg.scale || autoScale(currentDisplay()); // First run picks a size that suits the display.
  applyScale();
  saveConfig();

  let plan = null;
  if (cfg.activePlan) {
    plan = store.loadPlan(cfg.activePlan);
    if (!plan) setActivePlan(null); // Stored plan vanished or went bad.
  }
  return { recordsDir, muted: !!cfg.muted, scale, plan: plan ? payload(plan) : null };
});

ipcMain.handle('tw:import-file', async (_e, filePath) => {
  try {
    if (typeof filePath !== 'string' || !/\.md$/i.test(filePath)) return fail('not a .md file');

    const text = fs.readFileSync(filePath, 'utf8');
    if (!md.parsePlan(text)) return fail('invalid plan');

    // Copy in. The external original is never touched.
    const ext = path.extname(filePath) || '.md';
    const base = path.basename(filePath, ext);
    const dest = store.freePath(recordsDir, base, ext);
    fs.copyFileSync(filePath, dest);

    const plan = store.loadPlan(dest);
    if (!plan) return fail('invalid plan');
    setActivePlan(dest);
    return { ok: true, plan: payload(plan) };
  } catch (err) {
    console.error('[typewriter] import-file:', err.message);
    return fail('could not read that file');
  }
});

ipcMain.handle('tw:import-text', async (_e, text) => {
  try {
    const parsed = md.parsePlan(text);
    if (!parsed) return fail('invalid plan');

    const dest = store.freePath(recordsDir, md.slugify(parsed.title), '.md');
    fs.writeFileSync(dest, String(text).replace(/\s+$/, '') + '\n', 'utf8');

    const plan = store.loadPlan(dest);
    if (!plan) return fail('invalid plan');
    setActivePlan(dest);
    return { ok: true, plan: payload(plan) };
  } catch (err) {
    console.error('[typewriter] import-text:', err.message);
    return fail('could not save that plan');
  }
});

ipcMain.handle('tw:toggle', async (_e, { index, done } = {}) => {
  try {
    const planPath = cfg.activePlan;
    if (!planPath || !store.isInside(recordsDir, planPath)) return fail('no active plan');

    const plan = store.loadPlan(planPath);
    if (!plan) return fail('plan unreadable');
    if (!Number.isInteger(index) || index < 0 || index >= plan.items.length) return fail('no such task');

    // Sidecar first — it is the authority on reopen.
    plan.items[index].done = !!done;
    plan.items[index].at = done ? new Date().toISOString() : null;
    if (!store.writeSidecar(planPath, plan.items)) return fail('could not save progress');

    const text = fs.readFileSync(planPath, 'utf8');
    const res = md.setTask(text, index, !!done);
    if (res) fs.writeFileSync(planPath, res.text, 'utf8');

    return { ok: true, at: plan.items[index].at };
  } catch (err) {
    console.error('[typewriter] toggle:', err.message);
    return fail('could not save progress');
  }
});

ipcMain.handle('tw:complete', async (_e, note) => {
  try {
    const planPath = cfg.activePlan;
    if (planPath && store.isInside(recordsDir, planPath) && typeof note === 'string' && note.trim()) {
      const text = fs.readFileSync(planPath, 'utf8');
      const block = `**session note (${md.stamp()}):** ${note.trim()}`;
      fs.writeFileSync(planPath, md.appendBlock(text, block), 'utf8');
    }
  } catch (err) {
    console.error('[typewriter] complete:', err.message);
  }
  setActivePlan(null); // Plan and sidecar are kept either way.
  return { ok: true };
});

ipcMain.handle('tw:abort', async (_e, { action, doneCount, total } = {}) => {
  const planPath = cfg.activePlan;
  try {
    if (planPath && store.isInside(recordsDir, planPath)) {
      if (action === 'log') {
        const text = fs.readFileSync(planPath, 'utf8');
        const block = `**aborted (${md.stamp()}):** ${doneCount || 0}/${total || 0} done`;
        fs.writeFileSync(planPath, md.appendBlock(text, block), 'utf8');
      } else if (action === 'discard') {
        // Only ever inside the records directory.
        fs.rmSync(planPath, { force: true });
        fs.rmSync(store.sidecarPath(planPath), { force: true });
      }
    }
  } catch (err) {
    console.error('[typewriter] abort:', err.message);
  }
  setActivePlan(null);
  return { ok: true };
});

ipcMain.on('tw:set-muted', (_e, muted) => {
  cfg.muted = !!muted;
  saveConfig();
});

ipcMain.on('tw:resize', (_e, height) => setHeight(Number(height)));

/** dir: +1 bigger, -1 smaller, 0 back to the automatic size for this display. */
ipcMain.handle('tw:set-scale', (_e, dir) => {
  if (dir === 0) {
    scale = autoScale(currentDisplay());
  } else {
    let nearest = 0;
    SCALES.forEach((s, i) => {
      if (Math.abs(s - scale) < Math.abs(SCALES[nearest] - scale)) nearest = i;
    });
    const next = Math.min(SCALES.length - 1, Math.max(0, nearest + (dir > 0 ? 1 : -1)));
    scale = SCALES[next];
  }
  applyScale();
  saveConfig();
  return scale;
});

// ---------------------------------------------------------------- lifecycle

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
