'use strict';

// Drives the real app over the Chrome DevTools Protocol and asserts the shelf behaves.
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
let total = 0;
let failed = 0;
// Runs the assertion immediately (not deferred to the end) — the shelf state
// this checks against is a snapshot in time, and by the time a later action
// runs (a switch, a completion) that snapshot is gone. Deferring every check
// to a final loop, as an earlier draft of this harness did, made every check
// but the last observe whatever state the *final* action left behind.
async function check(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

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

const CDP_TIMEOUT_MS = 8000; // generous next to the longest legitimate evaluate (~800ms)

// Wraps the CDP websocket. Every send() settles one way or another: on reply,
// on timeout (named after the method, so a failure is diagnosable), or on
// socket error/close (which fails every call still in flight). Without this,
// a dropped socket or a renderer that stops responding leaves an evaluate()
// permanently pending, which would leave the always-on-top window stranded
// on screen forever since the code that kills it is never reached.
function rpc(ws) {
  let id = 0;
  const pending = new Map();

  function rejectAll(err) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    pending.clear();
  }

  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg.result); }
  };
  ws.onerror = () => rejectAll(new Error('CDP socket error'));
  ws.onclose = () => rejectAll(new Error('CDP socket closed'));

  const send = (method, params = {}) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(i);
        reject(new Error(`CDP call timed out: ${method}`));
      }, CDP_TIMEOUT_MS);
      pending.set(i, { resolve, reject, timer });
    });
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

  await check('importing while a plan is loaded switches to it', async () => {
    const title = await evaluate(`return document.getElementById('paper-title').textContent;`);
    assert.match(title, /Beta Stream/);
  });

  // --- the shelf --------------------------------------------------------
  await evaluate(`document.getElementById('shelf-toggle').click();`);
  await wait(900);

  await check('the shelf lists both plans, most recent first', async () => {
    const names = await evaluate(
      `return [...document.querySelectorAll('.shelf-row .name')].map(n => n.textContent);`);
    assert.deepEqual(names, ['Beta Stream', 'Alpha Stream']);
  });

  await check('the active plan is marked', async () => {
    const active = await evaluate(
      `const r = document.querySelector('.shelf-row.active .name'); return r ? r.textContent : null;`);
    assert.equal(active, 'Beta Stream');
  });

  await check('the counter reports the plan count', async () => {
    assert.equal(await evaluate(`return document.getElementById('counter').textContent;`), '2 plans');
  });

  await check('the shelf does not grow the window', async () => {
    assert.deepEqual(await evaluate(`return [outerWidth, outerHeight];`), [420, 720]);
  });

  // The sheet sits inside the clip's drag region, so without its own no-drag the
  // scrollbar thumb and every gap between rows would drag the window instead.
  await check('the shelf sheet is not a window-drag region', async () => {
    const state = await evaluate(`
      const paper = document.getElementById('paper');
      return { marked: paper.classList.contains('shelf'),
               region: getComputedStyle(paper).getPropertyValue('-webkit-app-region').trim() };
    `);
    assert.equal(state.marked, true, '#paper carries the shelf class while the shelf shows');
    assert.equal(state.region, 'no-drag');
  });

  // --- switching --------------------------------------------------------
  await evaluate(`
    const rows = [...document.querySelectorAll('.shelf-row')];
    rows.find(r => r.querySelector('.name').textContent === 'Alpha Stream').click();
  `);
  await wait(4000);

  await check('switching loads the chosen plan and keeps its progress', async () => {
    const state = await evaluate(`
      return { title: document.getElementById('paper-title').textContent,
               counter: document.getElementById('counter').textContent,
               shelfClass: document.getElementById('paper').classList.contains('shelf') };
    `);
    assert.match(state.title, /Alpha Stream/);
    assert.equal(state.counter, '1/2 done', 'the tick made before switching away survived');
    assert.equal(state.shelfClass, false, 'leaving the shelf drops its no-drag class');
  });

  // --- finishing sinks a plan into the done group ------------------------
  await evaluate(`document.querySelector('.task').click();`);
  await wait(2500);
  await evaluate(`
    const b = document.querySelectorAll('#dialog-actions button');
    if (b.length) b[1].click();          // "skip"
  `);
  await wait(2500);

  await check('a completed plan sinks below the done rule', async () => {
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

  console.log(`\n${total - failed}/${total} passed`);
  child.kill();
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('harness error:', err);
  if (child) child.kill();
  process.exit(1);
});
