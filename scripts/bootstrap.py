"""Prepare a local virtual environment, then verify the sample workspace."""
from __future__ import annotations

import pathlib
import subprocess
import sys
import venv

ROOT = pathlib.Path(__file__).resolve().parents[1]


def main() -> int:
    if sys.version_info < (3, 10):
        print("Python 3.10 or newer is required.")
        return 1
    environment = ROOT / ".venv"
    python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    if not python.is_file():
        print("Creating", environment)
        venv.EnvBuilder(with_pip=True).create(environment)
    print("Installing Python requirements...")
    if subprocess.run([str(python), "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")]).returncode:
        return 1
    print("Checking and building the fictional sample...")
    return subprocess.run([str(python), str(ROOT / "scripts" / "doctor.py"), "--build"], cwd=ROOT).returncode


if __name__ == "__main__":
    raise SystemExit(main())
