"""Cheap shared disk snapshots and optimistic, atomic editor saves."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import tempfile
import threading
import time

_LOCK = threading.RLock()
_SNAPSHOTS = {}
# Folders never walked for change detection (the project adds its own ignores).
IGNORED = {'.git', 'build', 'OUT', 'node_modules', '.venv', 'venv', '__pycache__',
           '.codex', '.claude', '.pytest_cache', '.ruff_cache', '.mypy_cache'}
SOURCE_SUFFIXES = ('.tex', '.bib', '.sty', '.cls', '.bbx', '.cbx', '.def', '.ltx')
ASSET_SUFFIXES = ('.pdf', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif', '.eps', '.tiff', '.dat', '.csv')


def stamp(path):
    try:
        stat = path.stat()
        return f'{stat.st_mtime_ns}:{stat.st_size}'
    except OSError:
        return None


def read_document(path):
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    return {'content': raw.decode('utf-8', errors='replace').replace('\r\n', '\n'),
            'version': digest, 'stamp': _document_token(path, raw, digest)}


def _document_token(path, raw, digest=None):
    metadata = stamp(path)
    if metadata is None or len(raw) > 4 * 1024 * 1024:
        return metadata
    return f'{metadata}:{digest or hashlib.sha256(raw).hexdigest()}'


def document_stamp(path):
    """Return a change token that also catches same-size, same-timestamp edits."""
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    return _document_token(path, raw)


def _read_if_present(path):
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return b''


def write_document(path, content, expected_version=None):
    """Atomically replace ``path`` unless someone else changed it meanwhile.

    ``expected_version`` is the SHA-256 of the text the editor loaded. A
    mismatch is a conflict, except when the disk already holds exactly the
    text being saved (for example a repeated save after a lost response).
    """
    if not isinstance(content, str):
        raise ValueError('File content must be text')
    with _LOCK:
        raw = _read_if_present(path) if path.is_file() else b''
        newline = '\r\n' if b'\r\n' in raw else '\n'
        payload = content.replace('\r\n', '\n').replace('\n', newline).encode('utf-8')
        current = hashlib.sha256(raw).hexdigest() if path.is_file() else None
        if expected_version is not None and current != expected_version:
            if current is not None and raw == payload:
                return {'success': True, 'version': current, 'stamp': _document_token(path, raw, current),
                        'unchanged': True}
            return {'success': False, 'conflict': True, 'version': current,
                    'error': 'The file changed on disk. Review both versions before saving.'}
        if current is not None and raw == payload:
            # Nothing to write: keep timestamps stable so builds are not retriggered.
            return {'success': True, 'version': current, 'stamp': _document_token(path, raw, current),
                    'unchanged': True}
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
        try:
            with os.fdopen(fd, 'wb') as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            # Detect external writers that changed the file during preparation.
            if expected_version is not None:
                latest = hashlib.sha256(_read_if_present(path)).hexdigest() if path.is_file() else None
                if latest != expected_version:
                    return {'success': False, 'conflict': True, 'version': latest,
                            'error': 'The file changed while saving. Please review it again.'}
            _replace(name, path)
        finally:
            if os.path.exists(name):
                os.unlink(name)
        digest = hashlib.sha256(payload).hexdigest()
        return {'success': True, 'version': digest, 'stamp': _document_token(path, payload, digest)}


def _replace(source, target, attempts=6):
    """os.replace with a short retry: Windows scanners briefly lock fresh files."""
    for attempt in range(attempts):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(0.05 * (attempt + 1))


def _walk(root, ignored, ignored_paths):
    for directory, dirs, files in os.walk(root, followlinks=False):
        base = Path(directory)
        keep = []
        for name in dirs:
            if name in ignored or name.startswith('.'):
                continue
            relative = (base / name).relative_to(root).as_posix()
            if relative.casefold() in ignored_paths or (base / name).is_symlink():
                continue
            keep.append(name)
        dirs[:] = sorted(keep)
        for name in sorted(files):
            yield base / name, name


def snapshot(root, force=False, ignored=None, ignored_paths=None):
    """Fingerprint the workspace in groups so the UI reloads only what changed.

    Metadata (mtime and size) is enough here: these groups only decide which
    panels to refresh. Open documents are compared by content separately
    through ``document_stamp``, so a same-size edit can never be missed there.
    """
    root = Path(root).resolve()
    skip = set(IGNORED) | set(ignored or ())
    skip_paths = {item.casefold() for item in (ignored_paths or ())}
    with _LOCK:
        now = time.monotonic()
        cached = _SNAPSHOTS.get(root)
        if cached and not force and now - cached[0] < 1.5:
            return cached[1]
        digests = {name: hashlib.sha256() for name in ('tree', 'source', 'ai', 'tools', 'assets')}
        for path, name in _walk(root, skip, skip_paths):
            try:
                if path.is_symlink():
                    continue
                stat = path.stat()
            except OSError:
                continue
            relative = path.relative_to(root).as_posix()
            entry = f'{relative}\0{stat.st_mtime_ns}:{stat.st_size}\n'.encode('utf-8', 'surrogatepass')
            digests['tree'].update(relative.encode('utf-8', 'surrogatepass') + b'\n')
            suffix = path.suffix.lower()
            if suffix in SOURCE_SUFFIXES:
                digests['source'].update(entry)
            if relative.startswith('Docs/AI/') or name in ('HANDOFF.md', 'MEMORY.md', 'AGENTS.md', 'CLAUDE.md'):
                digests['ai'].update(entry)
            if relative.startswith('Scripts/') or name == 'latex-runner.json':
                digests['tools'].update(entry)
            if suffix in ASSET_SUFFIXES:
                digests['assets'].update(entry)
        result = {key: value.hexdigest() for key, value in digests.items()}
        _SNAPSHOTS.clear()  # A server owns one workspace; tests can switch roots.
        _SNAPSHOTS[root] = (now, result)
        return result
