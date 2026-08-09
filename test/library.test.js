'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = require('../src/main/library');
const md = require('../src/main/markdown');

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

test('listPlans shows a bare .md that has no sidecar, without adopting it', () => {
  const dir = tmpDir();
  const p = writePlan(dir, 'bare.md', '# Bare Plan\n\n- [ ] one\n- [x] two (done 2026-01-01 09:00)\n');

  const rows = lib.listPlans(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Bare Plan');
  assert.equal(rows[0].done, 1);
  assert.equal(rows[0].total, 2);

  // Adoption is an open-time act, per the design: listing only reads.
  assert.equal(fs.existsSync(lib.sidecarPath(p)), false, 'listing writes no sidecar');
});

test('listPlans writes nothing: markdown, sidecar and both mtimes survive a listing', () => {
  const dir = tmpDir();
  const body = '# History\n\n## Only\n'
    + '- [x] wireframe (done 2026-03-01 09:15)\n'
    + '- [x] copy (done 2026-03-02 11:40)\n';
  const p = writePlan(dir, 'history.md', body);
  const sidePath = lib.sidecarPath(p);

  // The sidecar shape that shipped before the shelf: no title, touchedAt or
  // archived. Every existing user's records folder looks exactly like this.
  fs.writeFileSync(sidePath, JSON.stringify({
    plan: p,
    count: 2,
    tasks: {
      0: { done: true, at: '2026-03-01T09:15:00.000Z' },
      1: { done: true, at: '2026-03-02T11:40:00.000Z' },
    },
  }), 'utf8');

  // Pin both mtimes so "unchanged" is provable without sleeping.
  const pinned = new Date('2026-03-02T12:00:00.000Z');
  fs.utimesSync(p, pinned, pinned);
  fs.utimesSync(sidePath, pinned, pinned);

  const before = {
    md: fs.readFileSync(p, 'utf8'),
    side: fs.readFileSync(sidePath, 'utf8'),
    mdAt: fs.statSync(p).mtimeMs,
    sideAt: fs.statSync(sidePath).mtimeMs,
  };

  const rows = lib.listPlans(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'History', 'the title is derived from the markdown, not written to the sidecar');
  assert.equal(rows[0].done, 2);
  assert.equal(rows[0].total, 2);

  assert.equal(fs.readFileSync(p, 'utf8'), before.md, 'the markdown is byte-for-byte unchanged');
  assert.match(before.md, /\(done 2026-03-01 09:15\)/);
  assert.match(fs.readFileSync(p, 'utf8'), /\(done 2026-03-01 09:15\)/, 'historical stamps are not restamped to now');
  assert.match(fs.readFileSync(p, 'utf8'), /\(done 2026-03-02 11:40\)/);
  assert.equal(fs.readFileSync(sidePath, 'utf8'), before.side, 'the sidecar is not upgraded by a mere listing');
  assert.equal(fs.statSync(p).mtimeMs, before.mdAt, 'the markdown mtime is untouched');
  assert.equal(fs.statSync(sidePath).mtimeMs, before.sideAt, 'the sidecar mtime is untouched');
});

test('listPlans does not revert a checkbox ticked by hand in the user\'s editor', () => {
  const dir = tmpDir();
  const p = writePlan(dir, 'book.md', '# Book\n\n- [ ] ch1\n- [ ] ch2\n');
  const sidePath = lib.sidecarPath(p);

  // Sidecar as the app last left it: nothing done.
  fs.writeFileSync(sidePath, JSON.stringify({
    plan: p,
    count: 2,
    tasks: { 0: { done: false, at: null }, 1: { done: false, at: null } },
  }), 'utf8');

  // Now the user ticks ch1 in their own editor, in a plan the app never opened.
  const edited = '# Book\n\n- [x] ch1 (done 2026-04-04 08:00)\n- [ ] ch2\n';
  fs.writeFileSync(p, edited, 'utf8');
  const newer = new Date(fs.statSync(sidePath).mtime.getTime() + 5000);
  fs.utimesSync(p, newer, newer);

  const rows = lib.listPlans(dir);
  assert.equal(rows[0].done, 1, 'the hand-ticked task is counted');
  assert.equal(fs.readFileSync(p, 'utf8'), edited, 'and the tick is still there afterwards');
});

test('a sync stamps a flipped task with its recorded time and leaves settled lines alone', () => {
  const dir = tmpDir();
  const p = writePlan(dir, 'sync.md', '# Sync\n\n- [ ] alpha\n- [x] beta (done 2026-01-01 09:00)\n');

  // Local time, because the markdown stamp is local while the sidecar is UTC.
  const finishedAt = new Date(2026, 1, 3, 14, 5);
  lib.syncMarkdownToItems(p, [
    { done: true, at: finishedAt.toISOString() },
    { done: true, at: '2026-01-01T09:00:00.000Z' },
  ]);

  const text = fs.readFileSync(p, 'utf8');
  assert.match(text, new RegExp(`- \\[x\\] alpha \\(done ${md.stamp(finishedAt)}\\)`), 'the flip carries its own completion time');
  assert.match(text, /- \[x\] beta \(done 2026-01-01 09:00\)/, 'a line that already agreed keeps its original stamp');
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

test('listPlans re-parses when a task is appended to the markdown by hand', () => {
  const dir = tmpDir();
  const p = seedPlan(dir, 'stale.md', 'Stale Plan', [false, false], '2026-01-01T00:00:00.000Z');
  // seedPlan's sidecar reports 0/2; now hand-append a third, already-checked
  // task the way a user would in their own editor, without going through
  // writeSidecar. (An append, not a re-check of an existing line: the sidecar
  // is deliberately authoritative for indices it already knows about — see
  // "the sidecar wins over the markdown when they disagree" — this is about a
  // brand-new index the sidecar has never seen.)
  fs.appendFileSync(p, '- [x] task 3 (done 2026-01-01 09:00)\n');

  // Force the markdown to be unambiguously newer than the sidecar, since
  // filesystem mtime resolution is too coarse to rely on write order alone.
  const sideStat = fs.statSync(lib.sidecarPath(p));
  const planNewer = new Date(sideStat.mtime.getTime() + 5000);
  fs.utimesSync(p, planNewer, planNewer);

  const rows = lib.listPlans(dir);
  const row = rows.find((r) => r.title === 'Stale Plan');
  assert.equal(row.total, 3, 'the appended task is counted');
  assert.equal(row.done, 1, "the appended task's checked state is picked up, not the stale cached count");
});

test('listPlans re-parses a sidecar that undercounts (count: 0) rather than hiding the plan', () => {
  const dir = tmpDir();
  const p = writePlan(dir, 'zero.md', '# Zero Count\n\n## Only\n- [ ] one\n- [x] two (done 2026-01-01 09:00)\n');
  fs.writeFileSync(lib.sidecarPath(p), JSON.stringify({
    plan: p,
    title: 'Zero Count',
    touchedAt: '2026-01-01T00:00:00.000Z',
    archived: false,
    count: 0,
    tasks: {},
  }), 'utf8');

  const rows = lib.listPlans(dir);
  const row = rows.find((r) => r.title === 'Zero Count');
  assert.ok(row, 'the plan still appears despite the bad cached count');
  assert.equal(row.total, 2);
  assert.equal(row.done, 1);
});

test('listPlans falls back to file mtime when touchedAt cannot be parsed', () => {
  const dir = tmpDir();
  seedPlan(dir, 'aa-good.md', 'Good Date', [false], '2026-05-01T00:00:00.000Z');
  const bad = seedPlan(dir, 'zz-bad.md', 'Bad Date', [false], '2026-01-01T00:00:00.000Z');

  // Corrupt the touchedAt field only; leave count/tasks alone.
  const sidePath = lib.sidecarPath(bad);
  const side = JSON.parse(fs.readFileSync(sidePath, 'utf8'));
  side.touchedAt = 'not-a-real-date';
  fs.writeFileSync(sidePath, JSON.stringify(side), 'utf8');

  // Pin the bad plan's file mtime to something clearly older than the good
  // plan's touchedAt, so the fallback still sorts it below "Good Date".
  const old = new Date('2020-01-01T00:00:00.000Z');
  fs.utimesSync(bad, old, old);

  const rows = lib.listPlans(dir);
  const badRow = rows.find((r) => r.title === 'Bad Date');
  assert.ok(!Number.isNaN(Date.parse(badRow.touchedAt)), 'garbage touchedAt is replaced with a parseable date');
  assert.equal(badRow.touchedAt, old.toISOString());
  assert.deepEqual(rows.map((r) => r.title), ['Good Date', 'Bad Date']);
});

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

test('markSidecarCurrent keeps the cache trusted even when its write landed before the markdown write', () => {
  const dir = tmpDir();
  const p = seedPlan(dir, 'delayed.md', 'Delayed Write', [false, false], '2026-01-01T00:00:00.000Z');
  const sidePath = lib.sidecarPath(p);

  // The real write order is sidecar-first, markdown-second (deliberately, so a
  // crash mid-pair leaves the authoritative sidecar correct). On a slow disk
  // those two writes can land in different filesystem timestamp ticks, which
  // would make the sidecar look permanently stale by mtime alone. Simulate
  // that landing order directly, then poison the cached count in a way that
  // is only observable if the cache is actually trusted afterwards.
  const planStat = fs.statSync(p);
  const sideBehind = new Date(planStat.mtime.getTime() - 5000);
  fs.utimesSync(sidePath, sideBehind, sideBehind);

  const side = JSON.parse(fs.readFileSync(sidePath, 'utf8'));
  side.tasks['0'] = { done: true, at: '2026-01-01T00:00:00.000Z' }; // cache-only: markdown still says false
  fs.writeFileSync(sidePath, JSON.stringify(side), 'utf8');
  fs.utimesSync(sidePath, sideBehind, sideBehind); // re-pin behind the markdown after the content edit

  // Without the explicit stamp, the sidecar is still "behind" and listPlans
  // would re-parse the markdown (done: 0). markSidecarCurrent re-ties the
  // freshness clock the way a completed write pair would.
  lib.markSidecarCurrent(p);

  const rows = lib.listPlans(dir);
  const row = rows.find((r) => r.title === 'Delayed Write');
  assert.equal(row.done, 1, 'the cached count is trusted once the sidecar has been marked current');
});
