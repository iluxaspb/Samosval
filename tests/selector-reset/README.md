# Built-in empty search on opening

From the repository root; these checks never build, publish, migrate stored flags,
change release versions, or access live Firestore.

```sh
node tests/selector-reset/builtin.cjs
NODE_PATH=/path/to/dependencies/node_modules node tests/selector-reset/dom.cjs
SELECTOR_BROWSER=/path/to/chromium node tests/selector-reset/browser.cjs
```

`builtin.cjs` needs only Node. `dom.cjs` additionally needs JSDOM; it executes the
actual markup/inline handlers, selector functions and TEST patch-list renderer.
`browser.cjs` needs Playwright and installed Chromium, and **requires the Chromium
sandbox**. A denied launch is an unrun browser test: do not disable security to
retry. All browser network requests are blocked, service workers are disabled,
and config writes throw. Desktop/mobile widths are viewport emulation, not phones.

Coverage: TEST and production; old `selector_reset: false` cannot suppress the
reset; query `111`, normal filtering and selection; repeated opening; close-cross,
Done and backdrop cancellation/reopen; permission denial and missing shift leave
query/modal unchanged; no shift/directory/config mutation. TEST retains all 43
unrelated registry/report rows (42 non-legacy toggles), and no reset toggle.

For strict byte-scope proof, capture the four owned source files **before**
integration, retaining relative paths, then run:

```sh
node tests/selector-reset/preservation.cjs /path/to/pre-integration-tree
# If other authorized edits subsequently modify production HTML:
node tests/selector-reset/preservation.cjs /path/to/pre-integration-tree /path/to/post-reset-index.html
```

This compares actual Buffer prefixes/suffixes outside the one changed function
and prints their SHA-256 digests. It also proves that the only registry/config
edits remove `selector_reset`, with all other patch metadata preserved. The
optional HTML must be the immediately post-reset snapshot, not the later release.

These focused checks do not establish full-app startup, real authentication,
cloud rules, deployment, PWA update activation, or physical-device behavior.
