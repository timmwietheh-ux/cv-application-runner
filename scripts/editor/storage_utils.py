"""Small, crash-safe persistence helpers for the local IDE."""
from __future__ import annotations

import json
import os
import pathlib
import tempfile
from typing import Any


def atomic_write_json(path: pathlib.Path, payload: Any) -> None:
    """Write JSON beside ``path`` and atomically replace the old document.

    The HTTP server is threaded.  A direct ``open(..., 'w')`` briefly exposes
    an empty or partial file to concurrent readers and can leave corrupted
    state behind if the process stops mid-write.  Replacing a completed
    same-directory temporary file avoids both failure modes.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=path.name + ".",
        suffix=".tmp",
        dir=str(path.parent),
        text=True,
    )
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
