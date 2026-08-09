'use strict';

const api = window.typewriter;

const H_FOCUSED = 720;
const H_LIST = 950;
const HOLD_MS = 750;   // pause after a check before the next task prints
const IDLE_SUB = 'drag & drop a .md file or paste (⌘V)';

const S = {
  plan: null,        // { path, name, title, items: [{ text, done, at, section }] }
  mode: 'focused',   // 'focused' | 'list' | 'shelf'
  priorMode: 'focused',  // the view the shelf was opened from
  focusIdx: null,
  celebrated: false,
  pending: null,     // { idx, timer } — a scheduled advance the user can still undo
  busy: false,
  shelfCount: 0,
};

const el = {};

// ------------------------------------------------------------------ helpers

// Timers only. requestAnimationFrame does not fire while the window is occluded or
// in the background, which would strand the print animation half-drawn.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const items = () => (S.plan ? S.plan.items : []);
const doneCount = () => items().filter((i) => i.done).length;
const allDone = () => S.plan !== null && items().length > 0 && doneCount() === items().length;

/** Consecutive runs of tasks sharing a section heading. */
function groups() {
  const out = [];
  items().forEach((it, i) => {
    const last = out[out.length - 1];
    if (last && last.name === it.section) last.idx.push(i);
    else out.push({ name: it.section, idx: [i] });
  });
  return out;
}

function groupOf(i) {
  return groups().find((g) => g.idx.includes(i)) || null;
}

function firstIncomplete() {
  const i = items().findIndex((it) => !it.done);
  return i === -1 ? null : i;
}

/** The next incomplete task after `from`, wrapping back to earlier ones if needed. */
function nextIncomplete(from) {
  for (let i = from + 1; i < items().length; i++) if (!items()[i].done) return i;
  return firstIncomplete();
}

// ------------------------------------------------------------------ building

function taskEl(idx, { instant = true } = {}) {
  const it = items()[idx];
  const row = document.createElement('div');
  row.className = 'task' + (it.done ? ' done' : '') + (it.done && instant ? ' instant' : '');
  row.dataset.idx = String(idx);

  const box = document.createElement('span');
  box.className = 'box';
  box.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><polyline points="2,6 5,9 10,3"/></svg>';

  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.textContent = it.text;

  row.append(box, txt);
  row.addEventListener('click', () => onToggle(idx));
  return row;
}

function sectionLabelEl(name, complete) {
  const label = document.createElement('div');
  label.className = 'section-label' + (complete ? ' complete' : '');

  const text = document.createElement('span');
  text.textContent = name;

  const stamp = document.createElement('span');
  stamp.className = 'stamp';
  stamp.textContent = 'done!';

  label.append(text, stamp);
  return label;
}

/** Focused mode: the first incomplete task, under its section label. */
function buildFocused({ arriving = false } = {}) {
  el.body.innerHTML = '';
  S.focusIdx = firstIncomplete();
  if (S.focusIdx === null) return;

  const g = groupOf(S.focusIdx);
  if (g && g.name) el.body.appendChild(sectionLabelEl(g.name, false));

  const row = taskEl(S.focusIdx);
  if (arriving) {
    row.classList.add('arriving');
    row.addEventListener('animationend', () => row.classList.remove('arriving'), { once: true });
  }
  el.body.appendChild(row);
}

/** List mode: every section and every task. */
function buildList() {
  el.body.innerHTML = '';
  for (const g of groups()) {
    const sec = document.createElement('div');
    sec.className = 'section';
    if (g.name) sec.appendChild(sectionLabelEl(g.name, g.idx.every((i) => items()[i].done)));
    for (const i of g.idx) sec.appendChild(taskEl(i));
    el.body.appendChild(sec);
  }
}

function render(opts) {
  if (S.mode === 'shelf') { renderShelf(); return; }   // must precede the !S.plan guard
  if (!S.plan) return;
  el.title.textContent = `··· ${S.plan.title} ···`;
  el.title.title = S.plan.title;
  el.paper.classList.toggle('list', S.mode === 'list');
  el.paper.classList.toggle('complete', allDone());
  if (S.mode === 'list') buildList();
  else buildFocused(opts);
  updateStatus();
}

