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
