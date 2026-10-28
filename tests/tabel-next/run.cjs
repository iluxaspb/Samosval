const { spawnSync } = require("node:child_process"),
  path = require("node:path"),
  fs = require("node:fs");
const root = path.resolve(__dirname, "../..");
const steps = [
  ["domain", ["node", "tests/tabel-next/domain.mjs"]],
  ["store", ["node", "tests/tabel-next/store.mjs"]],
  ["build", ["python3", "tools/build-test.py"]],
  ["boundary", ["python3", "tests/tabel-next/boundary.py"]],
  ["pwa-cache", ["node", "tests/pwa/service-worker.cjs"]],
];
if (process.argv.includes("--browser"))
  steps.push(["mobile-browser", ["node", "tests/tabel-next/browser.cjs"]]);
if (process.argv.includes("--emulator")) {
  steps.push(
    ["isolated-firestore", ["node", "tests/tabel-next/emulator.cjs"]],
    [
      "integrated-firestore-proposal",
      ["node", "tests/tabel-next/emulator.cjs"],
      { TABEL_NEXT_INTEGRATED: "1" },
    ],
  );
}
const results = [];
for (const [name, [cmd, ...args], extra] of steps) {
  console.log("RUN " + name);
  const start = Date.now(),
    r = spawnSync(cmd, args, {
      cwd: root,
      env: { ...process.env, ...extra },
      encoding: "utf8",
      timeout: 180000,
    });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  results.push({
    name,
    status: r.status === 0 ? "passed" : "failed",
    durationMs: Date.now() - start,
  });
  if (r.status !== 0) process.exitCode = 1;
}
fs.writeFileSync(
  path.join(root, "tests/tabel-next/results.json"),
  JSON.stringify(
    {
      version: "2.0.0-test.1",
      timestamp: new Date().toISOString(),
      baseline: "5bc6325c7344fb543d3388fd7c27fe459ede81dd",
      results,
      notVerified: [
        "Physical Samsung S25/S Pen, Android keyboard and native share",
        "Live Firebase rule deployment and real-device multi-user operation",
        "Long-running battery/FPS measurements",
      ],
      deployment:
        "Draft PR; remote writes disabled by default until rules are approved",
    },
    null,
    2,
  ) + "\n",
);
