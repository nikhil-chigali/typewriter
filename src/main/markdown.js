'use strict';

// Markdown plan parsing + in-place task rewriting.
//
// A plan looks like:
//   # Plan title
//   ## Section
//   - [ ] Task
//   - [x] Completed task (done 2026-07-29 10:15)
//
// Everything that is not a title / section / task line is ignored when parsing
// and preserved untouched when rewriting.

const TITLE_RE = /^#\s+(.+?)\s*$/;
const SECTION_RE = /^##\s+(.+?)\s*$/;
const TASK_RE = /^(\s*[-*]\s+\[)([ xX])(\]\s*)(.*)$/;
const DONE_STAMP_RE = /\s*\(done \d{4}-\d{2}-\d{2} \d{2}:\d{2}\)\s*$/;

/** `YYYY-MM-DD HH:MM` in local time. */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `YYYYMMDD-HHMMSS`, for de-duplicating filenames. */
function fileStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function stripDoneStamp(text) {
  return text.replace(DONE_STAMP_RE, '');
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Parse plan text.
 * @returns {{title: string, items: Array<{text: string, done: boolean, section: string|null}>}|null}
 *          null when there is no `# title` or no task at all.
 */
function parsePlan(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  let title = null;
  let section = null;
  const items = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^﻿/, '');

    const task = line.match(TASK_RE);
    if (task) {
      items.push({
        text: stripDoneStamp(task[4]).trim(),
        done: task[2] !== ' ',
        section,
      });
      continue;
    }

    const sec = line.match(SECTION_RE);
    if (sec) {
      section = sec[1];
      continue;
    }

    const tit = line.match(TITLE_RE);
    if (tit && title === null) {
      title = tit[1];
      continue;
    }
    // Anything else is unrelated Markdown: ignored.
  }

  if (!title || items.length === 0) return null;
  return { title, items };
}

/** How many task lines the document holds. */
function countTasks(text) {
  let n = 0;
  for (const line of String(text).split(/\r?\n/)) if (TASK_RE.test(line)) n++;
  return n;
}

/**
 * Flip one task, addressed by flattened zero-based order.
 * Checking appends `(done YYYY-MM-DD HH:MM)`; unchecking removes it.
 * Every other line is preserved byte-for-byte.
 * @returns {{text: string, at: string|null}|null} null when the index does not exist.
 */
function setTask(text, index, done, now = new Date()) {
  const eol = detectEol(text);
  const lines = String(text).split(/\r?\n/);
  let seen = -1;
  let at = null;
  let hit = false;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TASK_RE);
    if (!m) continue;
    seen++;
    if (seen !== index) continue;

    const body = stripDoneStamp(m[4]).replace(/\s+$/, '');
    if (done) {
      at = stamp(now);
      lines[i] = `${m[1]}x${m[3]}${body} (done ${at})`;
    } else {
      lines[i] = `${m[1]} ${m[3]}${body}`;
    }
    hit = true;
    break;
  }

  if (!hit) return null;
  return { text: lines.join(eol), at: done ? new Date(now).toISOString() : null, stamp: at };
}

/** Append a trailing block, separated by a `---` rule. */
function appendBlock(text, block) {
  const eol = detectEol(text);
  const base = String(text).replace(/\s+$/, '');
  return `${base}${eol}${eol}---${eol}${block}${eol}`;
}

/** `# My Plan!` -> `my-plan`; empty result falls back to `plan-<timestamp>`. */
function slugify(title, now = new Date()) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || `plan-${fileStamp(now)}`;
}

module.exports = {
  parsePlan,
  setTask,
  countTasks,
  appendBlock,
  stripDoneStamp,
  slugify,
  stamp,
  fileStamp,
  TASK_RE,
};
