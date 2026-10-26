# Shared paper viewer — isolated UI change

## Scope

The published TEST3.1.21 Summary is the visual reference. Its inline sheet and hold control are unchanged. Archive adopts that paper markup, 0.65 compact scale, numbered column, Russian plates, margins and 44 px lower-right hold-only control. Both paper taps use one copy of the existing Summary zoom/pan/full-screen viewer; no new toolbar action was added. Archive restore/delete/save remain outside the paper.

On date-open, Archive captures the selected record's logs, TTN and both report variants. Saved `truckName` is preferred over the current directory and a recognizable Russian plate suffix is rendered using the existing plate helper. Legacy active trucks with no saved trip/name still use a directory label copied once at date-open; no historical name is invented. Refreshes of the same open date, current shift/status/directory changes, zoom and PNG do not replace the capture. Closing and reopening takes a new capture. Summary remains live inline and becomes frozen only after tapping the paper.

Controlled duplicate badge text is red Latin `D`, with accessible `Дубликат`; conditions and user-authored text are unchanged. The old two archive and three report/export templates are also updated, not only the new viewer.

No history/reward/game/data-write code is altered. No Firebase, external network or live records are used by these tests.

## Parent integration

From this payload directory, run:

```sh
python3 tools/apply-paper-viewer.py /path/to/target
```

Or use `--test-only` / `--production-only`. It changes only:

- `test-app/src/features/summary-viewer.js`
- `test-app/src/features/summary-hold.js` (approved published TEST source)
- `test-app/src/core/13-reports.js` (three exact badge-label templates)
- `test-app/src/core/14-archive.js` (two exact badge-label templates)
- `index.html` (two old viewers -> one shared viewer; approved hold module; five legacy badge labels)

The parent owns version labels, release history, build, publication and any separately authorized celebration patch. Do **not** copy this payload's whole source tree over integration-current.

## Verification

```sh
python3 tools/build-test.py
node tests/full-audit/reports-summary.cjs
node tests/paper-viewer/static.cjs
node tests/pwa/service-worker.cjs
node tests/photo-removal/build.cjs
python3 tests/paper-viewer/create-fixtures.py
npm install --prefix /tmp/summary-qa --no-audit --no-fund playwright@1.56.1 pngjs
NODE_PATH=/tmp/summary-qa/node_modules node tests/paper-viewer/browser.cjs
```

Use `SUMMARY_BROWSER` for an installed Chrome/Chromium, or Playwright's supported browser installation. The harness explicitly enables the Chromium sandbox and supplies no security-disabling/autoplay flags.

`benchmark.html` is a frozen local fixture of the approved TEST3.1.21 Summary, using exact source and local fixture data. Never regenerate it from code under test. `create-fixtures.py` reads current TEST source and current `index.html` to generate `test.html` and `production.html`. The browser runner serves only local files and aborts non-local requests.

Browser coverage: desktop and mobile; regular and GAI Summary pixel identity; exact matching Archive markup; real date route; button geometry/position and short/release/cancel/drift/800 ms/long hold; common zoom/drag/wheel/double-tap/fit/close/Escape; no live-data mixing between two archive dates or current shift; saved names/plate and permissions; actual full-width/full-height PNG download with stable date/content despite changes during rasterization.

Evidence is written to `tests/paper-viewer/results/`.

## Current verification status

Local syntax, VM duplicate truth tables, existing Summary full hold/cancellation suite, deterministic TEST build, service-worker/cache integrity and photo-free build passed. Production scope proof confirmed all non-viewer bytes unchanged after normalizing the five badge templates (`scope-proof.json`). Browser execution in this workspace is blocked by the local browser sandbox/runtime; file:// is organizationally blocked and cloud browser cannot reach workspace localhost. Do not bypass those restrictions. The supplied browser harness must run in the approved GitHub CI environment before publication.
