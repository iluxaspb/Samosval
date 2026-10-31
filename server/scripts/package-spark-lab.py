#!/usr/bin/env python3
"""Create a portable, checksum-verified Docker-only Spark lab package.

Source is pinned to an immutable Git commit; no .env, NAS backups or runtime
secrets are bundled. This package is NOT the installable TEST 4.1.2 app.
"""
from pathlib import Path
import hashlib
import re
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
PREFIX = "samosval-spark-lab/"
ALLOWED = {".mjs", ".cjs", ".js", ".json", ".sql", ".html", ".css", ".txt"}
FILES = [
    "server/Dockerfile.spark-lab",
    "server/compose.spark-lab.test.yaml",
    "server/package.json",
    "server/package-lock.json",
    "server/scripts/run-spark-isolated-lab.mjs",
    "server/scripts/verify-spark-lab-compose.mjs",
]
for folder in ("server/sql", "server/src", "server/tests", "test-app/synology"):
    for path in sorted((ROOT / folder).rglob("*")):
        if path.is_file() and path.suffix in ALLOWED:
            FILES.append(path.relative_to(ROOT).as_posix())

def data_at(path: str) -> bytes:
    source = ROOT / path
    if not source.is_file() or source.is_symlink():
        raise SystemExit(f"Unsafe/missing source: {path}")
    if source.stat().st_size > 1500000:
        raise SystemExit(f"File is unexpectedly large: {path}")
    if any(part.startswith(".") for part in Path(path).parts):
        raise SystemExit(f"Hidden source path: {path}")
    return source.read_bytes()

def zip_write(archive, name: str, content: bytes, executable: bool = False):
    z = zipfile.ZipInfo(PREFIX + name, date_time=(2024, 1, 1, 0, 0, 0))
    z.create_system = 3
    z.external_attr = ((0o100755 if executable else 0o100644) << 16)
    z.compress_type = zipfile.ZIP_DEFLATED
    archive.writestr(z, content)

def package(output: Path):
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
    ).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise SystemExit("Unable to pin Git commit")
    dirty = subprocess.check_output(
        ["git", "status", "--porcelain"], cwd=ROOT, text=True
    ).strip()
    if dirty:
        raise SystemExit("Refusing a dirty source tree")

    unique = sorted(set(FILES))
    if len(unique) != len(FILES):
        raise SystemExit("Duplicate package source entries")
    contents = {path: data_at(path) for path in unique}
    shell = data_at("server/scripts/run-spark-lab-on-synology.sh")
    contents["run-spark-lab.sh"] = shell
    contents["SOURCE_COMMIT"] = (commit + "\n").encode("ascii")
    contents["README.txt"] = (
        "Samosval Spark LAB, synthetic-only / no NAS or Firebase data.\n"
        "Commit: " + commit + "\n"
        "1) Extract this ZIP in an empty NEW folder on Synology.\n"
        "2) In DSM Task Scheduler run: sh /path/to/folder/run-spark-lab.sh\n"
        "   (or run that command from SSH with Container Manager enabled).\n"
        "3) Result: SPARK_LAB_SYNOLOGY_REHEARSAL_SUCCESS_CLEANED\n"
        "The runner checks SHA256SUMS, rejects existing project resources,\n"
        "and removes its own Docker project after execution.\n"
        "Never change the Compose project name to an existing NAS project.\n"
        "Do not install SQL015/016 on the working NAS with this package.\n"
    ).encode("utf-8")
    checksums = "".join(
        hashlib.sha256(content).hexdigest() + "  " + path + "\n"
        for path, content in sorted(contents.items())
    ).encode("ascii")
    contents["SHA256SUMS"] = checksums
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w") as archive:
        for path, content in sorted(contents.items()):
            zip_write(archive, path, content, path == "run-spark-lab.sh")
    with zipfile.ZipFile(output) as archive:
        actual = sorted(archive.namelist())
        expected = sorted(PREFIX + path for path in contents)
        if actual != expected:
            raise SystemExit("ZIP package paths changed unexpectedly")
        for path, content in contents.items():
            if archive.read(PREFIX + path) != content:
                raise SystemExit("ZIP verification failed for " + path)
    print("SPARK_LAB_PORTABLE_PACKAGE", commit, len(contents), output.stat().st_size)

if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: package-spark-lab.py /tmp/samosval-spark-lab.zip")
    package(Path(sys.argv[1]).resolve())
