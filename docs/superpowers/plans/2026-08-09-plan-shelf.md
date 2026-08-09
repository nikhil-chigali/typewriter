# Plan Shelf Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Typewriter hold many plans and switch between them from a "shelf" view on the paper, ordered by what you worked on most recently.

**Architecture:** The records folder stays the single source of truth — no index file. `src/main/records.js` splits into `config.js` (all Electron dependency: `config.json`, records-dir picker) and `library.js` (pure Node: plan and sidecar IO, listing, archiving). That split is what makes the listing and migration logic unit-testable under `node --test`. The sidecar gains three optional fields (`title`, `touchedAt`, `archived`) with silent migration. The shelf is a third renderer view alongside `focused` and `list`.

**Tech Stack:** Electron 43, plain CommonJS, no runtime dependencies. Tests use the built-in `node:test` runner and `node:assert` — no new packages. UI verification uses the existing CDP harness pattern.

**Spec:** [docs/superpowers/specs/2026-08-09-plan-shelf-design.md](../specs/2026-08-09-plan-shelf-design.md)

## Global Constraints

- **No new dependencies.** Not runtime, not dev. `node:test` and `node:assert` are built in.
- **`library.js` must never `require('electron')`.** Every function takes explicit paths. This is what keeps it testable.
- **Colours** (already CSS variables): red `#C1443C`, cream `#F5EDE0`, ink `#222`, borders `#111`, muted `#888`.
- **Window sizes:** focused `420×720`, list `420×950`. The shelf uses the **focused** size — it must never resize to 950.
- **Paper caps:** focused `min(320px, calc(100vh - var(--tw-h) - 6px))`, list `min(520px, …)`. The shelf uses the focused cap.
- **Font sizes stay tiny:** 7px titles, 6px body, 5px section labels. Shelf rows use 6px, its group labels 5px.
- **No gradients, shadows, or rounded corners** except the existing circular keys and the 12px spacebar radius.
- **Stepped animations only** — `steps(n, end)`. Never rely on `requestAnimationFrame` or CSS transitions for state changes; the window is often occluded and gets no frames. Use timers. (This bug was fixed once already; do not reintroduce it.)
- **Deletion is guarded.** Nothing outside the records directory may ever be deleted. `isInside()` gates every destructive path.
- **Never modify the user's external source files.** Imports copy into the records folder.
- **Commit after every task.**

---

### Task 1: Split `records.js`, add the test runner

Pure refactor. No behaviour change. This exists to make everything after it testable.

**Files:**
- Create: `src/main/config.js`
- Create: `src/main/library.js`
- Create: `test/library.test.js`
- Delete: `src/main/records.js`
- Modify: `src/main/main.js` (imports at top, and every `store.*` call)
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Consumes: `src/main/markdown.js` — unchanged, exports `parsePlan`, `setTask`, `countTasks`, `appendBlock`, `slugify`, `stamp`, `fileStamp`.
- Produces:
  - `config.js`: `readConfig()`, `writeConfig(cfg)`, `resolveRecordsDir(cfg, win)`, `fallbackRecordsDir()`, `configPath()`, `DEFAULTS`
  - `library.js`: `isInside(dir, target)`, `sidecarPath(planPath)`, `freePath(dir, base, ext, now?)`, `readSidecar(planPath)`, `writeSidecar(planPath, items, meta?)`, `loadPlan(planPath)`, `syncMarkdownToItems(planPath, items)`

- [ ] **Step 1: Add the test script**

In `package.json`, add to `scripts`:

```json
"test": "node --test \"test/*.test.js\""
```

Two forms that look right are wrong here. `node --test test/` (a bare directory
argument) fails on Node 24 / Windows with an opaque `'test failed'` before
running anything. Bare `node --test` works, but its default discovery includes
`**/test/**/*.js`, which would sweep up the CDP harness added in Task 7 and
launch a real window during the unit run. The quoted glob matches only direct
`*.test.js` children; Node expands it itself, so it behaves the same whichever
shell npm uses.

- [ ] **Step 2: Write the failing test**

Create `test/library.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = require('../src/main/library');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tw-test-'));
}

function writePlan(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

const PLAN = '# Sample Plan\n\n## Only\n- [ ] alpha\n- [x] beta (done 2026-01-01 09:00)\n';

test('library does not pull in electron', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'library.js'), 'utf8');
  assert.ok(!/require\(['"]electron['"]\)/.test(src), 'library.js must stay free of electron');
});

test('isInside refuses paths outside the records folder', () => {
  const dir = 'C:/records';
  assert.equal(lib.isInside(dir, 'C:/records/a.md'), true);
  assert.equal(lib.isInside(dir, 'C:/records/sub/a.md'), true);
  assert.equal(lib.isInside(dir, 'C:/records'), false);
  assert.equal(lib.isInside(dir, 'C:/records/../evil.md'), false);
  assert.equal(lib.isInside(dir, 'C:/other/a.md'), false);
});

test('sidecarPath sits beside the plan', () => {
  assert.equal(
    path.basename(lib.sidecarPath(path.join('x', 'my-plan.md'))),
    'my-plan.progress.json'
  );
});

test('freePath adds a timestamp when the name is taken', () => {
  const dir = tmpDir();
  const first = lib.freePath(dir, 'plan', '.md');
  assert.equal(path.basename(first), 'plan.md');
  fs.writeFileSync(first, 'x');
  const second = lib.freePath(dir, 'plan', '.md');
  assert.notEqual(path.basename(second), 'plan.md');
  assert.match(path.basename(second), /^plan-\d{8}-\d{6}\.md$/);
});

test('loadPlan reads a plan and writes its sidecar', () => {
  const dir = tmpDir();
  const p = writePlan(dir, 'sample.md', PLAN);
  const plan = lib.loadPlan(p);

  assert.equal(plan.title, 'Sample Plan');
  assert.equal(plan.items.length, 2);
  assert.equal(plan.items[0].done, false);
  assert.equal(plan.items[1].done, true);
  assert.equal(plan.items[1].text, 'beta', 'the (done …) stamp is stripped for display');
  assert.ok(fs.existsSync(lib.sidecarPath(p)));
});

test('the sidecar wins over the markdown when they disagree', () => {
  const dir = tmpDir();
  const p = writePlan(dir, 'sample.md', PLAN);
  lib.loadPlan(p);

  const side = JSON.parse(fs.readFileSync(lib.sidecarPath(p), 'utf8'));
  side.tasks['0'] = { done: true, at: '2026-01-02T00:00:00.000Z' };
  fs.writeFileSync(lib.sidecarPath(p), JSON.stringify(side), 'utf8');

  const plan = lib.loadPlan(p);
  assert.equal(plan.items[0].done, true);
  assert.match(fs.readFileSync(p, 'utf8'), /- \[x\] alpha/, 'markdown is synced to match');
});

test('loadPlan returns null for something that is not a plan', () => {
  const dir = tmpDir();
  const p = writePlan(dir, 'notes.md', 'just some prose, no title, no tasks\n');
  assert.equal(lib.loadPlan(p), null);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/main/library'`

