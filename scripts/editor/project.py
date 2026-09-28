"""Project configuration for LaTeX Runner CV Edition.

A project is a folder that holds LaTeX documents; ``latex-runner.json`` in that
folder describes it (output directory, protected paths, optional panels). The
CV Edition adds one idea to the source Runner: the *active document*. A CV
repository has many root documents (one per application and document), so the
file that is compiled, previewed and synchronised with SyncTeX is chosen at run
time by ``select_document`` instead of being fixed in the configuration.

Discovery order for the project root:
  1. an explicit ``--root`` argument (``load(root)``),
  2. the ``LATEX_RUNNER_ROOT`` environment variable,
  3. the nearest parent of the app folder that contains ``latex-runner.json``,
  4. two levels above the app (``<root>/scripts/editor``).
"""
from __future__ import annotations

import copy
import json
import os
import pathlib
import threading
from typing import Any, Dict, Iterable, List, Optional, Tuple

APP_NAME = "LaTeX Runner CV Edition"
APP_VERSION = "3.2.1-cv.1"
APP_ID = "latex-runner"
CONFIG_NAME = "latex-runner.json"
APP_DIR = pathlib.Path(__file__).resolve().parent

# Folders never shown in the explorer nor walked for change detection.
BASE_IGNORED = {
    ".git", ".github", ".vscode", ".idea", ".venv", "venv", "env", "node_modules",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".ipynb_checkpoints",
}

DEFAULT_CONFIG: Dict[str, Any] = {
    "name": "",
    "main": "main.tex",
    "outDir": "build",
    # Files the editor opens first, in order of preference.
    "entryFiles": [],
    "bibliography": [],
    "figureDirs": ["assets"],
    "dataDir": ".latex-runner/data",
    # Explorer/state walk: extra folders to leave out (names or relative paths).
    "ignore": ["build", "output", "tmp"],
    "protected": {
        # Entries ending in "/" protect a folder's contents; other entries match
        # one exact path (file or folder). Case-insensitive, relative to root.
        "noDelete": [],
        "confirmWrite": [],
    },
    "compile": {
        "engine": "lualatex",
        "command": "",
    },
    "features": {
        # "auto" shows the AI workspace when agent agreements exist.
        "aiWorkspace": "auto",
        # The Applications workspace: application register and block editor.
        "applications": True,
    },
    "ai": {
        "root": ".agents",
        "contractsActive": ".agents/contracts/active",
        "contractsArchive": ".agents/contracts/archive",
        "prompts": ".agents/prompts",
        "research": "docs",
        "handoff": ".agents/memory/change_log.md",
        "governance": [
            ["AGENTS.md", "Repository agreement"],
            ["CLAUDE.md", "Claude Code entry point"],
            [".agents/memory/cv_facts.md", "Verified facts"],
            ["TODO.md", "Open items"],
            [".agents/memory/change_log.md", "Change log"],
        ],
    },
    # Optional default tool palette: [{"name": ..., "tools": [{"label", "command"}]}].
    "tools": [],
}

ENGINES = ("lualatex", "xelatex", "pdflatex")


