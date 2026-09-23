# Application resource estimates

[Open the published dashboard](https://rohit-2002-28.github.io/qdk-qce26-tutorial/resource-estimates/).

The current dataset replaces the earlier fictional examples with the application
names and counts supplied for this review. The original tables are represented
in `src/data.json`; all counts are exact decimal strings, not floating-point
measurements. Source-image hashes identify the four supplied screenshots without
publishing the image files or local filesystem paths.

## Source data and assumptions

| Application | Logical ops | Physical ops (w/o move) | Logical qubits | Physical qubits |
|---|---:|---:|---:|---:|
| Spin Dynamics Floquet-3x3 | 638 | 324,305 | 9 | 220 |
| Spin Dynamics Floquet-4x3 | 834 | 338,559 | 12 | 240 |
| Lasers (Dicke superradiance) | 395 | 109,357 | 4 | 100 |
| IQPE extended Hubbard Ethylene | 405 | 167,655 | 5 | 100 |
| IQPE extended Hubbard Cyclobutadiene | 1,054 | 492,166 | 9 | 220 |
| IQPE H2 | 580 | 185,312 | 5 | 140 |
| IQPE LiH | 626 | 191,352 | 5 | 140 |
| IQPE N2 | 6,232 | 1,698,744 | 9 | 220 |

All seven source metrics, including the three gate categories, remain in All
metrics and the raw seed. Systems are Magnet Models, Laser Models (Dicke), Model
Hamiltonian Energy Estimation (Hubbard Model), and Small Chemistry Problems.

The source states: **emulator runs use Clifford-rounding; non-Clifford angles are
rounded to the nearest pi/2 multiple.** This is an approximation of the original
circuits, not evidence of their full non-Clifford correctness.

**Physical operations retain the source qualifier "w/o move".** The
[QDK neutral-atom model](https://github.com/microsoft/qdk/blob/313517959aec21d9f6a9ad420bf75684807e0b2a/source/qdk_package/qdk/qre/models/qubits/_neutral_atoms.py)
defines `PHYSICAL_MOVE` as explicit atom transport with velocity, acceleration
and handoff parameters. The
[instruction definitions](https://github.com/microsoft/qdk/blob/313517959aec21d9f6a9ad420bf75684807e0b2a/source/qre/src/trace/instruction_ids.rs)
give `SWAP` and `PHYSICAL_MOVE` different identities. Therefore the dashboard
does **not** relabel this as "all routing/SWAP gates excluded", nor treat it as a
full transport-inclusive operation total. The producing report's precise
counter/filter was not supplied, so its exact exclusion cannot be independently
verified from these screenshots. Counts alone do not establish execution time.

The user confirmed **4 September 2026** as the estimate date for all eight
supplied records (original notation `09-04-2026`, explicitly clarified as
September 4). **23 September 2026 is only the receipt date.** No earlier snapshots,
runtime models, targets, owners, maturity assessments, outlook commitments or
hardware/correctness results were supplied; those values are not fabricated.
New engineering estimates require their actual as-of date.

## Reading the dashboard

- Overview places **Application candidate before System**. The grouped
  selectors preserve the four system families and eight real applications.
  Visible labels use application and model-family names only, not numbered
  application/system codes. Stable internal IDs remain in links and raw audit
  records so label changes do not change record identity.
- The **Overview** selector switches between the selected application and
  **Global overview - all applications**. Global overview uses one chart with
  a Logical operations / Logical qubits metric selector, avoiding a mixed-scale
  dual axis. Eight distinct colors, marker shapes, dash patterns and a labeled
  key identify candidates. Checkboxes isolate series; keyboard/click Details
  and an exact-data table also distinguish coincident points.
- The initial global chart shows one **4 September 2026** point per application,
  not a fabricated historical trend. As records are saved privately, lines
  connect compatible dated records only. Missing values, undated imports and
  changed configurations are never silently interpolated.
- **Application Roadmap and Progress** follows the supplied five-stage diagram:
  specification, qubit fit, logical operations, correctness, and hardware
  demonstration. Initial statuses describe the evidence supplied, not invented
  completion percentages. A stage can be edited in Engineering > Roadmap.
- Resource details & assumptions retains physical current/target counts, the
  movement-excluded operation ratio, qubit overhead, timing/gate definitions,
  source and the full note. Compare retains both eight-candidate scatter plots.
- **Updates & outlook** starts empty rather than retaining fictional notes.
  Engineers can create/edit/reorder/archive/restore up to four active briefing
  bullets and manage milestones. Outlook uses **sprints or flexible planning
  horizons**, not calendar deadlines. A linked target shares its value, basis
  and planning window with Estimates; it is not copied into a second input.
- Copy view link preserves the published candidate/snapshot, system filter,
  tab and global metric mode. It never embeds private counts, notes, owners or
  the database. A private estimate is explicitly replaced with a link to its
  original supplied snapshot; it is not presented as publicly published data.

## Private raw-input database

GitHub Pages serves a read-only published snapshot. It does not host or expose
the private database, and its engineering Save controls are disabled.

Use the dependency-free local workspace for durable engineering entry:

```powershell
python .\resource-estimates\server.py `
  --database "$env:LOCALAPPDATA\ResourceEstimates\engineering.sqlite" `
  --port 8765
```

Open **http://127.0.0.1:8765/**, then choose Engineering.

- The server binds to loopback only; the SQLite file must be outside the
  repository/served directory. Do not place or commit a live database under
  `resource-estimates/`.
- Valid estimate batches, written updates, roadmap assessments and archive/
  order actions are saved atomically with their raw submission. Count strings,
  including scientific-notation or grouped input, are preserved separately
  from normalized exact values. Original snapshots and earlier written
  revisions remain in history.
- **Engineering > Raw data** shows saved submissions and offers complete JSON
  export and a consistent SQLite database download. Both are private local
  endpoints. Back up the database; browser reload is not a reset.
- Revision checks reject stale writes from a second tab rather than overwrite
  another engineer's work. If a connection fails during Save, reload saved data
  before retrying: an unconfirmed network response is not proof of rollback.
- The seed is loaded once into a new database. Restarting does not replace
  saved work with the source file, and "Reload saved data" never deletes history.
  The original pre-clarification import is retained in the existing private
  database. The user's date confirmation is recorded as an append-only source
  event with new dated snapshots; it does not rewrite the original raw import.

This is a **single-computer private workspace**, not an Internet-facing shared
team service. Loopback/Origin/token checks protect the browser boundary; they
are not organizational sign-in, per-user authorization, disk encryption or
protection against another process with access to the same local account.
A shared multi-computer deployment needs approved hosting, authentication and
backups; do not expose this server by changing its binding or adding a tunnel.
The workspace navigation switch is not access control.

Private saves do **not** automatically publish to GitHub. Public updates require
an explicit review of which snapshot data may be released, followed by rebuilding
the static artifact. Never copy a raw database export wholesale into the public
source or attach private engineer submissions to a public issue.

## Standalone build

Author `src/shell.html`, `styles.css`, `app.js` and `data.json`, then run:

```powershell
node .\resource-estimates\build.mjs
node .\resource-estimates\build.mjs --check
```

Commit the generated `index.html` with its authoring changes. All browser runtime
assets and the reviewed source snapshot are embedded; the HTML opens standalone
from disk in read-only mode. No framework, package installation or new Pages
workflow is required. The Python service serves this same artifact.

## Checks

Python database tests use only the standard library:

```powershell
python -m unittest discover -s .\resource-estimates\tests -p test_database.py
```

Browser checks reuse an existing Playwright installation and Edge. Set
`PLAYWRIGHT_MODULE` to the installed Playwright module directory if it is not
resolvable here; optionally set `EDGE_PATH` to the Edge executable.

```powershell
node .\resource-estimates\tests\smoke.cjs --private
```

The private browser checks start a disposable loopback server with a temporary
database outside the repository, then remove only that test directory. They
never write to the engineer's real database. Coverage includes all 56 supplied
counts and real names, honest history, source qualifiers, links/back-forward,
keyboard point details, distinct global series, exact raw-input persistence,
atomic invalid saves, stale revisions, editor/history/limits, sprint targets,
roadmap propagation, restart persistence and responsive layouts.

Set `REVIEW_ARTIFACTS` to a directory outside the repository and add `--visual`
for desktop/mobile screenshots and a JSON result report. Set `DASHBOARD_URL`
to check a deployed read-only snapshot; omit `--private` for that pass.

All repository changes and publication stay inside `resource-estimates/`.
The IEEE landing page, calendars, root configuration and Pages settings must
remain unchanged.
