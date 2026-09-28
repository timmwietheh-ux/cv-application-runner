"""Applications workspace of LaTeX Runner CV Edition.

Bridges the server and ``scripts/cvkit`` (the block-document toolkit of the CV
repository): the application register, reading and saving block documents
with the same optimistic version check as ordinary files, the active document
that the Runner compiles and previews, SyncTeX lookups from generated lines
back to blocks, and exports to ``output/``.
"""
from __future__ import annotations

import json
import pathlib
import sys
import threading
from typing import Any, Dict, Optional

import project
import workspace_state
from storage_utils import atomic_write_json

SCRIPTS = pathlib.Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from cvkit import apps, build, model, packages, render, texts  # noqa: E402

_LOCK = threading.RLock()
STATE_NAME = "cv-edition.json"


class WorkspaceError(ValueError):
    """A request the Applications workspace cannot serve, with a readable reason."""


def _root() -> pathlib.Path:
    return project.current().root


def _state_file() -> pathlib.Path:
    return project.current().data_dir / STATE_NAME


def _read_state() -> Dict[str, Any]:
    try:
        data = json.loads(_state_file().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_state(**changes: Any) -> None:
    state = _read_state()
    state.update(changes)
    atomic_write_json(_state_file(), state)


def _guard(call, *args, **kwargs):
    try:
        return call(*args, **kwargs)
    except (apps.AppError, model.DocumentError, packages.PackageError) as exc:
        raise WorkspaceError(str(exc)) from exc


def _document(app: str, doc: str) -> Dict[str, Any]:
    return _guard(apps.find_document, _root(), app, doc)


def _compilable(info: Dict[str, Any]) -> bool:
    return info.get("type") in ("block", "tex")


# --------------------------------------------------------------- register
def overview() -> Dict[str, Any]:
    root = _root()
    listing = apps.list_applications(root)
    active = project.current().document
    for app in listing["applications"]:
        for doc in app["documents"]:
            doc["problems"] = build.check_document(root, doc)
    return {
        "success": True,
        **listing,
        "schema": model.schema(),
        "active": {"app": active["app"], "doc": active["id"]} if active else None,
        "profileVersion": _version(root / apps.PROFILE),
    }


def _version(path: pathlib.Path) -> Optional[str]:
    try:
        return workspace_state.read_document(path)["version"]
    except OSError:
        return None


# ----------------------------------------------------- the active document
def activate(app: str, doc: str) -> Dict[str, Any]:
    """Select the document that the Runner compiles and previews."""
    with _LOCK:
        info = _document(app, doc)
        if not _compilable(info):
            raise WorkspaceError("%s cannot be typeset; it is exported as text" % info["label"])
        rendered = _guard(build.render_document, _root(), info)
        project.current().select_document(info)
        _write_state(active={"app": app, "doc": doc})
        return {"success": True, "document": info, "rendered": rendered}


def restore() -> Optional[Dict[str, Any]]:
    """Select the remembered document at start-up, or the first CV there is."""
    remembered = _read_state().get("active") or {}
    candidates = []
    if remembered.get("app") and remembered.get("doc"):
        candidates.append((remembered["app"], remembered["doc"]))
    try:
        listing = apps.list_applications(_root())
    except apps.AppError:
        listing = {"applications": []}
    for app in listing["applications"]:
        for doc in app["documents"]:
            if doc.get("type") == "block" and doc.get("kind") == "cv":
                candidates.append((app["slug"], doc["id"]))
    for app, doc in candidates:
        try:
            return activate(app, doc)
        except WorkspaceError:
            continue
    return None


def precompile() -> Dict[str, Any]:
    """Regenerate the active block document right before latexmk runs."""
    info = project.current().document
    if not info or info.get("type") != "block":
        return {"rendered": False}
    return _guard(build.render_document, _root(), info)


# ----------------------------------------------------- reading and saving
def _source_path(info: Dict[str, Any]) -> pathlib.Path:
    if info.get("type") not in ("block", "texts"):
        raise WorkspaceError("%s is a LaTeX file; open it in the LaTeX workspace" % info["label"])
    return _root() / info["source"]


def read_document(app: str, doc: str) -> Dict[str, Any]:
    info = _document(app, doc)
    path = _source_path(info)
    raw = workspace_state.read_document(path)
    data = _guard(model.normalize, _parse(raw["content"], info["source"]))
    result: Dict[str, Any] = {"success": True, "info": info, "doc": data,
                              "version": raw["version"], "stamp": raw["stamp"]}
    if info["type"] == "block":
        result["map"] = build.read_map(_root(), info)
        if data["kind"] == "letter" and data.get("bodyFrom"):
            try:
                result["linkedBody"] = build.make_resolver(_root(), info["source"])(data["bodyFrom"])
            except model.DocumentError as exc:
                result["linkedError"] = str(exc)
    return result


def _parse(text: str, where: str) -> Any:
    try:
        return json.loads(text)
    except ValueError as exc:
        raise WorkspaceError("%s is not valid JSON: %s" % (where, exc)) from exc


def write_document(app: str, doc: str, data: Any, version: Optional[str]) -> Dict[str, Any]:
    info = _document(app, doc)
    path = _source_path(info)
    clean = _guard(model.normalize, data)
    with _LOCK:
        result = workspace_state.write_document(path, model.dumps(clean), version)
    if result.get("conflict"):
        return {**result, "info": info}
    payload: Dict[str, Any] = {**result, "info": info}
    if info["type"] == "block":
        try:
            payload["rendered"] = build.render_document(_root(), info)
            payload["map"] = build.read_map(_root(), info)
        except model.DocumentError as exc:
            payload["renderError"] = str(exc)
    payload["problems"] = build.check_document(_root(), info)
    return payload


def document_stamp(app: str, doc: str) -> Dict[str, Any]:
    """Cheap change token of a document, for the editor's live refresh."""
    info = _document(app, doc)
    path = _source_path(info)
    return {"success": True, "stamp": workspace_state.document_stamp(path)}


def read_profile() -> Dict[str, Any]:
    path = _root() / apps.PROFILE
    raw = workspace_state.read_document(path)
    return {"success": True, "profile": _parse(raw["content"], apps.PROFILE), "version": raw["version"]}


def write_profile(data: Any, version: Optional[str]) -> Dict[str, Any]:
    if not isinstance(data, dict) or not isinstance(data.get("contacts"), dict):
        raise WorkspaceError("The profile needs a name and a contacts object")
    for key, contact in data["contacts"].items():
        if not isinstance(contact, dict) or not str(key).strip():
            raise WorkspaceError("Every contact needs a key and an object with icon, text and url")
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    with _LOCK:
        return workspace_state.write_document(_root() / apps.PROFILE, text, version)


# ------------------------------------------------------ register changes
def create_application(body: Dict[str, Any]) -> Dict[str, Any]:
    app = _guard(apps.create_application, _root(), str(body.get("slug") or ""), str(body.get("title") or ""),
                 category=str(body.get("category") or "general"),
                 organization=str(body.get("organization") or ""), deadline=str(body.get("deadline") or ""),
                 cv=str(body.get("cv") or ""), letter=str(body.get("letter") or ""), texts=str(body.get("texts") or ""))
    return {"success": True, "application": app}


def update_application(slug: str, changes: Any) -> Dict[str, Any]:
    if not isinstance(changes, dict):
        raise WorkspaceError("Changes must be an object")
    return {"success": True, "application": _guard(apps.update_application, _root(), slug, changes)}


def duplicate_document(app: str, doc: str, new_id: str, label: str) -> Dict[str, Any]:
    return {"success": True, "application": _guard(apps.duplicate_document, _root(), app, doc, new_id, label)}


def export(app: str, doc: str) -> Dict[str, Any]:
    info = _document(app, doc)
    return {"success": True, **_guard(build.export_document, _root(), info)}


def build_document(app: str, doc: str) -> Dict[str, Any]:
    """Build one registered document and publish its named output.

    The JSON is always rendered immediately before LaTeX runs.  A failed
    LaTeX process leaves the previous export untouched and returns its log
    tail to the editor instead of presenting an old PDF as a new result.
    """
    info = _document(app, doc)
    problems = build.check_document(_root(), info)
    if problems:
        raise WorkspaceError("Resolve these document checks first: " + "; ".join(problems))
    if info["type"] == "texts":
        result = _guard(build.export_document, _root(), info)
        return {"success": True, "document": info, "export": result, "pdf": False}
    if info["type"] not in ("block", "tex"):
        raise WorkspaceError("This document cannot be built")
    activate(app, doc)
    try:
        completed = build.typeset(_root(), info, quiet=True)
    except (OSError, RuntimeError, model.DocumentError) as exc:
        raise WorkspaceError(str(exc)) from exc
    if completed.returncode:
        lines = ((completed.stdout or "") + "\n" + (completed.stderr or "")).splitlines()
        raise WorkspaceError("LaTeX failed (exit %d):\n%s" % (completed.returncode, "\n".join(lines[-25:])))
    pdf = _root() / info["pdf"]
    if not pdf.is_file() or b"%%EOF" not in pdf.read_bytes()[-2048:]:
        raise WorkspaceError("LaTeX did not produce a complete PDF")
    result = _guard(build.export_document, _root(), info)
    return {"success": True, "document": info, "export": result, "pdf": True}


def pdf_file(app: str, doc: str) -> pathlib.Path:
    info = _document(app, doc)
    if info["type"] not in ("block", "tex"):
        raise WorkspaceError("This document has no PDF")
    target = _root() / info["pdf"]
    if not target.is_file():
        raise WorkspaceError("No compiled PDF yet. Build the document first.")
    return target


def download_file(app: str, doc: str) -> pathlib.Path:
    info = _document(app, doc)
    if info["type"] not in ("block", "tex"):
        raise WorkspaceError("This document has no PDF")
    target = _root() / (info.get("output") or info["pdf"])
    if not target.is_file():
        raise WorkspaceError("Build the PDF before downloading it")
    return target


def text_file(app: str, doc: str) -> pathlib.Path:
    info = _document(app, doc)
    if info["type"] != "texts" or not info.get("output"):
        raise WorkspaceError("This document has no portal text sheet")
    target = _root() / info["output"]
    if not target.is_file():
        raise WorkspaceError("Export the portal texts first")
    return target


def build_package(app: str, ids: Any) -> Dict[str, Any]:
    """Rebuild every selected PDF in order, then merge their current pages."""
    docs = _guard(packages.selected_documents, _root(), app, ids)
    for doc in docs:
        build_document(app, doc["id"])
    result = _guard(packages.merge, _root(), app, ids)
    return {"success": True, "package": result}


def package_file(app: str, name: str) -> pathlib.Path:
    return _guard(packages.package_file, _root(), app, name)


# ------------------------------------------------------------- SyncTeX
def locate(file: str, line: int) -> Dict[str, Any]:
    """The block behind a line of a generated file (PDF double-click)."""
    active = project.current().document
    normalized = str(file or "").replace("\\", "/").lstrip("./")
    if not active or active.get("type") != "block" or normalized != active.get("main"):
        return {"success": True, "found": False}
    tags = build.read_map(_root(), active).get("tags") or []
    hit = render.locate(tags, int(line))
    if not hit:
        return {"success": True, "found": False}
    return {"success": True, "found": True, "app": active["app"], "doc": active["id"], **hit}


def block_line(app: str, doc: str, block: str) -> Dict[str, Any]:
    """First generated line of a block, for a forward SyncTeX jump."""
    info = _document(app, doc)
    if info.get("type") != "block":
        raise WorkspaceError("Only block documents map blocks to lines")
    tags = build.read_map(_root(), info).get("tags") or []
    lines = render.block_lines(tags, block)
    if not lines:
        return {"success": True, "found": False}
    # Skip the "% @block" comment line; it produces no output in the PDF.
    first = lines[0] + 1 if lines[1] > lines[0] else lines[0]
    return {"success": True, "found": True, "file": info["main"], "line": first, "last": lines[1]}


def counts(text: str) -> Dict[str, Any]:
    return texts.count(text)
