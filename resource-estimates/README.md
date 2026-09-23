# Resource estimates review demo

[Open the public review demo](https://rohit-2002-28.github.io/qdk-qce26-tutorial/resource-estimates/).

This self-contained static snapshot is for design review only. All names, counts,
targets, runtime estimates, and notes are synthetic, not real resource estimates.
Do not enter or commit real, personal, proprietary, or confidential data.

There is no sign-in, access control, backend, or durable storage. Save updates
changes only the open browser page in memory; reloading or resetting restores
the example data. The `noindex,nofollow` tag discourages indexing, not access.

## Reading and editing

- **Leadership** is the default demo view. Overview has one job: choose a
  candidate and read its **logical operations** and **logical qubits**, each
  paired with its compatible change and time trend. Compact system/candidate
  selectors replace the ledger; all-candidate scanning remains in Compare and
  All metrics. Snapshot history and sharing remain available without adding
  more report sections to the default screen.
- **Resource details & assumptions** on Overview contains the selected
  snapshot's physical counts/current-target gap, overhead ratios, runtime/range,
  gate share, full change note, caveats, sources, save timestamp and all seven
  exact counts. This disclosure is closed by default. A long change note has an
  explicit full-note action; no caveat text is silently truncated. A historical
  selection is labeled as historical in the date/maturity/configuration line.
- **Updates & outlook** is the home of the canonical briefing and milestones.
  The expanded briefing, goals/planning panel and duplicate shortcut row have
  deliberately been removed from Overview after review feedback about clutter.
  At most one relevant exception is shown there: an incompatible comparison,
  an engineer-recorded blocker, or an overdue/future-dated current estimate.
  Routine plans and requests stay in Updates & outlook.
- Freshness uses the fixed **22 Sep 2026** demo reference date, not the visitor's
  clock. Maturity and cadence are engineer-supplied descriptions, not inferred
  confidence or an approval workflow.
- **Compare** shows two count-vs-count scatter plots for all eight candidates:
  logical/physical qubits and logical/physical operations. Points, keyboard
  controls and the exact-data disclosure use each candidate's latest dated
  estimate. Workloads and configurations are not automatically comparable.
  Independent candidates are neither summed nor ranked.
- **Copy view link** preserves the tab, candidate, system filter and exact
  published snapshot/configuration. In-tab snapshots cannot be shared as server
  data: the copy action explicitly offers a published snapshot instead. Opening
  an unavailable snapshot URL shows a recovery screen, not a substituted count.
  Written edits are never placed in the URL. A link pins an estimate record, not
  a historic version of the entire written briefing or milestone plan.
- Use **Demo view > Engineering > Estimates** for the seven exact counts,
  rectangular Excel paste and supporting inputs. Valid batches save atomically.
  Corrections retain prior revisions; backdated entries do not replace a
  later-dated estimate. Runtime remains a separate supplied model input.
- Use **Demo view > Engineering > Updates & outlook** for briefing bullets and
  milestones. At most four briefing bullets may be active; archive before adding
  another. Edit, reorder with Up/Down, archive and restore without losing earlier
  text. A new bullet can reuse the scoped estimate's note, date and owner.
  Estimate saves do not silently add or displace written bullets.
- Milestones carry scope, outcome, date/window, owner, status and dependencies.
  Linking a physical-qubit objective reads its value, date and assumptions from
  that candidate's latest estimate; edit that shared target in Estimates.
  Full plans and dependencies remain in Updates & outlook, while the selected
  estimate's target is available in Overview's resource disclosure. Targets
  remain future objectives, never forecasts or current achievements.

The persona switch is a review aid, **not a permission boundary**. All in-memory
history, written updates and new estimates disappear on reload. Do not use this
prototype to collect real data.

## Updating the standalone artifact

Author under `src/`, then rebuild and commit the generated `index.html` too:

```powershell
node .\resource-estimates\build.mjs
node .\resource-estimates\build.mjs --check
```

`src/shell.html`, `styles.css`, `data.js` and `app.js` are embedded into the single
HTML file by the dependency-free Node build. No network runtime assets, framework,
server, package install or new Pages workflow is required. The generated file
also opens directly from disk. Do not hand-edit the generated `index.html`.

## Bounded browser checks

Use an existing Playwright installation and Edge. If Playwright is not resolvable
from this repository, set `PLAYWRIGHT_MODULE` to its installed module directory.
Optionally set `EDGE_PATH` to an existing Edge executable; otherwise the `msedge`
channel is used. No browser profile or signed-in session is reused.

```powershell
node .\resource-estimates\tests\smoke.cjs
```

The checks cover fresh-context links and history, both plots' exact coordinates,
atomic estimate edits, large/zero/missing/coincident counts, written CRUD and
limits, linked targets, unsaved-navigation guards, and 320/390/768/1440px layouts.
Overview checks enforce two number/change/chart pairs, a single chart explanation,
closed secondary details, one relevant exception at most, fewer than 175 rendered
default-content words, both complete desktop trends above 820px, and both mobile
headlines within the first 844px. They also preserve full-note/caveat access,
keyboard snapshot selection and the native forced-colors selector fallback.
Set `REVIEW_ARTIFACTS` to a directory **outside this repository** and add `--visual`
for desktop/mobile screenshots, Overview first-screen images, measured layout/
default-text statistics and a JSON check summary. Word counts exclude closed
disclosures, native option lists and non-rendered accessibility text.
Set `DEMO_URL` to check a deployed copy instead of the local standalone artifact.
Test edits are synthetic and remain inside disposable browser contexts.

Publish only this subtree through the repository's existing main/root Pages
source. The IEEE landing page, calendars, root configuration and Pages settings
must remain unchanged.
