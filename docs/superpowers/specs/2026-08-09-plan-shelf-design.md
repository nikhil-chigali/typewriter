# Plan shelf — holding and switching between several plans

**Status:** approved, not yet implemented
**Date:** 2026-08-09

## Problem

Typewriter holds exactly one plan. `config.activePlan` names it; loading another
means abandoning the first. Real days move between several streams — some
long-lived ("Project Atlas", "Thesis ch.3"), some day-scoped ("Tuesday") — and
the app forces a choice between them.

The records folder is *already* a multi-plan store. Every plan ever imported is
still there with its `.progress.json` sidecar and its progress intact. Nothing
about the storage model needs to change. What is missing is a way to see what is
in the folder and choose among it.

This is therefore a selection feature, not a storage feature.

## Goals

- See every stored plan and switch between them without losing progress.
- Keep finished and abandoned plans out of the way but still reachable.
- Preserve the widget's character: small, quiet, pixel-art, one plan on the
  roller at a time.

## Non-goals

- Renaming plans in the app. Titles come from the Markdown `#` heading.
- Deleting arbitrary plans from the shelf. `Ctrl+C` → discard already removes the
  active plan, guarded to the records directory.
- Pinning or manual ordering. Recency is expected to be sufficient; revisit only
  if standing streams demonstrably get buried in use.
- Showing more than one plan on the paper at once.

## Approach: the folder is the truth

Opening the shelf scans the records directory and reads each sidecar. There is no
index file and no cached list.

This was chosen over an index (`library.json`) or tracking the list in
`config.json`. Both are a second source of truth that goes stale as soon as the
folder is touched from outside the app, and both must be kept in sync by every
operation. The app's persistence story is already "the folder is real, the app is
a view onto it" — the sidecar is authoritative on reopen, and the discard guard
refuses to touch anything outside the records directory. An index would be the
first component able to lie.

Cost is reading N small JSON files per shelf open. Negligible for dozens of
plans; hundreds would be noticeable, which is far beyond the intended use.

## Data model

The sidecar gains three fields. All are optional, so existing sidecars stay
valid.

```json
{
  "plan": "…/project-atlas.md",
  "title": "Project Atlas",
  "touchedAt": "2026-07-30T14:22:00.000Z",
  "archived": false,
  "count": 9,
  "tasks": { "0": { "done": true, "at": "…" } }
}
```

- **`title`** — cached so listing reads only JSON, never Markdown.
- **`touchedAt`** — ISO timestamp, rewritten on every task toggle and on the plan
  being switched *to*. The plan being switched away from keeps the time of its
  last toggle, which is when it was genuinely last worked on. The effect is that
  the current plan always sits at the top of the shelf.
- **`archived`** — `true` when the user chooses "log it" from the abort dialog.

**Migration.** A sidecar missing these fields is upgraded on first sight: `title`
by parsing the `.md`, `touchedAt` from the sidecar's file mtime, `archived`
defaulting to `false`. The upgraded sidecar is written back. No user action, no
version field.

**Adoption.** A `.md` dropped into the records folder by hand has no sidecar. The
shelf parses it, shows it, and writes a sidecar when it is first opened.

**Done vs live.** A plan is *done* when every task is complete **or** when
`archived` is true. Completion is derivable from the checkboxes; abandonment is
not, which is the only reason `archived` needs storing.

## The shelf

A third view alongside `focused` and `list`, rendered on the paper and opened by a
new `▤` button in the status bar.

```
┌────────────────────────────────┐
│      ···  YOUR PLANS  ···      │
│ ······························ │
│  ▸ project atlas      2/9      │
│    tuesday            0/4      │
│    thesis ch.3        7/11     │
│ ········· done ··············· │
│    landing page       9/9  ✓   │
│    old sprint         2/9  ✕   │
│                                │
│  drop a .md or paste to add    │
└────────────────────────────────┘
```

- **Live plans** first, ordered by `touchedAt` descending. The current plan is
  marked `▸`.
- **Done plans** below a red dotted rule labelled `done`, using the same divider
  vocabulary as section labels. Completed rows end `✓`, archived rows `✕`.
  Ordered by `touchedAt` descending within the group.
- **Window height stays 720** — the focused height, with the focused 320px paper
  cap. Jumping to 950 to choose between three plans would be jarring. The list
  scrolls past roughly fifteen rows using the existing 4px red-on-cream
  scrollbar.
- **Counter** reads `4 plans` while the shelf is open, instead of `2/9 done`.
  Singular for one (`1 plan`), and `no plans` when the folder is empty.
