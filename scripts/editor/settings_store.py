"""Settings storage and defaults for LaTeX Runner."""
from __future__ import annotations

import json
import pathlib
import threading
from copy import deepcopy
from typing import Any, Dict, Optional

import project
from storage_utils import atomic_write_json

# Tests and tools may pin a file; otherwise the project's data folder is used.
SETTINGS_FILE: Optional[pathlib.Path] = None
_LOCK = threading.RLock()

DEFAULT_SETTINGS: Dict[str, Any] = {
    "compiler": {
        "engine": "lualatex",
        "command": "latexmk -lualatex main.tex",
        "autoCompileOnSave": False,
        # Reload the PDF after every LaTeX pass instead of only at the end.
        "progressivePreview": True,
        "synctex": True,
    },
    "editor": {
        "theme": "runner-cobalt",
        "fontFamily": "'JetBrains Mono', 'Fira Code', Consolas, monospace",
        "fontSize": 14,
        "lineHeight": 22,
        "tabSize": 2,
        "wordWrap": "on",
        "bracketPairColorization": True,
        "keybindings": "standard",
        "minimap": False,
        "autosave": True,
        "autosaveDelay": 1200,
    },
    "viewer": {
        "defaultZoom": "page-width",
        "invertColors": False,
        "preserveScroll": True,
    },
    "paths": {
        "mainTex": "main.tex",
        "bibFile": "Bibliography/references.bib",
        "outDir": "build",
        "figuresDir": "Figures",
    },
}


def settings_file() -> pathlib.Path:
    return SETTINGS_FILE or project.current().data_dir / "settings.json"


def project_defaults() -> Dict[str, Any]:
    """Defaults adjusted to the active project's main file and engine."""
    defaults = deepcopy(DEFAULT_SETTINGS)
    active = project.current()
    defaults["compiler"]["engine"] = active.engine
    defaults["compiler"]["command"] = active.compile_command
    defaults["paths"]["mainTex"] = active.main
    defaults["paths"]["outDir"] = active.out_dir
    defaults["paths"]["bibFile"] = active.bibliography[0] if active.bibliography else ""
    defaults["paths"]["figuresDir"] = active.figure_dirs[0] if active.figure_dirs else ""
    return defaults


def load_settings() -> Dict[str, Any]:
    with _LOCK:
        merged = project_defaults()
        path = settings_file()
        if path.exists():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if not isinstance(data, dict):
                    raise ValueError("settings document must be a JSON object")
                for k, v in data.items():
                    if isinstance(v, dict) and isinstance(merged.get(k), dict):
                        merged[k] = {**merged[k], **v}
                    else:
                        merged[k] = v
            except (OSError, ValueError, TypeError):
                pass
        return merged


def save_settings(new_settings: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(new_settings, dict):
        raise ValueError("settings document must be a JSON object")
    with _LOCK:
        clean = deepcopy(new_settings)
        atomic_write_json(settings_file(), clean)
        return load_settings()
