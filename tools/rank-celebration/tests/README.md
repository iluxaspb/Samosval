# Rank celebration acceptance

These tests load the exact isolated `../rank-celebration.js` and `.css` blocks.
The app chrome and session/settings are **synthetic local fixtures**. No Firebase,
rewards, coin flights, trip calculations, backend, rules or production data are run.
No external asset or audio request is permitted. This is UI/effects acceptance,
not an end-to-end authorization or business-data test.

## Deterministic lifecycle checks (locally runnable)

```sh
python3 tools/rank-celebration/tests/fixture.py
npm --prefix tools/rank-celebration install --ignore-scripts
node tools/rank-celebration/tests/runtime.cjs
```

`runtime.cjs` requires jsdom 26. It checks real effect-source control flow with a
mock Canvas2D and WebAudio graph. It verifies four launch/four burst calls, bounded
work, cleanup, re-entry, navigation, account changes, independent settings, the
static-card cue, stalled frames, delayed/suspended/muted audio and optional APIs.
It does **not** prove pixel layout, final audio quality, clipping or browser behavior.

## Actual Chromium, screenshots, video and PCM

```sh
python3 -m pip install playwright==1.57.0
python3 -m playwright install --with-deps chromium
python3 tools/rank-celebration/tests/browser.py
```

Pass `--chromium /path/to/chromium` or `AUDIT_BROWSER` to use a known browser.
`--source-root` points to the directory containing the two source blocks.
`--output` selects an evidence directory. The default is `tests/results`.
`--no-video` is diagnostic-only, not final acceptance. Chromium launches with
`chromium_sandbox=True`; there are no sandbox-disabling flags, autoplay-policy
bypasses or security-relaxing retries. Each sound-enabled browser context is
unlocked by a genuine click on the preview button, preserving normal autoplay
requirements.

Evidence includes:
- `browser-report.json`: real browser version, source SHA-256 digests, assertions.
- Desktop, mobile, narrow-mobile, landscape and reduced-motion PNGs.
- A short real Chromium WebM, with the full launch → burst → dismissal sequence.
- `fireworks-procedural.wav`: 44.1 kHz stereo PCM rendered by real
  OfflineAudioContext from the exact sound function and four-rocket timeline.
- `cue-procedural.wav`: the separate gentle static-card cue when effects/motion
  are disabled but the independent sound preference remains enabled.
- Audio peak/RMS, non-finite/clipping counts, tail energy, 50 ms RMS windows and a max adjacent-sample delta ceiling of .2.
  These are technical safety checks, not a claim of subjective sound quality.
- `rank-preview.html`: self-contained interactive preview (click **Посмотреть**).

The sound test uses a fixture-only OfflineAudioContext proxy for a running state
and scheduled clock. Production logic is not modified to enable test hooks.
The public browser test invokes the same sound code from actual animation frames;
those launch/burst timestamps are recorded separately.

This environment's local Chromium launch is blocked by executor OS/socket
restrictions. The sandboxed launch must remain enabled; do not work around this
with `--no-sandbox` or other security-disabling flags.
Therefore local real-browser results must not be claimed. Run the browser script
on the authorized GitHub CI runner and inspect its PNG/WebM/WAV artifacts before
publication. A failed browser launch remains a failing command, never a skipped pass.