function updateStatus() {
  if (S.mode === 'shelf') {
    const n = S.shelfCount || 0;
    el.counter.textContent = n === 0 ? 'no plans' : `${n} plan${n === 1 ? '' : 's'}`;
  } else {
    el.counter.textContent = `${doneCount()}/${items().length} done`;
  }

  const list = S.mode === 'list';
  el.view.textContent = list ? '●' : '≡';
  el.view.title = list ? 'Focus mode' : 'Show full list';

  const muted = Sound.isMuted();
  el.sound.textContent = muted ? '✕' : '♪';
  el.sound.title = muted ? 'Muted' : 'Sound on';
  el.sound.classList.toggle('off', muted);
}

/** Re-evaluate every visible section stamp from the DOM. */
function refreshStamps() {
  el.body.querySelectorAll('.section').forEach((sec) => {
    const tasks = sec.querySelectorAll('.task');
    const label = sec.querySelector('.section-label');
    if (!label || !tasks.length) return;
    label.classList.toggle('complete', [...tasks].every((t) => t.classList.contains('done')));
  });
}

// ------------------------------------------------------------------ printing

function setPaperY(pct) {
  el.paper.style.transform = `translateY(${pct}%)`;
}

/** The one-time print: raise the sheet, then reveal each line in turn. */
async function printPaper() {
  const lines = [el.title, el.divider, ...el.body.querySelectorAll('.section-label, .task')];
  lines.forEach((l) => l.classList.add('print-hidden'));

  el.paper.classList.remove('hidden');
  setPaperY(100);
  await wait(200);

  const step = Math.min(100, Math.max(40, Math.round(2000 / (3 + lines.length))));

  for (const y of [60, 20, 0]) {
    setPaperY(y);
    Sound.print();
    await wait(step);
  }
  for (const line of lines) {
    line.classList.remove('print-hidden');
    Sound.print();
    await wait(step);
  }
}

/** Feed the sheet back down out of sight. */
async function lowerPaper() {
  for (const y of [20, 60, 100]) {
    setPaperY(y);
    await wait(90);
  }
  el.paper.classList.add('hidden');
}

// ------------------------------------------------------------------ plan flow

async function openPlan(plan, { animate = true } = {}) {
  S.plan = plan;
  S.mode = 'focused';
  S.celebrated = false;
  S.pending = null;

  el.idle.classList.add('hidden');
  el.tw.classList.remove('dragover');
  measureTypewriter();
  api.resize(H_FOCUSED);

  render();
  if (animate) await printPaper();
  else { el.paper.classList.remove('hidden'); setPaperY(0); }

  // A plan that was already finished is restored quietly — no second party.
  if (allDone()) markComplete({ celebrate: false });
}

async function onToggle(idx) {
  if (S.busy || !S.plan) return;
  const it = items()[idx];
  if (!it) return;
  const next = !it.done;

  // Re-clicking a task whose advance is still pending cancels it.
  if (S.pending && S.pending.idx === idx) {
    clearTimeout(S.pending.timer);
    S.pending = null;
  }

  S.busy = true;
  const res = await api.toggle(idx, next).catch(() => null);
  S.busy = false;

  if (!res || !res.ok) {
    flash('could not save progress');
    return;
  }

  it.done = next;
  it.at = res.at;

  const row = el.body.querySelector(`.task[data-idx="${idx}"]`);
  if (row) {
    row.classList.remove('instant');
    row.classList.toggle('done', next);
  }
  updateStatus();
  if (next) Sound.check(); else Sound.uncheck();

  // Dropping back below 100% retires the banner and re-arms the celebration.
  if (!allDone()) {
    el.paper.classList.remove('complete');
    S.celebrated = false;
  }

  if (S.mode === 'list') {
    refreshStamps();
    if (allDone()) markComplete();
    return;
  }

  // Focused mode.
  if (!next) return;
  if (row) Fx.sparkle(row.querySelector('.box'));

  // If that finished the section, stamp it before the sheet moves on.
  const g = groupOf(idx);
  const label = el.body.querySelector('.section-label');
  if (g && label && g.idx.every((i) => items()[i].done)) label.classList.add('complete');

  S.pending = { idx, timer: setTimeout(() => advance(idx), HOLD_MS) };
}