def _merge(base: Dict[str, Any], extra: Dict[str, Any]) -> Dict[str, Any]:
    merged = copy.deepcopy(base)
    for key, value in (extra or {}).items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge(merged[key], value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def _clean_rel(value: Any, fallback: str = "") -> str:
    text = str(value if value is not None else fallback).replace("\\", "/").strip().strip("/")
    return text or fallback


def _read_config(path: pathlib.Path) -> Dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError("%s is not valid JSON: %s" % (path, exc)) from exc
    if not isinstance(data, dict):
        raise ValueError("%s must contain a JSON object" % path)
    return data


def detect_engine(root: pathlib.Path, main: str) -> str:
    """Guess the TeX engine from the preamble: fontspec needs Lua- or XeLaTeX."""
    try:
        text = (root / main).read_text(encoding="utf-8", errors="replace")[:20000]
    except OSError:
        return "lualatex"
    header = text.split("\\begin{document}", 1)[0]
    for line in header.splitlines():
        stripped = line.strip()
        if stripped.startswith("%") and "program" in stripped and "=" in stripped:
            for engine in ENGINES:
                if engine in stripped.lower():
                    return engine
    return "lualatex"


class Project:
    """Resolved configuration of one LaTeX project."""

    def __init__(self, root: pathlib.Path, config: Dict[str, Any], config_path: Optional[pathlib.Path]) -> None:
        self.root = root.resolve()
        self.config_path = config_path
        self.config = _merge(DEFAULT_CONFIG, config)
        cfg = self.config
        for key in ("main", "outDir", "dataDir"):
            self._validate_path(cfg.get(key), key)
        for key in ("entryFiles", "bibliography", "figureDirs"):
            for value in cfg.get(key) or []:
                self._validate_path(value, key)
        self.name = str(cfg.get("name") or self.root.name)
        data_dir = _clean_rel(cfg.get("dataDir"), ".latex-runner/data")
        self.data_dir = (self.root / data_dir).resolve()
        self.bibliography = [_clean_rel(item) for item in cfg.get("bibliography") or [] if item]
        self.figure_dirs = [_clean_rel(item) for item in cfg.get("figureDirs") or [] if item]
        self.entry_files = [_clean_rel(item) for item in cfg.get("entryFiles") or [] if item]
        protected = cfg.get("protected") or {}
        self.no_delete = [str(item).replace("\\", "/").lstrip("/") for item in protected.get("noDelete") or []]
        self.confirm_write = [str(item).replace("\\", "/").lstrip("/") for item in protected.get("confirmWrite") or []]
        for essential in (CONFIG_NAME, ".latexmkrc", "latexmkrc"):
            if essential not in self.no_delete:
                self.no_delete.append(essential)
        self.ignored = set(BASE_IGNORED)
        self.ignored_paths = set()
        for item in cfg.get("ignore") or []:
            text = _clean_rel(item)
            if not text:
                continue
            if "/" in text:
                self.ignored_paths.add(text.casefold())
            else:
                self.ignored.add(text)
        compile_cfg = cfg.get("compile") or {}
        self.configured_command = str(compile_cfg.get("command") or "")
        engine = str(compile_cfg.get("engine") or "").lower()
        self.fixed_engine = engine if engine in ENGINES else ""
        features = cfg.get("features") or {}
        ai_flag = features.get("aiWorkspace", "auto")
        if ai_flag == "auto":
            ai_flag = any((self.root / name).exists() for name in ("AGENTS.md", "CLAUDE.md", "GEMINI.md"))
        self.features = {
            "aiWorkspace": bool(ai_flag),
            "calculationMap": False,
            "numericsWorkspace": False,
            "applications": bool(features.get("applications", True)),
        }
        self.ai = cfg.get("ai") or {}
        self.numerics: Dict[str, Any] = {}
        self.tools = cfg.get("tools") or []
        self._lock = threading.RLock()
        self.document: Optional[Dict[str, Any]] = None
        self._set_main(_clean_rel(cfg.get("main"), "main.tex"), _clean_rel(cfg.get("outDir"), "build"))

    def _set_main(self, main: str, out_dir: str) -> None:
        self.main = main
        self.main_stem = pathlib.PurePosixPath(main).stem
        self.out_dir = out_dir
        self.engine = self.fixed_engine or detect_engine(self.root, main)
        self.compile_command = self.configured_command or self.default_compile_command()
        self.ignored.add(self.out_dir.split("/")[0])

    def select_document(self, document: Optional[Dict[str, Any]]) -> None:
        """Make an application document the compiled, previewed root file."""
        with self._lock:
            if document is None:
                cfg = self.config
                self.document = None
                self._set_main(_clean_rel(cfg.get("main"), "main.tex"), _clean_rel(cfg.get("outDir"), "build"))
                return
            for key in ("main", "buildDir"):
                self._validate_path(document.get(key), key)
            self.document = dict(document)
            self._set_main(_clean_rel(document["main"]), _clean_rel(document["buildDir"]))

    def _validate_path(self, value: Any, field: str) -> None:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("%s must be a non-empty project-relative path" % field)
        if any(char in value for char in ('"', '\n', '\r', '\x00')):
            raise ValueError("%s contains invalid path characters" % field)
        path = pathlib.Path(value)
        if path.is_absolute() or pathlib.PureWindowsPath(value).drive:
            raise ValueError("%s must be project-relative" % field)
        try:
            (self.root / path).resolve().relative_to(self.root)
        except ValueError as exc:
            raise ValueError("%s escapes the project folder" % field) from exc

    # ----------------------------------------------------------- build files
    def output(self, suffix: str) -> pathlib.Path:
        return self.root / self.out_dir / (self.main_stem + suffix)

    @property
    def pdf_path(self) -> pathlib.Path:
        return self.output(".pdf")

    @property
    def log_path(self) -> pathlib.Path:
        return self.output(".log")

    @property
    def aux_path(self) -> pathlib.Path:
        return self.output(".aux")

    def rel(self, path: pathlib.Path) -> str:
        try:
            return path.resolve().relative_to(self.root).as_posix()
        except ValueError:
            return path.as_posix()

    def default_compile_command(self) -> str:
        """latexmk with SyncTeX into the output folder, run from the project root."""
        engine = getattr(self, "engine", "") or "lualatex"
        flag = {"lualatex": "-lualatex", "xelatex": "-xelatex", "pdflatex": "-pdf"}.get(engine, "-lualatex")
        return ("latexmk %s -synctex=1 -interaction=nonstopmode -file-line-error -outdir=%s %s"
                % (flag, _quote(self.out_dir), _quote(self.main)))

    # -------------------------------------------------------------- policies
    @staticmethod
    def _matches(rel_key: str, patterns: Iterable[str]) -> bool:
        folded = rel_key.replace("\\", "/").strip("/").casefold()
        for pattern in patterns:
            item = pattern.casefold()
            if item.endswith("/"):
                if folded.startswith(item):
                    return True
            elif folded == item.strip("/"):
                return True
        return False

    def is_protected(self, rel_key: str) -> bool:
        return self._matches(rel_key, self.no_delete)

    def needs_write_confirmation(self, rel_key: str) -> bool:
        return self._matches(rel_key, self.confirm_write)

    def is_ignored(self, name: str, rel: str = "") -> bool:
        if name in self.ignored or name.startswith("."):
            return True
        return bool(rel) and rel.casefold() in self.ignored_paths

    def public(self) -> Dict[str, Any]:
        return {
            "app": APP_NAME,
            "appId": APP_ID,
            "edition": "cv",
            "version": APP_VERSION,
            "name": self.name,
            "root": str(self.root),
            "main": self.main,
            "outDir": self.out_dir,
            "pdf": self.rel(self.pdf_path),
            "engine": self.engine,
            "entryFiles": self.entry_files,
            "features": self.features,
            "document": self.document,
            "configFile": self.rel(self.config_path) if self.config_path else "",
            "dataDir": self.rel(self.data_dir),
        }


def _quote(value: str) -> str:
    return '"%s"' % value


def discover_root(start: Optional[pathlib.Path] = None) -> Tuple[pathlib.Path, Optional[pathlib.Path]]:
    """Find the project root and its config file starting at the app folder."""
    here = (start or APP_DIR).resolve()
    for candidate in (here, *here.parents):
        config = candidate / CONFIG_NAME
        if config.is_file():
            return candidate, config
    legacy = APP_DIR.parent.parent if (start is None) else here
    return legacy, None


def load(root: Optional[Any] = None) -> Project:
    if root is None and os.environ.get("LATEX_RUNNER_ROOT"):
        root = os.environ["LATEX_RUNNER_ROOT"]
    if root is not None:
        base = pathlib.Path(root).expanduser().resolve()
        if not base.is_dir():
            raise ValueError("Project folder does not exist: %s" % base)
        config_path = base / CONFIG_NAME
        config = _read_config(config_path) if config_path.is_file() else {}
        return Project(base, config, config_path if config_path.is_file() else None)
    base, config_path = discover_root()
    config = _read_config(config_path) if config_path else {}
    return Project(base, config, config_path)


_LOCK = threading.Lock()
_CURRENT: Optional[Project] = None


def current() -> Project:
    global _CURRENT
    with _LOCK:
        if _CURRENT is None:
            _CURRENT = load()
        return _CURRENT


def activate(root: Optional[Any] = None) -> Project:
    """Select the project this process serves (called once by the server)."""
    global _CURRENT
    loaded = load(root)
    with _LOCK:
        _CURRENT = loaded
    return loaded