- **Footer** repeats `drop a .md or paste to add` in muted text.
- Rows are `no-drag` and clickable; the surrounding paper keeps its drag region.
- `▤` again returns to whichever view was showing before — `focused` or `list`.

The shelf opens with or without an active plan. On first run, with no stored
plans at all, the idle panel still shows and the shelf is empty apart from its
footer.

## Behaviour changes to existing flows

- **Drop and paste work at any time**, not only when idle. They import the plan
  and switch to it. This is required for multi-plan and is the main change to
  existing behaviour.
- **Switching** parks nothing. Progress is already written per-toggle into each
  plan's own sidecar. A switch is: move `config.activePlan`, stamp `touchedAt` on
  the incoming plan, feed the old sheet down (`lowerPaper`), print the new one
  (`printPaper`).
- **"Save + new plan"** on the completion popup lands in the shelf rather than
  the empty idle state.
- **`Ctrl+C` → "log it"** additionally sets `archived: true`, so abandoned plans
  sink into the done group instead of lingering among live work. It still keeps
  the plan and sidecar and still appends the abort log line.
- **`Ctrl+C` → "discard"** is unchanged, including the records-directory guard.

## Code structure

Two splits, both driven by this feature.

`src/main/records.js` (221 lines) currently does two jobs — user config and plan
storage — and listing would make three. Split:

- **`src/main/config.js`** — read/write/defaults for `config.json` in `userData`.
- **`src/main/library.js`** — the records folder: path safety (`isInside`),
  `freePath`, sidecar read/write, `loadPlan`, `syncMarkdownToItems`, plus new
  `listPlans()` and `setArchived()`.

`src/main/markdown.js` is unchanged.

In the renderer, `app.js` (528 lines) would balloon with shelf rendering:

- **`src/renderer/shelf.js`** — builds the shelf DOM and handles row clicks,
  alongside the existing `audio.js` and `fx.js`. `app.js` keeps view-state
  orchestration.

### New IPC

| Channel | Direction | Returns |
|---|---|---|
| `tw:list-plans` | invoke | `{ ok, plans: [{ path, title, done, total, complete, archived, finished, touchedAt, active }] }` |
| `tw:switch-plan` | invoke | `{ ok, plan }` or `{ ok: false, error }` |

`tw:init` returns what it always did. An earlier draft of this spec had it also
return `planCount` so the renderer could tell a genuine first run from a launch
with plans but none active. No consumer for that was ever built, and computing it
meant scanning the whole records folder on every launch — which is what turned a
latent bug in `listPlans` into a data-loss one, since listing was writing at the
time. It was removed before merge. If the distinction is ever genuinely needed,
derive it from a `tw:list-plans` call the renderer already makes.

## Error handling

- A `.md` that fails to parse is skipped in the listing rather than breaking the
  shelf. Nothing is shown for it; it is not deleted.
- A malformed sidecar falls back to parsing the `.md`, exactly as `loadPlan` does
  today.
- A plan whose file has vanished drops out of the listing; if it was active the
  pointer is cleared, reusing the existing path in `tw:init`.
- An unreadable records directory yields an empty shelf and leaves the idle panel
  showing, rather than an error state.
- `tw:switch-plan` validates that the target is inside the records directory
  before touching it, reusing `isInside`.

## Verification

Extend the existing CDP harnesses, which drive the real Electron app over the
DevTools Protocol.

1. **Listing** — several plans in the records folder appear in the shelf with
   correct titles and counts; ordering is `touchedAt` descending.
2. **Grouping** — a fully-completed plan and an archived plan both appear below
   the `done` rule with `✓` and `✕`; live plans stay above it.
3. **Switching** — click a row, confirm the paper feeds down and reprints, the
   counter updates, and `config.activePlan` moves.
4. **Progress survives a switch** — toggle in plan A, switch to B, switch back;
   A's progress is intact and its Markdown carries the `(done …)` stamps.
5. **Migration** — a sidecar written in the old three-field shape is upgraded in
   place, keeping its task states.
6. **Adoption** — a bare `.md` copied into the folder with no sidecar shows in
   the shelf and gains a sidecar when opened.
7. **Archiving** — `Ctrl+C` → "log it" moves the plan into the done group.
8. **Import while active** — dropping a file with a plan already loaded imports
   and switches, leaving the previous plan intact in the shelf.
9. **Window height** — the shelf stays at 420×720 and scrolls with many plans.
10. **Regression** — the existing suites still pass unchanged at 1× scale.

## Open questions

None. Pinning and in-app deletion were considered and deliberately deferred.