async function advance(fromIdx) {
  S.pending = null;
  if (!S.plan || S.mode !== 'focused') return;

  const row = el.body.querySelector(`.task[data-idx="${fromIdx}"]`);
  if (row) {
    row.classList.add('leaving');
    await wait(300);
  }
  if (!S.plan || S.mode !== 'focused') return;

  if (nextIncomplete(fromIdx) === null) {
    markComplete();
    return;
  }
  buildFocused({ arriving: true });
  Sound.print();
}

function markComplete({ celebrate = true } = {}) {
  el.paper.classList.add('complete');
  if (S.mode === 'focused') el.body.innerHTML = '';
  if (!celebrate || S.celebrated) return;

  S.celebrated = true;
  Sound.complete();
  Fx.confetti(40);
  setTimeout(() => {
    if (S.plan && allDone()) openCompleteDialog();
  }, 1600);
}

/** Put the typewriter back to its idle state and forget the active plan. */
async function resetToIdle() {
  closeDialog();
  if (S.pending) clearTimeout(S.pending.timer);
  S.pending = null;

  el.paper.classList.remove('list', 'complete');
  await lowerPaper();

  S.plan = null;
  S.mode = 'focused';
  S.focusIdx = null;
  S.celebrated = false;

  el.title.textContent = '';
  el.body.innerHTML = '';
  el.counter.textContent = '0/0 done';
  el.idle.classList.remove('hidden');
  el.view.textContent = '≡';
  el.view.title = 'Show full list';
  measureTypewriter();
  api.resize(H_FOCUSED);
}

// ------------------------------------------------------------------ dialogs

function openDialog({ title, text, note = false, actions }) {
  el.dlgTitle.textContent = title;
  el.dlgText.textContent = text;
  el.note.classList.toggle('hidden', !note);
  el.note.value = '';
  el.actions.innerHTML = '';

  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = a.label;
    if (a.primary) b.className = 'primary';
    b.addEventListener('click', a.onClick);
    el.actions.appendChild(b);
  }

  el.modal.classList.remove('hidden');
  if (note) el.note.focus();
}

function closeDialog() {
  el.modal.classList.add('hidden');
}

function openCompleteDialog() {
  openDialog({
    title: '✓ plan complete',
    text: 'add a session note?',
    note: true,
    actions: [
      { label: 'save + new plan', primary: true, onClick: () => finish(el.note.value) },
      { label: 'skip', onClick: () => finish('') },
    ],
  });
}

async function finish(note) {
  closeDialog();
  await api.complete(note).catch(() => null);
  await resetToIdle();
}

function openAbortDialog() {
  openDialog({
    title: '✕ abort plan?',
    text: 'log your progress or delete this plan?',
    actions: [
      { label: 'log it', primary: true, onClick: () => abort('log') },
      { label: 'discard', onClick: () => abort('discard') },
      { label: 'cancel', onClick: closeDialog },
    ],
  });
}

async function abort(action) {
  closeDialog();
  await api.abort(action, doneCount(), items().length).catch(() => null);
  await resetToIdle();
}

// ------------------------------------------------------------------ input

function flash(message = "couldn't read this plan :(") {
  el.idleSub.textContent = message;
  el.idleSub.classList.add('error');
  el.tw.classList.remove('shake');
  void el.tw.offsetWidth; // restart the animation
  el.tw.classList.add('shake');

  clearTimeout(flash.t);
  flash.t = setTimeout(() => {
    el.idleSub.textContent = IDLE_SUB;
    el.idleSub.classList.remove('error');
    el.tw.classList.remove('shake');
  }, 2500);
}

async function importResult(promise) {
  const res = await promise.catch(() => null);
  if (!res || !res.ok) {
    flash();
    return;
  }
  await openPlan(res.plan, { animate: true });
}

function toggleMode() {
  if (!S.plan) return;
  S.mode = S.mode === 'list' ? 'focused' : 'list';
  api.resize(S.mode === 'list' ? H_LIST : H_FOCUSED);
  render();                      // rebuilt in place — the print animation never replays
  if (S.mode === 'list') el.paper.scrollTop = 0;
}

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