- [ ] **Step 4: Create `src/main/config.js`**

Move the config and records-directory half of `records.js` here verbatim. This is the only one of the two files allowed to touch Electron.

```js
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
```

- [ ] **Step 5: Create `src/main/library.js`**

Move the plan-storage half here. Copy `isInside`, `sidecarPath`, `freePath`, `readSidecar`, `writeSidecar`, `loadPlan`, and `syncMarkdownToItems` from `records.js` **unchanged** apart from the header comment and the `require` of `markdown.js` (`./markdown` stays correct — same directory). Do **not** add the new sidecar fields yet; that is Task 2.

```js
'use strict';

// The records folder: plans and their .progress.json sidecars.
//
// Deliberately free of Electron so it can be exercised directly under
// `node --test`. Every function takes explicit paths.

const fs = require('fs');
const path = require('path');
const md = require('./markdown');

// … isInside, sidecarPath, freePath, readSidecar, writeSidecar,
// … loadPlan, syncMarkdownToItems — copied verbatim from records.js

module.exports = {
  isInside,
  sidecarPath,
  freePath,
  readSidecar,
  writeSidecar,
  loadPlan,
  syncMarkdownToItems,
};
```

- [ ] **Step 6: Delete `records.js` and update `main.js`**

```bash
git rm src/main/records.js
```

In `src/main/main.js`, replace the single import:

```js
const store = require('./records');
```

with:

```js
const cfgStore = require('./config');
const lib = require('./library');
```

Then update each call site. Eight distinct functions are called, across **14 occurrences** — several are called more than once. Match on the call expression, not on a line number, and finish by confirming `grep -n "store\." src/main/main.js` prints nothing. First occurrence of each:

| Line | Was | Becomes |
|---|---|---|
| 18 | `store.readConfig()` | `cfgStore.readConfig()` |
| 113 | `store.writeConfig(…)` | `cfgStore.writeConfig(…)` |
| 138 | `store.resolveRecordsDir(cfg, win)` | `cfgStore.resolveRecordsDir(cfg, win)` |
| 145 | `store.loadPlan(…)` | `lib.loadPlan(…)` |
| 161 | `store.freePath(…)` | `lib.freePath(…)` |
| 195 | `store.isInside(…)` | `lib.isInside(…)` |
| 204 | `store.writeSidecar(…)` | `lib.writeSidecar(…)` |
| 243 | `store.sidecarPath(…)` | `lib.sidecarPath(…)` |

Verify none remain: `grep -n "store\." src/main/main.js` must print nothing.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 7 tests, 0 failures.

- [ ] **Step 8: Verify the app still runs unchanged**

Run: `npm start`
Expected: the typewriter opens, an existing plan restores, toggling a task still updates both the sidecar and the markdown. Close it.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Split records.js into config.js and library.js

library.js is now free of Electron and takes explicit paths, so the plan and
sidecar logic can be exercised directly under node --test. Adds the first
tests, covering the path guard, filename collisions, and sidecar authority.

Pure refactor: no behaviour change."
```

---

### Task 2: Sidecar gains `title`, `touchedAt`, `archived`

**Files:**
- Modify: `src/main/library.js` (`writeSidecar`, `loadPlan`)
- Modify: `test/library.test.js` (append)

**Interfaces:**
- Consumes: `lib.readSidecar`, `lib.sidecarPath`, `lib.loadPlan` from Task 1.
- Produces: `writeSidecar(planPath, items, meta = {})` where `meta` is `{ title?, touchedAt?, archived? }`. Unsupplied fields are preserved from the existing sidecar; absent there, they default to the parsed title, now, and `false`.

- [ ] **Step 1: Write the failing tests**

Append to `test/library.test.js`:

```js
test('a fresh sidecar carries title, touchedAt and archived', () => {
  const dir = tmpDir();
  const p = writePlan(dir, 'sample.md', PLAN);
  lib.loadPlan(p);

  const side = JSON.parse(fs.readFileSync(lib.sidecarPath(p), 'utf8'));
  assert.equal(side.title, 'Sample Plan');
  assert.equal(side.archived, false);
  assert.ok(!Number.isNaN(Date.parse(side.touchedAt)), 'touchedAt is an ISO date');
});

test('an old three-field sidecar is upgraded without losing progress', () => {
  const dir = tmpDir();
  const p = writePlan(dir, 'sample.md', PLAN);

  // The shape shipped before this feature.
  fs.writeFileSync(lib.sidecarPath(p), JSON.stringify({
    plan: p,
    count: 2,
    tasks: { 0: { done: true, at: '2026-01-05T10:00:00.000Z' }, 1: { done: false, at: null } },
  }), 'utf8');

  const plan = lib.loadPlan(p);
  assert.equal(plan.items[0].done, true, 'progress survives the upgrade');
  assert.equal(plan.items[1].done, false);

  const side = JSON.parse(fs.readFileSync(lib.sidecarPath(p), 'utf8'));
  assert.equal(side.title, 'Sample Plan');
  assert.equal(side.archived, false);
  assert.ok(!Number.isNaN(Date.parse(side.touchedAt)));
});

