"""Check a fresh clone and optionally build and inspect its fictional sample."""
from __future__ import annotations

import argparse
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts" / "cv.py"
SAMPLE = ROOT / "output" / "example-application"


def run(*args: str) -> bool:
    completed = subprocess.run([sys.executable, str(CLI), *args], cwd=ROOT)
    return completed.returncode == 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", action="store_true", help="build and inspect all sample PDFs")
    args = parser.parse_args()
    problems: list[str] = []
    print("Python:", sys.version.split()[0], sys.executable)
    if sys.version_info < (3, 10):
        problems.append("Python 3.10 or newer is required.")
    try:
        from pypdf import PdfReader
    except ImportError:
        PdfReader = None
        problems.append("pypdf is missing. Run python scripts/bootstrap.py.")
    missing_tools = []
    for tool in ("git", "latexmk", "lualatex"):
        location = shutil.which(tool)
        print(f"{tool}: {location or 'missing'}")
        if not location:
            problems.append(f"{tool} is missing from PATH.")
            missing_tools.append(tool)
    if not run("list") or not run("check"):
        problems.append("The application register or sample has a problem.")
    if args.build and not problems:
        if not run("build", "--all"):
            problems.append("The LaTeX build failed. Read the error above and the logs in build/apps/.")
        else:
            expected = {
                "John_Doe_Sample_CV.pdf": 2,
                "John_Doe_Sample_Motivation_Letter.pdf": 1,
                "John_Doe_Sample_Certificate_Placeholders.pdf": 3,
            }
            for filename, page_count in expected.items():
                path = SAMPLE / filename
                if not path.is_file():
                    problems.append(f"Missing sample PDF: {path}")
                    continue
                try:
                    reader = PdfReader(str(path), strict=True)
                    pages = len(reader.pages)
                    extracted = "\n".join(page.extract_text() or "" for page in reader.pages)
                    compact_text = re.sub(r"[^A-Za-z]+", "", extracted).upper()
                    print(f"{filename}: {pages} page(s), {path.stat().st_size} bytes")
                    if pages != page_count:
                        problems.append(f"{filename} has {pages} pages, expected {page_count}.")
                    if filename.endswith("Placeholders.pdf") and compact_text.count("SAMPLEPLACEHOLDER") != 3:
                        problems.append("The certificate placeholder text is incomplete.")
                    if filename.endswith("CV.pdf") and "FICTIONALSAMPLE" not in compact_text:
                        problems.append("The CV is missing its sample marker.")
                except Exception as exc:
                    problems.append(f"Could not read {filename}: {exc}")
    if problems:
        print("\nProblems:")
        for problem in problems:
            print("-", problem)
        if missing_tools:
            print("\nInstall the missing tools; a TeX distribution with LuaLaTeX and latexmk is required. Then rerun this command.")
        return 1
    print("\nWorkspace ready. Start the Runner and open http://127.0.0.1:8053/.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
