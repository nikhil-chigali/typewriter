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
