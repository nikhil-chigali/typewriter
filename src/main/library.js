'use strict';

// The records folder: plans and their .progress.json sidecars.
//
// Deliberately free of Electron so it can be exercised directly under
// `node --test`. Every function takes explicit paths.

const fs = require('fs');
const path = require('path');
const md = require('./markdown');

/** Refuse to touch anything outside the records directory. */
function isInside(dir, target) {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** `plan.md` -> `plan.progress.json` */
function sidecarPath(planPath) {
  const dir = path.dirname(planPath);
  const base = path.basename(planPath).replace(/\.md$/i, '');
  return path.join(dir, `${base}.progress.json`);
}

/** Free path for `<base><ext>` inside dir, adding a timestamp on collision. */
function freePath(dir, base, ext, now = new Date()) {
  let candidate = path.join(dir, base + ext);
  if (!fs.existsSync(candidate) && !fs.existsSync(sidecarPath(candidate))) return candidate;

  candidate = path.join(dir, `${base}-${md.fileStamp(now)}${ext}`);
  let n = 2;
  while (fs.existsSync(candidate) || fs.existsSync(sidecarPath(candidate))) {
    candidate = path.join(dir, `${base}-${md.fileStamp(now)}-${n++}${ext}`);
  }
  return candidate;
}

function readSidecar(planPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(sidecarPath(planPath), 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.tasks || typeof raw.tasks !== 'object') return null;
    return raw;
  } catch {
    return null; // Missing or malformed sidecar: fall back to the Markdown.
  }
}

function writeSidecar(planPath, items) {
  const tasks = {};
  items.forEach((item, i) => {
    tasks[String(i)] = { done: !!item.done, at: item.done ? item.at || new Date().toISOString() : null };
  });
  const payload = { plan: planPath, count: items.length, tasks };
  try {
    fs.writeFileSync(sidecarPath(planPath), JSON.stringify(payload, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[typewriter] could not write sidecar:', err.message);
    return false;
  }
}

/**
 * Load a stored plan. The sidecar is authoritative for done-state; where it and the
 * Markdown disagree (or the counts differ) the Markdown fills the gaps and the
 * sidecar is rewritten to match.
 * @returns {{path, name, title, items}|null}
 */
function loadPlan(planPath) {
  let text;
  try {
    text = fs.readFileSync(planPath, 'utf8');
  } catch {
    return null;
  }

  const parsed = md.parsePlan(text);
  if (!parsed) return null;

  const side = readSidecar(planPath);
  let drifted = false;

  parsed.items.forEach((item, i) => {
    const rec = side && side.tasks[String(i)];
    if (rec && typeof rec.done === 'boolean') {
      if (rec.done !== item.done) drifted = true;
      item.done = rec.done;
      item.at = typeof rec.at === 'string' ? rec.at : null;
    } else {
      drifted = true;
      item.at = null;
    }
  });

  if (!side || drifted || Number(side.count) !== parsed.items.length) {
    writeSidecar(planPath, parsed.items);
    syncMarkdownToItems(planPath, parsed.items);
  }

  return {
    path: planPath,
    name: path.basename(planPath),
    title: parsed.title,
    items: parsed.items,
  };
}

/** Push sidecar truth back into the stored Markdown checkboxes. */
function syncMarkdownToItems(planPath, items) {
  try {
    let text = fs.readFileSync(planPath, 'utf8');
    const total = md.countTasks(text);
    for (let i = 0; i < Math.min(total, items.length); i++) {
      const res = md.setTask(text, i, items[i].done);
      if (res) text = res.text;
    }
    fs.writeFileSync(planPath, text, 'utf8');
  } catch (err) {
    console.error('[typewriter] could not sync markdown:', err.message);
  }
}

module.exports = {
  isInside,
  sidecarPath,
  freePath,
  readSidecar,
  writeSidecar,
  loadPlan,
  syncMarkdownToItems,
};
