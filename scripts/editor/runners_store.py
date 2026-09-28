"""Persistence for the tool palette (user-editable categories).

The factory palette comes from the ``tools`` list of ``latex-runner.json``;
projects without one get a small generic LaTeX and Git palette.
"""
from __future__ import annotations

import json
import pathlib
import re
import shlex
import shutil
import threading
import uuid
from typing import Any, Dict, List, Optional

import project
from storage_utils import atomic_write_json

# Tests and tools may pin a file; otherwise the project's data folder is used.
RUNNERS_FILE: Optional[pathlib.Path] = None
_LOCK = threading.RLock()

SCRIPT_SUFFIXES = (".py", ".ps1", ".jl", ".sh", ".bat", ".cmd", ".R", ".m")


def runners_file() -> pathlib.Path:
    return RUNNERS_FILE or project.current().data_dir / "runners.json"


def _command_executable(command: str) -> str:
    match = re.match(r'\s*(?:"([^"]+)"|(\S+))', command)
    return (match.group(1) or match.group(2)) if match else ""


def _runner(label: str, command: str) -> Dict[str, str]:
    return {"id": uuid.uuid4().hex[:8], "label": label, "command": command}


def _category(name: str, runners: List[Dict[str, str]], collapsed: bool = False) -> Dict[str, Any]:
    return {"id": uuid.uuid4().hex[:8], "name": name, "collapsed": collapsed, "runners": runners}


def generic_palette(active: "project.Project") -> List[Dict[str, Any]]:
    main = active.main
    quoted = '"%s"' % main if " " in main else main
    return [
        {"name": "Document", "tools": [
            {"label": "Recompile (latexmk)", "command": active.compile_command},
            {"label": "Clean rebuild from scratch",
             "command": "latexmk -C %s && %s" % (quoted, active.compile_command)},
            {"label": "Remove auxiliary files", "command": "latexmk -c %s" % quoted},
        ]},
        {"name": "Git", "tools": [
            {"label": "Status", "command": "git status --short --branch"},
            {"label": "Log (last 20)", "command": "git log --oneline --decorate -n 20"},
            {"label": "Diff stat", "command": "git diff --stat"},
        ]},
    ]


def default_document() -> Dict[str, Any]:
    """Seed the palette from the project configuration."""
    active = project.current()
    palette = active.tools if isinstance(active.tools, list) and active.tools else generic_palette(active)
    categories = []
    for group in palette:
        if not isinstance(group, dict):
            continue
        runners = [_runner(str(item.get("label") or item.get("command")), str(item.get("command")))
                   for item in group.get("tools") or [] if isinstance(item, dict) and item.get("command")]
        categories.append(_category(str(group.get("name") or "Tools"), runners, bool(group.get("collapsed"))))
    return {"version": 1, "categories": categories}


def _sanitise(document: Dict[str, Any]) -> Dict[str, Any]:
    """Keep only the fields the UI owns, and guarantee stable ids."""
    categories: List[Dict[str, Any]] = []
    for raw_category in document.get("categories", []):
        if not isinstance(raw_category, dict):
            continue
        runners: List[Dict[str, str]] = []
        for raw_runner in raw_category.get("runners", []):
            if not isinstance(raw_runner, dict):
                continue
            command = str(raw_runner.get("command", "")).strip()
            if not command:
                continue
            runners.append({
                "id": str(raw_runner.get("id") or uuid.uuid4().hex[:8])[:16],
                "label": str(raw_runner.get("label") or command)[:120],
                "command": command[:2000],
            })
        categories.append({
            "id": str(raw_category.get("id") or uuid.uuid4().hex[:8])[:16],
            "name": str(raw_category.get("name") or "Untitled")[:60],
            "collapsed": bool(raw_category.get("collapsed")),
            "runners": runners,
        })
    return {"version": 1, "categories": categories}


def load_runners() -> Dict[str, Any]:
    with _LOCK:
        path = runners_file()
        if path.exists():
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    document = json.load(handle)
                if not isinstance(document, dict):
                    raise ValueError("runner document must be a JSON object")
                return _sanitise(document)
            except (OSError, ValueError, TypeError):
                pass
        document = default_document()
        save_runners(document)
        return document


def save_runners(document: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(document, dict):
        raise ValueError("runner document must be a JSON object")
    with _LOCK:
        clean = _sanitise(document)
        atomic_write_json(runners_file(), clean)
        return clean


def _script_paths(command: str) -> List[str]:
    """Relative script paths a command refers to, for an existence check."""
    try:
        tokens = shlex.split(command, posix=False)
    except ValueError:
        tokens = command.split()
    found = []
    for token in tokens:
        cleaned = token.strip('"\'')
        if cleaned.lower().endswith(tuple(s.lower() for s in SCRIPT_SUFFIXES)) and not re.match(r"^[A-Za-z]:|^/", cleaned):
            found.append(cleaned.replace("\\", "/"))
    return found


def inspect_runners(repo_root: pathlib.Path) -> Dict[str, Any]:
    """Report current availability without running tools or replacing custom entries."""
    document = load_runners()
    compile_command = " ".join(project.current().compile_command.split())
    executables: Dict[str, Optional[str]] = {}
    for category in document["categories"]:
        for runner in category["runners"]:
            command = runner["command"]
            executable = _command_executable(command)
            if executable not in executables:
                executables[executable] = shutil.which(executable)
            warnings = []
            if not executables[executable]:
                warnings.append("Program not found: " + executable)
            for relative in _script_paths(command):
                if not (repo_root / relative).is_file():
                    warnings.append("Script not found: " + relative)
            runner["available"] = not warnings
            if re.search(r"latexmk\s+-c\b", command) and "&&" not in command:
                warnings.append("Removes auxiliary files, including SyncTeX; recompile afterwards")
            runner["diagnostic"] = " · ".join(warnings)
            # The editor's own compile gets the progressive PDF preview.
            runner["kind"] = "compile" if " ".join(command.split()) == compile_command else "command"
    return document
