# Local browser acceptance

```sh
python3 tools/build-test.py
node tests/full-audit/browser-support.test.cjs
NODE_PATH=/tmp/samosval-qa/node_modules \
FIRESTORE_EMULATOR_JAR=/absolute/path/cloud-firestore-emulator.jar \
node tests/full-audit/browser-run.cjs

# Separate pinned-old → current release activation acceptance (Python Playwright):
python3 tests/pwa/update-browser.py --old-dir /path/to/d355556-artifact
# Infrastructure/integrity check only, with no browser launch:
python3 tests/pwa/update-browser.py --old-dir /path/to/d355556-artifact --self-test
```

Dependencies: Node 22, Java 21, `firebase@10.8.0`,
`@firebase/rules-unit-testing@3.0.4`, `playwright@1.56.1`, installed Chromium,
and the Firestore emulator JAR. The GitHub audit workflow installs these.
`AUDIT_FIRESTORE_PORT` defaults to 8099; HTTP uses an allocated loopback port.
`AUDIT_BROWSER` optionally selects an installed Chromium executable.

The suite **requires the Chromium sandbox**. A sandbox launch denial is a failed,
unrun acceptance test; do not retry with security disabled. The infrastructure
self-test needs no browser/emulator/npm dependencies and is not a browser pass.

## Isolation and limitations

- Starts and owns one loopback emulator under `demo-samosval-browser-audit`.
- Uses real Firestore SDK, transactions, IndexedDB, and
  `firestore-timesheet-test.rules`; only seed/read verification bypasses rules.
- Firebase Auth is an explicit UI stub with generated `example.test` users and
  an inert fixture password. This does **not** test real Auth or email delivery.
- The HTTP server changes only deployment identifiers/configuration in served
  JavaScript, and regenerates worker hashes for those exact response bytes.
  Repository code and the worker's integrity checks are not disabled/modified.
- All browser non-loopback/non-test-origin requests are blocked. CSP also
  constrains service-worker connections, which can bypass Playwright routing.
  Storage is disabled, MAX has no destination/token, and hardware permissions
  are denied. No external messages, uploads, real credentials, or exploit
  payloads are involved.
- Desktop and mobile **viewport emulation** are tested, not physical phones,
  camera/GPS, production deployment, or PWA store/OS installation. Release-update
  activation is tested separately by sandbox-required `tests/pwa/update-browser.py`.
  The older `tests/pwa/browser.cjs` harness is deliberately not invoked here.

## Covered interactions

- Invalid/empty login, registration pending → admin approval, disabled gate,
  logout cancellation/confirmation; repeated registration submit.
- Admin-only release/history and PWA diagnostics; real emulator role promotion
  and revocation while history is open. Missing camera/photo/Storage/manual-drawing
  controls and modules remain explicit assertions.
- Shift chooser cancel/reopen/start; line selection and search-reset; actual
  pointer hold cancellation/arrival/load/TTN and confirmed undo; cooldown.
- Both visible Summary sheets and nonblank full-screen viewers; short/released
  pointer holds do not switch the paper icon, an 800 ms+ hold switches once;
  moved-away cancellation, zoom/fit, Escape/close/reentry. The approved Summary
  benchmark intentionally hides legacy export rows: CSV is a real download via
  the callable application API, **not a visible-button test**. Canceled edit;
  close cancellation/repeated close;
  archive search/open/close/reopen and canceled/repeated restore. Counts are
  verified against the emulator, not merely optimistic UI.
- A generated 40-trip archive fixture is exported through the real download
  button and bundled rasterizer. PNG signature/chunks/dimensions and browser
  decoding are verified, including nonblank rightmost columns beyond viewport/A4
  width. The actual PNG is retained. Archive zoom/fit and icon-only 800 ms hold GAI switching
  are exercised; no live MAX destination is configured.
- Local settings persistence; theme preview/next/close restoration; game and
  arcade toggles; reward defaults, invalid-value rejection, real transaction save,
  no duplicate schedule on repeated save, reload persistence; arcade navigation
  without stakes.
- Timesheet equipment + two-person crew, repeated assignment without duplicate
  rows, independent machine/crew hours, repeated material submit, month/history.
- Real cached PWA cold start offline, three queued line actions, full browser
  close/relaunch while offline, reconnect and replay/reload without duplicates.

## Evidence and exit status

`tests/full-audit/results/browser/report.json` gives each case/step status and
explicit fixture/exclusion details. Screenshots, Playwright trace ZIPs, exported
CSV, emulator log, and failure DOM/state live beside it and are uploaded by CI.
Browser profiles are test-created temporary directories and are removed at end.
Any failed/unrun case, browser exception, disallowed network attempt, CSP
violation, missing dependency, startup failure or timeout yields a nonzero exit.
Promise rejections and CSP violations are streamed before navigation, so reloads
cannot erase a failure. The infrastructure test validates the fixture/error stream
and download parser but does not claim to have rendered a PNG or run a browser.
The harness attempts to close browser clients, HTTP connections and its owned
emulator on every completion path. No live project is ever targeted.

## Pinned release upgrade fixture

The old artifact is commit `d355556c72f81f6f104aa3bac9b28f584dbc0c9a`
(TEST 3.1.17, build `93c3fea4099fbd8a`). CI fetches and archives that commit;
the new label/build come from the current generated HTML/manifest, not fixed
3.1.18 strings. The Python suite verifies every original input hash, then serves
inert demo configuration with matching worker/manifest hashes and exact-origin
routing plus worker CSP. Auth is a signed-out local stub; synthetic empty-UID
role checks cover UI gating only and are **not** Firestore authorization tests.
The pinned old artifact's HTML says 3.1.17 while its history module hardcodes the
runtime header to 3.1.16. This historical discrepancy is derived from its unchanged
module and recorded separately; current HTML/runtime labels must match strictly.

It checks the waiting update does not force an active tab to reload, activation
after that tab closes, byte-for-byte preservation of 24 synthetic pending entries,
IndexedDB and production cache/localStorage sentinels, camera-free offline reload,
mixed-HTML hash rejection/retry, and a fresh installation. Queue replay belongs to
the real emulator suite above. `test-results/upgrade-report.json`, traces
and screenshots are separate evidence; `--self-test` explicitly reports browser
not run. Neither suite retries a denied launch with the sandbox disabled.
