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