function toggleSound() {
  const muted = !Sound.isMuted();
  Sound.setMuted(muted);
  api.setMuted(muted);
  updateStatus();
}

function buildKeys() {
  const rows = ['1234567890', 'QWERTUIOP', 'ASDGHJKL', 'ZXCVBNM!?'];
  for (const row of rows) {
    const r = document.createElement('div');
    r.className = 'key-row';
    for (const ch of row) {
      const k = document.createElement('div');
      k.className = 'key';
      k.textContent = ch;
      r.appendChild(k);
    }
    el.keys.appendChild(r);
  }
  const spaceRow = document.createElement('div');
  spaceRow.className = 'key-row';
  const space = document.createElement('div');
  space.className = 'key space';
  spaceRow.appendChild(space);
  el.keys.appendChild(spaceRow);
}

/** Tell the stylesheet how much room the typewriter takes, so the sheet can cap itself. */
function measureTypewriter() {
  document.documentElement.style.setProperty('--tw-h', `${el.tw.offsetHeight}px`);
}

let toastTimer = null;
function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 1000);
}

async function nudgeScale(dir) {
  const next = await api.setScale(dir).catch(() => null);
  if (next) toast(`${Math.round(next * 100)}%`);
}

function isTyping(target) {
  const t = target || document.activeElement;
  return !!t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
}

function wire() {
  el.view.addEventListener('click', toggleMode);
  el.shelf.addEventListener('click', toggleShelf);
  el.sound.addEventListener('click', toggleSound);

  // Drag & drop — only meaningful while idle.
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!S.plan) el.tw.classList.add('dragover');
  });
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) el.tw.classList.remove('dragover');
  });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.tw.classList.remove('dragover');
    if (S.plan) return;

    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return flash();
    if (!/\.md$/i.test(file.name)) return flash();

    const p = api.pathForFile(file);
    if (!p) return flash();
    await importResult(api.importFile(p));
  });

  document.addEventListener('paste', async (e) => {
    if (S.plan || isTyping(e.target)) return;
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!text || !text.trim()) return flash();
    await importResult(api.importText(text));
  });

  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.metaKey) return;

    // Ctrl+= / Ctrl+- / Ctrl+0 resize the whole typewriter.
    if (e.key === '=' || e.key === '+') { e.preventDefault(); return void nudgeScale(1); }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); return void nudgeScale(-1); }
    if (e.key === '0') { e.preventDefault(); return void nudgeScale(0); }

    // Ctrl+C (never Cmd+C) outside a text field aborts the active plan.
    if (e.key === 'c' || e.key === 'C') {
      if (!S.plan || isTyping(e.target) || !el.modal.classList.contains('hidden')) return;
      e.preventDefault();
      openAbortDialog();
    }
  });

  // The typewriter grows and shrinks as the idle panel comes and goes.
  new ResizeObserver(measureTypewriter).observe(el.tw);
}

// ------------------------------------------------------------------ startup

window.addEventListener('DOMContentLoaded', async () => {
  Object.assign(el, {
    paper: document.getElementById('paper'),
    title: document.getElementById('paper-title'),
    divider: document.getElementById('paper-divider'),
    body: document.getElementById('paper-body'),
    tw: document.getElementById('typewriter'),
    idle: document.getElementById('idle'),
    idleSub: document.getElementById('idle-sub'),
    keys: document.getElementById('keys'),
    counter: document.getElementById('counter'),
    view: document.getElementById('view-toggle'),
    shelf: document.getElementById('shelf-toggle'),
    sound: document.getElementById('sound-toggle'),
    modal: document.getElementById('modal'),
    dlgTitle: document.getElementById('dialog-title'),
    dlgText: document.getElementById('dialog-text'),
    note: document.getElementById('note'),
    actions: document.getElementById('dialog-actions'),
    toast: document.getElementById('toast'),
  });

  buildKeys();
  wire();
  measureTypewriter();

  const boot = await api.init().catch(() => null);
  if (!boot) return;

  Sound.setMuted(boot.muted);
  updateStatus();
  if (boot.plan) await openPlan(boot.plan, { animate: true });
});
