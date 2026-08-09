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

/**
 * Write the sidecar. `meta` may carry { title, touchedAt, archived }; anything
 * omitted is preserved from the sidecar already on disk, so a routine toggle
 * never clears the title or un-archives a plan.
 */
function writeSidecar(planPath, items, meta = {}) {
  const prev = readSidecar(planPath) || {};

  const tasks = {};
  items.forEach((item, i) => {
    tasks[String(i)] = { done: !!item.done, at: item.done ? item.at || new Date().toISOString() : null };
  });

  const payload = {
    plan: planPath,
    title: meta.title ?? prev.title ?? null,
    touchedAt: meta.touchedAt ?? prev.touchedAt ?? new Date().toISOString(),
    archived: meta.archived ?? (prev.archived === true),
    count: items.length,
    tasks,
  };

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

  // Sidecars written before the shelf existed lack these three fields.
  const needsUpgrade = !side || !side.title || !side.touchedAt || side.archived === undefined;

  let touchedAt = side && side.touchedAt;
  if (!touchedAt) {
    // Best available proxy for "when was this last worked on".
    try {
      touchedAt = fs.statSync(sidecarPath(planPath)).mtime.toISOString();
    } catch {
      touchedAt = new Date().toISOString();
    }
  }

  if (needsUpgrade || drifted || Number(side && side.count) !== parsed.items.length) {
    writeSidecar(planPath, parsed.items, {
      title: parsed.title,
      touchedAt,
      archived: (side && side.archived) === true,
    });
    syncMarkdownToItems(planPath, parsed.items);
  }

  return {
    path: planPath,
    name: path.basename(planPath),
    title: parsed.title,
    items: parsed.items,
  };
}

/**
 * Push sidecar truth back into the stored Markdown checkboxes.
 *
 * The `(done …)` stamps in the Markdown are the user's history — the sheet they
 * read in their own editor — so a sync rewrites as little as possible: lines that
 * already agree are left byte-for-byte alone, a line that really does flip is
 * stamped with the completion time the sidecar recorded rather than "now", and
 * the file is not written at all when nothing changed.
 */
function syncMarkdownToItems(planPath, items) {
  try {
    const original = fs.readFileSync(planPath, 'utf8');
    let text = original;

    const parsed = md.parsePlan(text);
    const onDisk = parsed ? parsed.items : null;
    const total = md.countTasks(text);

    for (let i = 0; i < Math.min(total, items.length); i++) {
      const want = !!items[i].done;
      if (onDisk && onDisk[i] && onDisk[i].done === want) continue;

      const at = want && items[i].at ? new Date(items[i].at) : null;
      const when = at && !Number.isNaN(at.getTime()) ? at : new Date();
      const res = md.setTask(text, i, want, when);
      if (res) text = res.text;
    }

    // A pointless rewrite still bumps the mtime, which makes the sidecar look
    // stale and re-triggers the freshness fallback on every later listing.
    if (text === original) return;

    fs.writeFileSync(planPath, text, 'utf8');
    markSidecarCurrent(planPath);
  } catch (err) {
    console.error('[typewriter] could not sync markdown:', err.message);
  }
}

/**
 * Stamp the sidecar as current with respect to its markdown. The sidecar is
 * always written first so it survives a crash mid-pair, which leaves it
 * looking older than the markdown the instant that markdown write lands;
 * this re-marks it once the pair is consistent, so listing can keep
 * trusting the cache instead of taking the re-parse fallback forever.
 */
function markSidecarCurrent(planPath) {
  try {
    const now = new Date();
    fs.utimesSync(sidecarPath(planPath), now, now);
  } catch {
    // Best effort: worst case the plan just falls back to re-parsing next time.
  }
}

/**
 * The sidecar's cached count/tasks are only trustworthy if they were written
 * at or after the markdown's last change. Users edit these .md files by hand,
 * so a stale cache is a realistic case, not a corner case.
 */
