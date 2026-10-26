# Rank celebration — shared production / TEST presentation

Canonical `rank-celebration.js` and `.css` are the exact blocks installed in both
production `index.html` and modular TEST. They contain presentation only: no
score/reward/trip writes and no coin-flight changes. All images/audio are original,
inline/procedural; no external asset requests.

The card is centered, does not intercept operational clicks, closes immediately,
and automatically leaves after 3.6 seconds. Four rockets / 264 bounded sparks;
soft boom/crackle follows actual animation frames. Sound and effects preferences
remain independent: static/reduced-motion cards get one short gentle cue when
sound is on. Close, hidden page, account/access/admin changes and navigation clean
up every owned canvas, frame, timer and audio node. Shared coin audio is not closed.

## Primary visual references
Actual official images were inspected, not reused:
- [Riot Games — Act II Ranks](https://playvalorant.com/en-us/news/dev/act-ii-ranks-and-competitive-changes/): central emblem, metal frame, dark background and clear hierarchy.
- [Supercell — Path of Legends](https://supercell.com/en/games/clashroyale/blog/release-notes/new-update-october-2022/): a single recognizable gold league insignia.

The laurel/hexagonal crest and midnight/gold composition here are original. Sound
is synthesized WebAudio, not a recording. Design choice is editorial judgment,
not a claim of universal player preference.

## Exact integration and invariance
From the repository root:

```sh
# Dry-run by default; --apply is explicitly required to write.
python3 tools/rank-celebration/apply-celebration.py --root . --proof /tmp/rank-dry-run.json
python3 tools/rank-celebration/apply-celebration.py --root . --apply --proof /tmp/rank-applied.json
python3 tools/rank-celebration/tests/verify-installed.py --root .
```

The strict idempotent generator updates only existing celebration code/style and
the exact sound-switch display label («аплодисменты» → «салют»). Before any write,
it verifies that all remaining JavaScript/CSS is byte-identical, including reward
calculation, rank decisions/queue and five-coin sequential flight. It does not
build, update versions, alter config/rules/backend or publish. Never copy a whole
prepared game-coins file over newer economics fixes.

## CI / local deterministic checks
From the repository root:

```sh
npm --prefix tools/rank-celebration install --ignore-scripts
python3 tools/rank-celebration/tests/verify-installed.py --root .
python3 tools/rank-celebration/tests/fixture.py
node tools/rank-celebration/tests/runtime.cjs
python3 -m pip install -r tools/rank-celebration/requirements.txt
python3 -m playwright install --with-deps chromium
python3 tools/rank-celebration/tests/browser.py
```

`runtime.cjs` uses jsdom + mock Canvas/Audio graph, not a real renderer. `browser.py`
uses sandbox-enabled Chromium and normal autoplay restrictions; genuine preview
button clicks unlock audio. No security-disabling retries or autoplay override.
A failed browser launch is a failed command, not a skipped pass.

Upload `tools/rank-celebration/tests/results/` even on CI failure. It contains JSON
results, PNG screenshots, real WebM video, interactive isolated preview, and two
OfflineAudioContext WAVs (fireworks/cue). Review pixels/motion and sound in addition
to numeric peak/RMS/clipping/fade checks. Fixture state is synthetic and has no
Firebase or business-data writes. Read [test details](tests/README.md).