test('writeSidecar preserves archived unless told otherwise', () => {
  const dir = tmpDir();
  const p = writePlan(dir, 'sample.md', PLAN);
  const plan = lib.loadPlan(p);

  lib.writeSidecar(p, plan.items, { archived: true });
  assert.equal(JSON.parse(fs.readFileSync(lib.sidecarPath(p), 'utf8')).archived, true);

  // A later toggle must not silently un-archive the plan.
  lib.writeSidecar(p, plan.items);
  assert.equal(JSON.parse(fs.readFileSync(lib.sidecarPath(p), 'utf8')).archived, true);
});

test('touchedAt moves forward when a task is toggled', () => {
  const dir = tmpDir();
  const p = writePlan(dir, 'sample.md', PLAN);
  const plan = lib.loadPlan(p);

  lib.writeSidecar(p, plan.items, { touchedAt: '2020-01-01T00:00:00.000Z' });
  lib.writeSidecar(p, plan.items, { touchedAt: new Date().toISOString() });

  const side = JSON.parse(fs.readFileSync(lib.sidecarPath(p), 'utf8'));
  assert.ok(Date.parse(side.touchedAt) > Date.parse('2020-01-01T00:00:00.000Z'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `side.title` is `undefined`.

- [ ] **Step 3: Rewrite `writeSidecar` in `library.js`**

```js
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
```

- [ ] **Step 4: Teach `loadPlan` to migrate**

Inside `loadPlan`, after the existing `parsed.items.forEach(...)` merge loop and before the existing `if (!side || drifted || …)` block, decide whether a migration is needed:

```js
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
```

Then replace the existing rewrite condition with:

```js
  if (needsUpgrade || drifted || Number(side && side.count) !== parsed.items.length) {
    writeSidecar(planPath, parsed.items, {
      title: parsed.title,
      touchedAt,
      archived: (side && side.archived) === true,
    });
    syncMarkdownToItems(planPath, parsed.items);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 11 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add title, touchedAt and archived to the sidecar

Caching the title means listing plans reads only small JSON files rather than
parsing every markdown file. touchedAt drives shelf ordering; archived marks a
plan abandoned, which cannot be derived from the checkboxes.

Sidecars written before this upgrade in place on first read, taking touchedAt
from the sidecar mtime, and keep their task state."
```

---

### Task 3: `listPlans()` — enumerate, order, group

**Files:**
- Modify: `src/main/library.js`
- Modify: `test/library.test.js` (append)

**Interfaces:**
- Consumes: `lib.loadPlan`, `lib.readSidecar`, `lib.sidecarPath` from Tasks 1–2.
- Produces: `listPlans(recordsDir, activePlan = null)` returning an array of
  `{ path, title, done, total, complete, archived, finished, touchedAt, active }`,
  sorted live-first then finished, each group by `touchedAt` descending.
  Note the naming: `done` is a **count**, `complete` means every task is done,
  and `finished` (`complete || archived`) is the grouping key.

- [ ] **Step 1: Write the failing tests**

Append to `test/library.test.js`:

```js
function seedPlan(dir, name, title, states, touchedAt, archived = false) {
  const body = `# ${title}\n\n## Only\n` +
    states.map((d, i) => `- [${d ? 'x' : ' '}] task ${i + 1}${d ? ' (done 2026-01-01 09:00)' : ''}`).join('\n') + '\n';
  const p = writePlan(dir, name, body);
  const plan = lib.loadPlan(p);
  lib.writeSidecar(p, plan.items, { title, touchedAt, archived });
  return p;
}

test('listPlans orders live plans by most recently touched', () => {
  const dir = tmpDir();
  seedPlan(dir, 'old.md', 'Old Stream', [false, false], '2026-01-01T00:00:00.000Z');
  seedPlan(dir, 'new.md', 'New Stream', [false, false], '2026-06-01T00:00:00.000Z');
  seedPlan(dir, 'mid.md', 'Mid Stream', [false, false], '2026-03-01T00:00:00.000Z');

  const rows = lib.listPlans(dir);
  assert.deepEqual(rows.map((r) => r.title), ['New Stream', 'Mid Stream', 'Old Stream']);
});

test('finished plans sort below live ones', () => {
  const dir = tmpDir();
  seedPlan(dir, 'done.md', 'All Done', [true, true], '2026-09-01T00:00:00.000Z');
  seedPlan(dir, 'gone.md', 'Abandoned', [true, false], '2026-08-01T00:00:00.000Z', true);
  seedPlan(dir, 'live.md', 'Still Going', [false, false], '2026-01-01T00:00:00.000Z');

  const rows = lib.listPlans(dir);
  assert.deepEqual(rows.map((r) => r.title), ['Still Going', 'All Done', 'Abandoned']);
  assert.deepEqual(rows.map((r) => r.finished), [false, true, true]);

  const complete = rows.find((r) => r.title === 'All Done');
  assert.equal(complete.complete, true);
  assert.equal(complete.archived, false);
  assert.equal(complete.done, 2);
  assert.equal(complete.total, 2);

  const abandoned = rows.find((r) => r.title === 'Abandoned');
  assert.equal(abandoned.complete, false, 'archived but not every task is ticked');
  assert.equal(abandoned.archived, true);
  assert.equal(abandoned.done, 1);
});

test('listPlans marks the active plan', () => {
  const dir = tmpDir();
  const a = seedPlan(dir, 'a.md', 'Alpha', [false], '2026-01-01T00:00:00.000Z');
  seedPlan(dir, 'b.md', 'Beta', [false], '2026-02-01T00:00:00.000Z');

  const rows = lib.listPlans(dir, a);
  assert.equal(rows.find((r) => r.title === 'Alpha').active, true);
  assert.equal(rows.find((r) => r.title === 'Beta').active, false);
});

test('listPlans adopts a bare .md that has no sidecar', () => {
  const dir = tmpDir();
  writePlan(dir, 'bare.md', '# Bare Plan\n\n- [ ] one\n- [x] two (done 2026-01-01 09:00)\n');

  const rows = lib.listPlans(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Bare Plan');
  assert.equal(rows[0].done, 1);
  assert.equal(rows[0].total, 2);
});

test('listPlans skips files that are not plans and never deletes them', () => {
  const dir = tmpDir();
  seedPlan(dir, 'good.md', 'Good', [false], '2026-01-01T00:00:00.000Z');
  const junk = writePlan(dir, 'notes.md', 'prose with no title and no tasks\n');

  const rows = lib.listPlans(dir);
  assert.deepEqual(rows.map((r) => r.title), ['Good']);
  assert.ok(fs.existsSync(junk), 'the unrecognised file is left alone');
});

test('listPlans returns an empty array for a missing folder', () => {
  assert.deepEqual(lib.listPlans(path.join(tmpDir(), 'nope')), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `lib.listPlans is not a function`

- [ ] **Step 3: Implement `listPlans`**

Add to `library.js` before `module.exports`:

```js
/** Summarise one stored plan for the shelf, or null if it is not a usable plan. */
function summarise(planPath, activePlan) {
  const side = readSidecar(planPath);

  let title = side && side.title;
  let total = side && Number.isInteger(side.count) ? side.count : null;
  let done = null;

  if (side && side.tasks && total !== null) {
    done = Object.values(side.tasks).filter((t) => t && t.done).length;
  }

  // No usable sidecar (or a pre-upgrade one): fall back to the markdown itself.
  if (!title || total === null || done === null) {
    const plan = loadPlan(planPath);
    if (!plan) return null;
    title = plan.title;
    total = plan.items.length;
    done = plan.items.filter((i) => i.done).length;
  }

  if (!total) return null; // A plan with no tasks is not a plan.

  let touchedAt = side && side.touchedAt;
  if (!touchedAt) {
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
```

Add `listPlans` to `module.exports`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 17 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add listPlans: enumerate, order and group stored plans

Live plans first, then finished ones, each group by most recently touched.
Reads sidecars rather than parsing markdown, falling back to the markdown for
plans that have no sidecar yet. Files that do not parse are skipped and left
untouched — the folder stays the source of truth."
```

---

### Task 4: Archiving, touching, and the IPC surface

**Files:**
- Modify: `src/main/library.js` (add `setArchived`, `touchPlan`)
- Modify: `src/main/main.js` (new handlers; `planCount` in `tw:init`; archive on abort; stamp on toggle)
- Modify: `src/preload/preload.js`
- Modify: `test/library.test.js` (append)

**Interfaces:**
- Consumes: `lib.listPlans`, `lib.writeSidecar`, `lib.loadPlan`, `lib.isInside` from Tasks 1–3.
- Produces:
  - `lib.setArchived(planPath, archived)` → `boolean`
  - `lib.touchPlan(planPath)` → `boolean`
  - IPC `tw:list-plans` → `{ ok, plans }`
  - IPC `tw:switch-plan` (planPath) → `{ ok, plan }` | `{ ok: false, error }`
  - `tw:init` additionally returns `planCount` (number)
  - Preload: `listPlans()`, `switchPlan(planPath)`

- [ ] **Step 1: Write the failing tests**

Append to `test/library.test.js`:

```js
test('setArchived flips the flag and keeps the task state', () => {
  const dir = tmpDir();
  const p = seedPlan(dir, 'a.md', 'Alpha', [true, false], '2026-01-01T00:00:00.000Z');

  assert.equal(lib.setArchived(p, true), true);
  let rows = lib.listPlans(dir);
  assert.equal(rows[0].archived, true);
  assert.equal(rows[0].finished, true);
  assert.equal(rows[0].done, 1, 'progress is untouched');

  lib.setArchived(p, false);
  rows = lib.listPlans(dir);
  assert.equal(rows[0].archived, false);
  assert.equal(rows[0].finished, false);
});

test('touchPlan floats a plan to the top of the shelf', () => {
  const dir = tmpDir();
  const a = seedPlan(dir, 'a.md', 'Alpha', [false], '2026-01-01T00:00:00.000Z');
  seedPlan(dir, 'b.md', 'Beta', [false], '2026-02-01T00:00:00.000Z');

  assert.deepEqual(lib.listPlans(dir).map((r) => r.title), ['Beta', 'Alpha']);
  lib.touchPlan(a);
  assert.deepEqual(lib.listPlans(dir).map((r) => r.title), ['Alpha', 'Beta']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `lib.setArchived is not a function`

- [ ] **Step 3: Implement `setArchived` and `touchPlan`**

Add to `library.js` and export both:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 19 tests, 0 failures.

- [ ] **Step 5: Add the IPC handlers in `main.js`**

Add beside the existing handlers:

```js
ipcMain.handle('tw:list-plans', async () => {
  try {
    return { ok: true, plans: lib.listPlans(recordsDir, cfg.activePlan) };
  } catch (err) {
    console.error('[typewriter] list-plans:', err.message);
    return { ok: true, plans: [] }; // An unreadable folder is an empty shelf.
  }
});

ipcMain.handle('tw:switch-plan', async (_e, planPath) => {
  try {
    if (typeof planPath !== 'string' || !lib.isInside(recordsDir, planPath)) return fail('no such plan');

    const plan = lib.loadPlan(planPath);
    if (!plan) return fail('plan unreadable');

    lib.touchPlan(planPath); // Whatever you open is now the most recent.
    setActivePlan(planPath);
    return { ok: true, plan: payload(lib.loadPlan(planPath)) };
  } catch (err) {
    console.error('[typewriter] switch-plan:', err.message);
    return fail('could not open that plan');
  }
});
```

- [ ] **Step 6: Return `planCount` from `tw:init`**

In the `tw:init` handler, replace the return statement with:

```js
  return {
    recordsDir,
    muted: !!cfg.muted,
    scale,
    planCount: lib.listPlans(recordsDir).length,
    plan: plan ? payload(plan) : null,
  };
```

- [ ] **Step 7: Stamp `touchedAt` on every toggle**

In the `tw:toggle` handler, the existing call is:

```js
    if (!lib.writeSidecar(planPath, plan.items)) return fail('could not save progress');
```

Replace with:

```js
    const saved = lib.writeSidecar(planPath, plan.items, {
      title: plan.title,
      touchedAt: new Date().toISOString(),
    });
    if (!saved) return fail('could not save progress');
```

- [ ] **Step 8: Archive on "log it"**

In the `tw:abort` handler, inside the `if (action === 'log')` branch, after the existing `fs.writeFileSync(planPath, md.appendBlock(text, block), 'utf8');` line, add:

```js
        lib.setArchived(planPath, true); // Abandoned plans sink into the done group.
```

- [ ] **Step 9: Widen the preload bridge**

In `src/preload/preload.js`, add inside the exposed object:

```js
  /** Every stored plan, live ones first. */
  listPlans: () => ipcRenderer.invoke('tw:list-plans'),

  /** Make a stored plan the active one. */
  switchPlan: (planPath) => ipcRenderer.invoke('tw:switch-plan', planPath),
```

- [ ] **Step 10: Verify the IPC surface from the running app**

Run `npm start`, open DevTools with `Ctrl+Shift+I`, and in the console:

```js
await window.typewriter.listPlans()
```

Expected: `{ ok: true, plans: [ … ] }` with one row per plan in your records folder, live ones first. Close the app.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "Add archive/touch and the shelf IPC surface

listPlans and switchPlan cross the bridge; tw:init now reports planCount so the
renderer can tell a first run from a launch with plans but none active.

Toggling a task stamps touchedAt, and aborting with 'log it' archives the plan
so it sinks into the done group instead of lingering among live work."
```

---

### Task 5: The shelf view — markup, styles, rendering

Read-only in this task: the shelf draws but clicking a row does nothing yet. That keeps rendering separately reviewable from the switching behaviour.

**Files:**
- Create: `src/renderer/shelf.js`
- Modify: `src/renderer/index.html` (shelf button, script tag)
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/app.js` (view state, button wiring, counter text)

**Interfaces:**
- Consumes: `window.typewriter.listPlans()` from Task 4.
- Produces: global `Shelf.render(host, plans, onPick)` — builds the shelf into
  `host` (the `#paper-body` element), calling `onPick(planPath)` when a row is
  clicked. Follows the existing `Sound` / `Fx` module pattern (an IIFE assigned
  to a `const`, loaded by a plain `<script>` tag).

- [ ] **Step 1: Add the button and script tag**

In `src/renderer/index.html`, inside `.status`, between the view and sound toggles:

```html
        <button id="shelf-toggle" type="button" title="Your plans">&#9636;</button>
```

And beside the other renderer scripts, **before** `app.js`:

```html
<script src="shelf.js"></script>
```

- [ ] **Step 2: Add the styles**

Append to `src/renderer/styles.css`, after the checklist block:

```css
/* ---------------------------------------------------------------- shelf */

.shelf-group {
  font-size: 5px;
  line-height: 1.6;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--red);
  border-top: 1px dotted var(--red);
  padding-top: 6px;
  margin: 10px 0 6px;
}

.shelf-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 0;
  font-size: 6px;
  line-height: 1.6;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.shelf-row .mark {
  flex: none;
  width: 6px;
  color: var(--red);
}

.shelf-row .name {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shelf-row .count {
  flex: none;
  color: var(--muted);
}

.shelf-row.finished .name { color: var(--muted); }
.shelf-row.active .name { color: var(--red); }
.shelf-row:hover .name { text-decoration: underline; }

.shelf-hint {
  font-size: 5px;
  line-height: 1.8;
  color: var(--muted);
  text-align: center;
  padding-top: 12px;
}
```

- [ ] **Step 3: Write `src/renderer/shelf.js`**

```js
'use strict';

// The shelf: every stored plan, live ones first, finished ones below a rule.

const Shelf = (() => {
  function groupLabel(text) {
    const el = document.createElement('div');
    el.className = 'shelf-group';
    el.textContent = text;
    return el;
  }

  function row(plan, onPick) {
    const el = document.createElement('div');
    el.className = 'shelf-row'
      + (plan.finished ? ' finished' : '')
      + (plan.active ? ' active' : '');
    el.dataset.path = plan.path;

    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = plan.active ? '▸' : '';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = plan.title;
    name.title = plan.title;

    const count = document.createElement('span');
    count.className = 'count';
    // complete wins over archived: a finished plan reads ✓ even if also archived.
    const badge = plan.complete ? ' ✓' : (plan.archived ? ' ✕' : '');
    count.textContent = `${plan.done}/${plan.total}${badge}`;

    el.append(mark, name, count);
    el.addEventListener('click', () => onPick(plan.path));
    return el;
  }

  /** Build the shelf into `host`. `onPick(path)` fires when a row is clicked. */
  function render(host, plans, onPick) {
    host.innerHTML = '';

    const live = plans.filter((p) => !p.finished);
    const finished = plans.filter((p) => p.finished);

    for (const p of live) host.appendChild(row(p, onPick));

    if (finished.length) {
      host.appendChild(groupLabel('done'));
      for (const p of finished) host.appendChild(row(p, onPick));
    }

    const hint = document.createElement('div');
    hint.className = 'shelf-hint';
    hint.textContent = plans.length
      ? 'drop a .md or paste to add'
      : 'no plans yet — drop a .md or paste';
    host.appendChild(hint);
  }

  return { render };
})();
```

- [ ] **Step 4: Wire the view into `app.js`**

Change the state comment and add the shelf element. In the `S` object, widen the mode comment:

```js
  mode: 'focused',   // 'focused' | 'list' | 'shelf'
```

Add a field to remember where to return to:

```js
  priorMode: 'focused',  // the view the shelf was opened from
```

Add to the `Object.assign(el, { … })` block in the startup handler:

```js
    shelf: document.getElementById('shelf-toggle'),
```

Add the toggle function beside `toggleMode`:

```js
async function toggleShelf() {
  if (S.mode === 'shelf') {
    // Leaving the shelf with nothing on the roller: feed the sheet back down
    // to the idle state rather than calling render(), which bails when there
    // is no plan and would strand the shelf on screen.
    if (!S.plan) {
      S.mode = 'focused';
      await lowerPaper();
      el.body.innerHTML = '';
      el.title.textContent = '';
      updateStatus();
      return;
    }
    S.mode = S.priorMode === 'list' ? 'list' : 'focused';
    api.resize(S.mode === 'list' ? H_LIST : H_FOCUSED);  // restore the list height
    render();
    return;
  }

  S.priorMode = S.mode;           // 'focused' or 'list' — never 'shelf' here
  S.mode = 'shelf';
  api.resize(H_FOCUSED);          // the shelf never grows the window
  await renderShelf();
}

async function renderShelf() {
  const res = await api.listPlans().catch(() => null);
  const plans = (res && res.plans) || [];
  el.paper.classList.remove('list', 'complete');
  el.paper.classList.remove('hidden');
  setPaperY(0);
  el.title.textContent = '··· YOUR PLANS ···';
  el.title.title = 'Your plans';
  Shelf.render(el.body, plans, onPickPlan);
  S.shelfCount = plans.length;
  updateStatus();
}

// Filled in by Task 6; drawing the shelf is reviewable on its own.
function onPickPlan(planPath) {
  console.log('[typewriter] pick', planPath);
}
```

Route the shelf away from the checklist builders. `render()` currently opens with `if (!S.plan) return;`, so the shelf line must go **above** that guard — otherwise the shelf never draws when no plan is loaded. The function must begin exactly like this:

```js
function render(opts) {
  if (S.mode === 'shelf') { renderShelf(); return; }   // must precede the !S.plan guard
  if (!S.plan) return;
  el.title.textContent = `··· ${S.plan.title} ···`;
  // … rest unchanged
```

`renderShelf()` is async and is deliberately not awaited here; `render()` is synchronous and its callers do not depend on the shelf being painted before they continue.

In `updateStatus()`, replace the counter line with:

```js
  if (S.mode === 'shelf') {
    const n = S.shelfCount || 0;
    el.counter.textContent = n === 0 ? 'no plans' : `${n} plan${n === 1 ? '' : 's'}`;
  } else {
    el.counter.textContent = `${doneCount()}/${items().length} done`;
  }
```

And guard the view toggle so the list button reflects the underlying view:

```js
  const list = S.mode === 'list';
```

stays as-is. Wire the button in `wire()`:

```js
  el.shelf.addEventListener('click', toggleShelf);
```

Add `shelfCount: 0` to the `S` object.

- [ ] **Step 5: Verify by eye**

Run `npm start`. Import two or three plans (drop `sample-plan.md`, then paste another). Press `▤`.

Expected: the paper shows `··· YOUR PLANS ···`, live plans listed with `done/total`, the active one marked `▸` in red, finished plans below a red dotted `done` rule, the counter reading `3 plans`, and the window still 420×720. Clicking a row logs to the console and does nothing else.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Draw the plan shelf

A third view on the paper, opened by a new status-bar button. Live plans first,
finished ones below a dotted rule, the active plan marked. Stays at the focused
window height rather than growing to the list height.

Rows are inert for now; switching lands next."
```

---

### Task 6: Switching, always-available import, completion into the shelf

**Files:**
- Modify: `src/renderer/app.js`

**Interfaces:**
- Consumes: `window.typewriter.switchPlan(path)` from Task 4; `Shelf.render` and `toggleShelf` from Task 5.
- Produces: no new exports; completes `onPickPlan`.

- [ ] **Step 1: Implement `onPickPlan`**

Replace the stub from Task 5:

```js
async function onPickPlan(planPath) {
  if (S.busy) return;
  // Already on the roller: just go back, restoring the height the prior view needs.
  // Opening the shelf always drops to H_FOCUSED, so returning to `list` without
  // resizing would render the full list clipped into a 720px window.
  if (S.plan && S.plan.path === planPath) {
    S.mode = S.priorMode === 'list' ? 'list' : 'focused';
    api.resize(S.mode === 'list' ? H_LIST : H_FOCUSED);
    render();
    return;
  }

  S.busy = true;
  const res = await api.switchPlan(planPath).catch(() => null);
  S.busy = false;

  if (!res || !res.ok) {
    flash("couldn't open that plan :(");
    return;
  }

  if (S.pending) clearTimeout(S.pending.timer);
  S.pending = null;

  await lowerPaper();          // feed the old sheet out…
  S.mode = 'focused';
  S.priorMode = 'focused';
  await openPlan(res.plan, { animate: true });   // …and print the new one
}
```

- [ ] **Step 2: Make drop and paste work while a plan is loaded**

In `wire()`, the drop handler currently begins:

```js
    if (S.plan) return;
```

Delete that line. Do the same for the `paste` handler's `S.plan ||` guard, so it reads:

```js
    if (isTyping(e.target)) return;
```

In the `dragover` handler, drop the `if (!S.plan)` condition so the dashed outline always shows:

```js
    el.tw.classList.add('dragover');
```

- [ ] **Step 3: Lower the sheet before printing an imported plan**

`importResult` currently calls `openPlan` directly, which would print the new sheet over the old one. Change it to:

```js
async function importResult(promise) {
  const res = await promise.catch(() => null);
  if (!res || !res.ok) {
    flash();
    return;
  }
  if (S.plan) await lowerPaper();   // feed the current sheet out first
  S.mode = 'focused';
  S.priorMode = 'focused';
  await openPlan(res.plan, { animate: true });
}
```

- [ ] **Step 4: Land in the shelf after completing a plan**

In `finish()`, replace the call to `resetToIdle()`:

```js
async function finish(note) {
  closeDialog();
  await api.complete(note).catch(() => null);
  await resetToIdle();
  await toggleShelf();     // "new plan" means "pick the next one"
}
```

Do the same in `abort()`, so aborting also lands in the shelf:

```js
async function abort(action) {
  closeDialog();
  await api.abort(action, doneCount(), items().length).catch(() => null);
  await resetToIdle();
  await toggleShelf();
}
```

Because `resetToIdle()` sets `S.mode = 'focused'`, `toggleShelf()` will open the shelf and remember `focused` as the prior view.

- [ ] **Step 5: Verify the whole flow by hand**

Run `npm start`, then:

1. Import two plans. Tick a task in plan A.
2. Press `▤`, click plan B. Expect: sheet feeds down, B prints, counter shows B's progress.
3. Press `▤` again — B is now top of the list and marked `▸`.
4. Click A. Expect: A returns **with its tick still there**.
5. With A loaded, drop a third `.md`. Expect: A feeds out, the new plan prints, and `▤` shows all three.
6. Finish a plan completely. Expect: confetti, popup, then "save + new plan" lands you in the shelf with that plan under `done` and a `✓`.
7. Press `Ctrl+C` on a live plan and choose "log it". Expect: it sinks under `done` with a `✕`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Switch between plans from the shelf

Clicking a row feeds the current sheet out and prints the chosen plan. Progress
survives because each plan already owns its sidecar, so a switch only moves the
pointer.

Drop and paste now work with a plan already loaded, importing and switching in
one go, and finishing or aborting a plan lands in the shelf rather than the
empty idle state."
```

---

### Task 7: Regression, harness coverage, and docs

**Files:**
- Create: `test/integration/shelf.cdp.js`
- Create: `test/shelf-integration.md` (what the harness does *not* cover)
- Modify: `package.json` (add `test:ui` script)
- Modify: `README.md`

Earlier verification in this project used throwaway CDP harnesses in a temp
directory; they have since been lost. This task rebuilds one as a committed,
repeatable artifact so the UI paths stay checkable after this change too.

- [ ] **Step 1: Run the unit tests**

Run: `npm test`
Expected: PASS — 19 tests, 0 failures.

- [ ] **Step 2: Add the `test:ui` script**

In `package.json`, add to `scripts`:

```json
"test:ui": "node test/integration/shelf.cdp.js"
```

`npm test` stays unit-only because Task 1 set it to `node --test "test/*.test.js"`,
which matches only direct `*.test.js` children of `test/`. Do not "simplify" it to
a bare `node --test` — that form's default discovery includes `**/test/**/*.js`
and would launch this harness's real window during the unit run. After adding the
script, confirm `npm test` still reports 19 tests and does not open a window.

- [ ] **Step 3: Write the CDP harness**

Create `test/integration/shelf.cdp.js`. It drives the real app over the Chrome
DevTools Protocol and exits non-zero on the first failed assertion.

```js
'use strict';

// Drives the real app over CDP and asserts the shelf behaves.
//   npm run test:ui
//
// Uses a throwaway user-data dir and records folder, so it never touches the
// caller's real config or plans. Pinned to scale 1 so geometry assertions are
// in CSS pixels.

const { spawn } = require('child_process');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.join(__dirname, '..', '..');
const ELECTRON = path.join(PROJECT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9422;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PLAN_A = '# Alpha Stream\n\n## Work\n- [ ] alpha one\n- [ ] alpha two\n';
const PLAN_B = '# Beta Stream\n\n## Work\n- [ ] beta one\n';

let child = null;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        return ws;
      }
    } catch { /* not up yet */ }
    await wait(400);
  }
  throw new Error('could not attach to the app over CDP');
}

function rpc(ws) {
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg.result); }
  };
  const send = (method, params = {}) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params }));
    return new Promise((res) => pending.set(i, res));
  };
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  };
  return { send, evaluate };
}

const pasteInto = (text) => `
  const dt = new DataTransfer();
  dt.setData('text/plain', ${JSON.stringify(text)});
  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
`;

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ui-ud-'));
  const records = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ui-rec-'));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    recordsDir: records, activePlan: null, muted: true, scale: 1,
  }));

  child = spawn(ELECTRON, ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`],
    { cwd: PROJECT, stdio: 'ignore' });

  const ws = await connect();
  const { send, evaluate } = rpc(ws);
  await send('Page.enable');
  await wait(1500);

  // --- import two plans, ticking one task in the first ------------------
  await evaluate(pasteInto(PLAN_A));
  await wait(3000);
  await evaluate(`document.querySelector('.task').click();`);
  await wait(1500);

  await evaluate(pasteInto(PLAN_B));           // import while a plan is loaded
  await wait(3500);

  check('importing while a plan is loaded switches to it', async () => {
    const title = await evaluate(`return document.getElementById('paper-title').textContent;`);
    assert.match(title, /Beta Stream/);
  });

  // --- the shelf --------------------------------------------------------
  await evaluate(`document.getElementById('shelf-toggle').click();`);
  await wait(900);

  check('the shelf lists both plans, most recent first', async () => {
    const names = await evaluate(
      `return [...document.querySelectorAll('.shelf-row .name')].map(n => n.textContent);`);
    assert.deepEqual(names, ['Beta Stream', 'Alpha Stream']);
  });

  check('the active plan is marked', async () => {
    const active = await evaluate(
      `const r = document.querySelector('.shelf-row.active .name'); return r ? r.textContent : null;`);
    assert.equal(active, 'Beta Stream');
  });

  check('the counter reports the plan count', async () => {
    assert.equal(await evaluate(`return document.getElementById('counter').textContent;`), '2 plans');
  });

  check('the shelf does not grow the window', async () => {
    assert.deepEqual(await evaluate(`return [outerWidth, outerHeight];`), [420, 720]);
  });

  // --- switching --------------------------------------------------------
  await evaluate(`
    const rows = [...document.querySelectorAll('.shelf-row')];
    rows.find(r => r.querySelector('.name').textContent === 'Alpha Stream').click();
  `);
  await wait(4000);

  check('switching loads the chosen plan and keeps its progress', async () => {
    const state = await evaluate(`
      return { title: document.getElementById('paper-title').textContent,
               counter: document.getElementById('counter').textContent };
    `);
    assert.match(state.title, /Alpha Stream/);
    assert.equal(state.counter, '1/2 done', 'the tick made before switching away survived');
  });

  // --- finishing sinks a plan into the done group ------------------------
  await evaluate(`document.querySelector('.task').click();`);
  await wait(2500);
  await evaluate(`
    const b = document.querySelectorAll('#dialog-actions button');
    if (b.length) b[1].click();          // "skip"
  `);
  await wait(2500);

  check('a completed plan sinks below the done rule', async () => {
    const shown = await evaluate(`
      if (document.getElementById('paper-body').querySelector('.shelf-row') === null) {
        document.getElementById('shelf-toggle').click();
        await new Promise(r => setTimeout(r, 800));
      }
      const groups = [...document.querySelectorAll('.shelf-group')].map(g => g.textContent);
      const finished = [...document.querySelectorAll('.shelf-row.finished .name')].map(n => n.textContent);
      return { groups, finished };
    `);
    assert.deepEqual(shown.groups, ['done']);
    assert.ok(shown.finished.includes('Alpha Stream'), 'the finished plan is in the done group');
  });

  // --- run them ---------------------------------------------------------
  let failed = 0;
  for (const c of checks) {
    try {
      await c.fn();
      console.log(`  ok  ${c.name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL  ${c.name}\n      ${err.message}`);
    }
  }

  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  child.kill();
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('harness error:', err);
  if (child) child.kill();
  process.exit(1);
});
```

- [ ] **Step 4: Run the harness**

Run: `npm run test:ui`
Expected: `6/6 passed`, exit code 0. A window will open and close during the run.

If a check fails, fix the app — not the assertion — unless the assertion is
itself wrong, in which case say so in the commit message.

- [ ] **Step 5: Confirm the shelf holds its size at other scales**

The harness pins scale to 1. Check the scaled case by hand once: run `npm start`,
press `Ctrl+=` to reach 1.75×, press `▤`, and in DevTools check `[outerWidth, outerHeight]`.

Expected: `735×1260` — the focused height scaled, never the 950-based list height.

- [ ] **Step 6: Document the shelf in the README**

In the Controls table, add a row after the view-toggle row:

```markdown
| `▤` | your plans — switch between them |
```

And add a section after **Loading a plan**:

```markdown
## Several plans at once

Typewriter holds as many plans as you like. Press `▤` to see them all: live
plans first, most recently worked on at the top, with finished and abandoned
ones below a dotted rule. Click one to put it on the roller.

Switching loses nothing. Each plan keeps its own progress file, so you can move
between streams all day and come back to exactly where you left off.

Dropping or pasting a new plan while one is loaded imports it and switches
straight to it.
```

- [ ] **Step 7: Write down what is still unautomated**

Create `test/shelf-integration.md` so the next person knows where coverage stops:

```markdown
# Shelf — test coverage map

- `npm test` — unit tests over the storage logic: listing, ordering,
  grouping, migration, adoption, archiving, touching, and the path guard.
- `npm run test:ui` — CDP harness over the running app: importing while a
  plan is loaded, shelf contents and ordering, the active marker, the plan
  counter, window size, switching, progress surviving a switch, and a
  completed plan sinking under the `done` rule.

Neither covers the following. Check them by hand when touching the shelf:

- [ ] `Ctrl+C` → "log it" sinks the plan under `done` with a `✕`
- [ ] Real drag-and-drop of a `.md` file (the harness pastes instead)
- [ ] A `.md` copied into the records folder by hand appears and gains a sidecar
- [ ] The shelf holds the focused height at scales other than 1×
- [ ] Sounds play on switch and mute silences them
```

- [ ] **Step 8: Run everything once more and commit**

Run: `npm test && npm run test:ui`
Expected: 19 unit tests pass, then `6/6 passed`.

```bash
git add -A
git commit -m "Add a committed CDP harness for the shelf, and document the shelf

Earlier verification used throwaway harnesses in a temp directory that have
since been lost. This one lives in the repo and runs with npm run test:ui, so
the UI paths stay checkable.

Records what neither test layer covers, so the gaps are known rather than
assumed."
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: folder-as-truth → Task 3 (`listPlans` reads the directory, no index); the three sidecar fields and migration → Task 2; adoption of bare `.md` files → Task 3; done-vs-live grouping → Tasks 3 and 5; shelf layout, 720 height, counter text, footer → Task 5; recency ordering and stamping → Tasks 2–4; always-available drop/paste, completion into the shelf, archive on "log it" → Tasks 4 and 6; the `config.js`/`library.js`/`shelf.js` split → Tasks 1 and 5; error handling → Task 3 (skip unparseable, empty folder) and Task 4 (`isInside` guard on switch); the spec's ten verification items → Tasks 6 and 7.

**Naming consistency.** `done` is a count everywhere; `complete` means all tasks ticked; `finished` is `complete || archived` and is the grouping key. `listPlans(recordsDir, activePlan)`, `setArchived(planPath, archived)`, `touchPlan(planPath)`, and `Shelf.render(host, plans, onPick)` are used with those exact signatures in every task that references them. `cfgStore` is the config module and `lib` the library module in `main.js` from Task 1 onward.

**One deliberate deviation from the spec.** The spec's IPC table describes `tw:list-plans` as returning the array directly; this plan wraps it as `{ ok, plans }` to match every other handler in `main.js`. The wrapper is what Tasks 5 and 6 consume.

**Two bugs the review caught, both fixed in Task 5.**

1. `render()` opens with `if (!S.plan) return;`. An earlier draft placed the shelf routing line ambiguously ("the body-building branch"), which would have put it *below* that guard — so the shelf would silently fail to draw whenever no plan was loaded, which is exactly the case where it is most needed. Task 5 now shows the first three lines of the function verbatim so the ordering cannot be misread.

2. Leaving the shelf called `render()` unconditionally. That was wrong twice over: with no plan loaded `render()` bails and the shelf stays stranded on screen with no way out, and returning to a prior `list` view never restored the 950 window height, leaving the list clipped to 720. `toggleShelf()` now handles the no-plan case by lowering the paper to idle, and resizes when returning to `list`.