function isSidecarFresh(planPath) {
  try {
    const planStat = fs.statSync(planPath);
    const sideStat = fs.statSync(sidecarPath(planPath));
    return sideStat.mtimeMs >= planStat.mtimeMs;
  } catch {
    return false; // Can't prove the cache is current, so don't trust it.
  }
}

/** Summarise one stored plan for the shelf, or null if it is not a usable plan. */
function summarise(planPath, activePlan) {
  const side = readSidecar(planPath);
  const fresh = !!side && isSidecarFresh(planPath);

  let title = fresh ? side.title : null;
  // A non-positive or non-integer count is as unusable as a missing one —
  // trusting it would silently hide a real plan behind a false "no tasks".
  let total = fresh && Number.isInteger(side.count) && side.count > 0 ? side.count : null;
  let done = null;

  if (fresh && side.tasks && total !== null) {
    done = Object.values(side.tasks).filter((t) => t && t.done).length;
  }

  // No usable sidecar (missing, stale, pre-upgrade, or a bad count): read the
  // markdown itself. Deliberately not loadPlan — that upgrades the sidecar and
  // syncs the markdown, and merely listing a shelf full of plans must never
  // write to the user's files. Adoption happens when a plan is opened.
  if (!title || total === null || done === null) {
    let parsed = null;
    try {
      parsed = md.parsePlan(fs.readFileSync(planPath, 'utf8'));
    } catch {
      return null; // Unreadable file: not a plan we can show.
    }
    if (!parsed) return null;

    if (!title) title = parsed.title;
    if (total === null || done === null) {
      total = parsed.items.length;
      done = parsed.items.filter((i) => i.done).length;
    }
  }

  if (!total) return null; // A plan with no tasks is not a plan.

  // touchedAt is a cached "last worked on" marker, not derived from the
  // markdown, so staleness doesn't apply — but a corrupted value would still
  // poison the sort (Date.parse -> NaN), so treat unparseable the same as absent.
  let touchedAt = side && side.touchedAt;
  if (!touchedAt || Number.isNaN(Date.parse(touchedAt))) {
    try {
      touchedAt = fs.statSync(planPath).mtime.toISOString();
    } catch {
      touchedAt = new Date(0).toISOString();
    }
  }

  const archived = !!(side && side.archived);
  const complete = done === total;

  return {
    path: planPath,
    title,
    done,
    total,
    complete,
    archived,
    finished: complete || archived,
    touchedAt,
    active: activePlan ? path.resolve(activePlan) === path.resolve(planPath) : false,
  };
}

/**
 * Every plan in the records folder, live ones first, each group ordered by
 * most recently touched. The folder is the source of truth: files that do not
 * parse are skipped, never removed.
 */
function listPlans(recordsDir, activePlan = null) {
  let names;
  try {
    names = fs.readdirSync(recordsDir).filter((n) => /\.md$/i.test(n));
  } catch {
    return []; // Unreadable folder yields an empty shelf, not an error.
  }

  const rows = [];
  for (const name of names) {
    try {
      const row = summarise(path.join(recordsDir, name), activePlan);
      if (row) rows.push(row);
    } catch (err) {
      console.error('[typewriter] skipping', name, err.message);
    }
  }

  rows.sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? 1 : -1;
    return Date.parse(b.touchedAt) - Date.parse(a.touchedAt);
  });
  return rows;
}

/** Mark a plan abandoned (or revive it). Task state is untouched. */
function setArchived(planPath, archived) {
  const plan = loadPlan(planPath);
  if (!plan) return false;
  return writeSidecar(planPath, plan.items, { title: plan.title, archived: !!archived });
}

/** Stamp a plan as worked on just now, floating it to the top of the shelf. */
function touchPlan(planPath) {
  const plan = loadPlan(planPath);
  if (!plan) return false;
  return writeSidecar(planPath, plan.items, {
    title: plan.title,
    touchedAt: new Date().toISOString(),
  });
}

module.exports = {
  isInside,
  sidecarPath,
  freePath,
  readSidecar,
  writeSidecar,
  loadPlan,
  syncMarkdownToItems,
  markSidecarCurrent,
  listPlans,
  setArchived,
  touchPlan,
};
