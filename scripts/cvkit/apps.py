"""The application register: ``applications/<slug>/application.json``.

An application bundles everything for one call or job: block documents (CV,
letters, portal texts), LaTeX documents built as they are (the certificates
bundle, legacy profiles), notes and a small checklist. Folders whose name
starts with ``_`` (templates) are not applications.
"""
from __future__ import annotations

import copy
import datetime as _dt
import json
import pathlib
import re
import shutil
from typing import Any, Dict, List, Optional

from . import model

APPS = "applications"
TEMPLATES = "applications/_templates"
PROFILE = "applications/profile.json"
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}$")
DOC_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")


class AppError(ValueError):
    """A malformed application or a request for one that does not exist."""


def _read_json(path: pathlib.Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise AppError("Cannot read %s: %s" % (path.as_posix(), exc)) from exc
    except ValueError as exc:
        raise AppError("%s is not valid JSON: %s" % (path.as_posix(), exc)) from exc


def write_json(path: pathlib.Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def load_profile(root: pathlib.Path) -> Dict[str, Any]:
    path = root / PROFILE
    if not path.is_file():
        return {"name": "", "contacts": {}}
    data = _read_json(path)
    if not isinstance(data, dict):
        raise AppError("profile.json must hold an object")
    data.setdefault("contacts", {})
    return data


def categories(root: pathlib.Path) -> List[Dict[str, Any]]:
    path = root / APPS / "categories.json"
    if path.is_file():
        data = _read_json(path)
        if isinstance(data, list) and all(isinstance(item, dict) and item.get("id") for item in data):
            return data
    return copy.deepcopy(model.DEFAULT_CATEGORIES)


def _check_slug(slug: str) -> str:
    if not isinstance(slug, str) or not SLUG.fullmatch(slug):
        raise AppError("Application names use lower-case letters, digits and hyphens (for example phd-mpi-dresden)")
    return slug


def app_dir(root: pathlib.Path, slug: str) -> pathlib.Path:
    return root / APPS / _check_slug(slug)


def _clean_rel(value: Any) -> str:
    text = str(value or "").replace("\\", "/").strip().lstrip("/")
    if not text or ".." in pathlib.PurePosixPath(text).parts or ":" in text:
        raise AppError("Invalid relative path %r" % value)
    return text


def resolve_document(root: pathlib.Path, slug: str, entry: Dict[str, Any], app: Dict[str, Any]) -> Dict[str, Any]:
    """Absolute paths and build locations of one document of an application."""
    doc_id = str(entry.get("id") or "")
    if not DOC_ID.fullmatch(doc_id):
        raise AppError("Application %s has a document with an invalid id %r" % (slug, doc_id))
    folder = app_dir(root, slug)
    build = "build/apps/%s/%s" % (slug, doc_id)
    output_dir = "output/%s" % _clean_rel(app.get("outputDir") or slug)
    info: Dict[str, Any] = {
        "id": doc_id,
        "app": slug,
        "label": str(entry.get("label") or doc_id),
        "buildDir": build,
        "maxBytes": entry.get("maxBytes"),
        "upload": bool(entry.get("upload")),
        "note": str(entry.get("note") or ""),
    }
    if entry.get("output"):
        info["output"] = output_dir + "/" + _clean_rel(entry["output"])
    if entry.get("source"):
        source = folder / _clean_rel(entry["source"])
        info["source"] = source.relative_to(root).as_posix()
        kind = None
        if source.is_file():
            try:
                kind = (_read_json(source) or {}).get("kind")
            except AppError:
                kind = None
        info["kind"] = kind or str(entry.get("kind") or "cv")
        if info["kind"] == "texts":
            info["type"] = "texts"
            if entry.get("checklist"):
                info["checklist"] = (folder / _clean_rel(entry["checklist"])).relative_to(root).as_posix()
        else:
            info["type"] = "block"
            info["main"] = "%s/%s.tex" % (build, doc_id)
            info["pdf"] = "%s/%s.pdf" % (build, doc_id)
            info["map"] = "%s/%s.map.json" % (build, doc_id)
    elif entry.get("tex"):
        tex = _clean_rel(entry["tex"])
        info.update(type="tex", kind="tex", main=tex,
                    pdf="%s/%s.pdf" % (build, pathlib.PurePosixPath(tex).stem))
    else:
        raise AppError("Document %s/%s needs either a JSON source or a tex file" % (slug, doc_id))
    return info


def _stat(root: pathlib.Path, rel: Optional[str]) -> Optional[Dict[str, Any]]:
    if not rel:
        return None
    path = root / rel
    try:
        stat = path.stat()
    except OSError:
        return None
    return {"bytes": stat.st_size, "modified": stat.st_mtime}


def load_application(root: pathlib.Path, slug: str) -> Dict[str, Any]:
    folder = app_dir(root, slug)
    path = folder / "application.json"
    if not path.is_file():
        raise AppError("Application %s has no application.json" % slug)
    data = _read_json(path)
    if not isinstance(data, dict):
        raise AppError("%s/application.json must hold an object" % slug)
    app = dict(data)
    app["slug"] = slug
    app.setdefault("title", slug)
    app.setdefault("category", "general")
    app.setdefault("status", "preparing")
    docs = []
    for entry in data.get("documents") or []:
        if not isinstance(entry, dict):
            raise AppError("%s: every document entry must be an object" % slug)
        info = resolve_document(root, slug, entry, app)
        info["built"] = _stat(root, info.get("pdf"))
        info["exported"] = _stat(root, info.get("output"))
        docs.append(info)
    app["documents"] = docs
    notes = []
    for note in data.get("notes") or []:
        if isinstance(note, str):
            note = {"label": pathlib.PurePosixPath(note).stem.replace("-", " "), "path": note}
        rel = (folder / _clean_rel(note.get("path"))).relative_to(root).as_posix()
        notes.append({"label": str(note.get("label") or rel), "path": rel, "exists": (root / rel).is_file()})
    app["notes"] = notes
    app["checklist"] = [
        {"text": str(item.get("text") or ""), "done": bool(item.get("done"))}
        for item in data.get("checklist") or [] if isinstance(item, dict)
    ]
    app["folder"] = folder.relative_to(root).as_posix()
    return app


def list_applications(root: pathlib.Path) -> Dict[str, Any]:
    base = root / APPS
    apps: List[Dict[str, Any]] = []
    problems: List[str] = []
    if base.is_dir():
        for folder in sorted(base.iterdir(), key=lambda p: p.name):
            if not folder.is_dir() or folder.name.startswith(("_", ".")):
                continue
            if not (folder / "application.json").is_file():
                continue
            try:
                app = load_application(root, folder.name)
                if not app.get("hidden"):
                    apps.append(app)
            except AppError as exc:
                problems.append(str(exc))
    return {"applications": apps, "categories": categories(root), "problems": problems,
            "templates": list_templates(root), "profile": PROFILE}


def find_document(root: pathlib.Path, slug: str, doc_id: str) -> Dict[str, Any]:
    app = load_application(root, slug)
    for doc in app["documents"]:
        if doc["id"] == doc_id:
            doc = dict(doc)
            doc["appTitle"] = app["title"]
            return doc
    raise AppError("Application %s has no document %r" % (slug, doc_id))


def list_templates(root: pathlib.Path) -> List[Dict[str, str]]:
    base = root / TEMPLATES
    out: List[Dict[str, str]] = []
    if base.is_dir():
        for path in sorted(base.glob("*.json")):
            try:
                data = _read_json(path)
            except AppError:
                continue
            if isinstance(data, dict) and data.get("kind") in model.KINDS:
                out.append({"id": path.stem, "kind": data["kind"], "title": str(data.get("title") or path.stem)})
    return out


def _source_document(root: pathlib.Path, spec: str) -> Dict[str, Any]:
    """Resolve ``template:<name>`` or ``<app>/<doc>`` to a normalized document."""
    if spec.startswith("template:"):
        path = root / TEMPLATES / (_clean_rel(spec.split(":", 1)[1]) + ".json")
        if not path.is_file():
            raise AppError("Unknown template %s" % spec)
        return model.load(path)
    if "/" in spec:
        slug, doc_id = spec.split("/", 1)
        doc = find_document(root, slug, doc_id)
        if doc.get("type") not in ("block", "texts"):
            raise AppError("%s is not a block document and cannot be copied" % spec)
        return model.load(root / doc["source"])
    raise AppError("Unknown document source %r" % spec)


def create_application(root: pathlib.Path, slug: str, title: str, category: str = "general",
                       organization: str = "", deadline: str = "", cv: str = "",
                       letter: str = "", texts: str = "") -> Dict[str, Any]:
    """Create ``applications/<slug>/`` from templates or existing documents."""
    folder = app_dir(root, slug)
    if folder.exists():
        raise AppError("applications/%s already exists" % slug)
    if not str(title or "").strip():
        raise AppError("Give the application a title")
    known = {item["id"] for item in categories(root)}
    if category not in known:
        raise AppError("Unknown category %r" % category)
    if deadline and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", deadline):
        raise AppError("Deadlines use the form YYYY-MM-DD")
    prefix = re.sub(r"[^A-Za-z0-9]+", "_", title).strip("_")[:48] or slug
    documents: List[Dict[str, Any]] = []
    payloads: Dict[str, Dict[str, Any]] = {}
    for doc_id, spec, label, suffix in (("cv", cv, "Curriculum vitae", "CV"),
                                        ("letter", letter, "Letter", "Letter"),
                                        ("texts", texts, "Portal texts", "Portal_Texts")):
        if not spec:
            continue
        doc = _source_document(root, spec)
        payloads[doc_id] = doc
        entry: Dict[str, Any] = {"id": doc_id, "label": label, "source": doc_id + ".json"}
        extension = ".md" if doc["kind"] == "texts" else ".pdf"
        owner = re.sub(r"[^A-Za-z0-9]+", "_", str(load_profile(root).get("name") or "Applicant")).strip("_") or "Applicant"
        entry["output"] = "%s_%s_%s%s" % (owner, prefix, suffix, extension)
        documents.append(entry)
    folder.mkdir(parents=True)
    (folder / "source-materials").mkdir()
    for doc_id, doc in payloads.items():
        (folder / (doc_id + ".json")).write_text(model.dumps(doc), encoding="utf-8", newline="\n")
    today = _dt.date.today().isoformat()
    application = {
        "title": title.strip(),
        "organization": organization.strip(),
        "category": category,
        "status": "preparing",
        "deadline": deadline,
        "created": today,
        "links": [],
        "documents": documents,
        "notes": [{"label": "Dossier", "path": "target.md"}],
        "checklist": [
            {"text": "Save the call text or job advert in source-materials/", "done": False},
            {"text": "Map every requirement to verified facts in target.md", "done": False},
            {"text": "Tailor the CV and the letter, then rebuild", "done": False},
            {"text": "Remove every red TODO marker and check the PDFs page by page", "done": False},
        ],
    }
    write_json(folder / "application.json", application)
    template = root / TEMPLATES / "target.md"
    dossier = template.read_text(encoding="utf-8") if template.is_file() else "# {title}\n"
    dossier = dossier.replace("{title}", title.strip()).replace("{organization}", organization.strip() or "(organisation)")
    dossier = dossier.replace("{deadline}", deadline or "(deadline)").replace("{created}", today).replace("{slug}", slug)
    (folder / "target.md").write_text(dossier, encoding="utf-8", newline="\n")
    return load_application(root, slug)


EDITABLE_APP_FIELDS = ("title", "organization", "category", "status", "deadline", "summary", "links", "checklist")


def update_application(root: pathlib.Path, slug: str, changes: Dict[str, Any]) -> Dict[str, Any]:
    """Change the editable metadata of an application (never its documents)."""
    path = app_dir(root, slug) / "application.json"
    data = _read_json(path)
    for key, value in (changes or {}).items():
        if key not in EDITABLE_APP_FIELDS:
            raise AppError("%s cannot be changed here" % key)
        if key == "status" and value not in model.STATUSES:
            raise AppError("Unknown status %r" % value)
        if key == "deadline" and value and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(value)):
            raise AppError("Deadlines use the form YYYY-MM-DD")
        if key == "checklist":
            value = [{"text": str(item.get("text") or ""), "done": bool(item.get("done"))}
                     for item in value or [] if isinstance(item, dict) and str(item.get("text") or "").strip()]
        if key == "links":
            value = [{"label": str(item.get("label") or ""), "url": str(item.get("url") or "")}
                     for item in value or [] if isinstance(item, dict) and item.get("url")]
        data[key] = value
    write_json(path, data)
    return load_application(root, slug)


def duplicate_document(root: pathlib.Path, slug: str, doc_id: str, new_id: str, label: str = "") -> Dict[str, Any]:
    """Copy one block document inside an application, for a tailored variant."""
    if not DOC_ID.fullmatch(new_id or ""):
        raise AppError("Document ids use lower-case letters, digits, hyphens and underscores")
    folder = app_dir(root, slug)
    data = _read_json(folder / "application.json")
    entries = data.get("documents") or []
    if any(entry.get("id") == new_id for entry in entries):
        raise AppError("%s already has a document %r" % (slug, new_id))
    source = next((entry for entry in entries if entry.get("id") == doc_id), None)
    if not source or not source.get("source"):
        raise AppError("%s has no block document %r" % (slug, doc_id))
    target = folder / (new_id + ".json")
    if target.exists():
        raise AppError("%s already exists" % target.relative_to(root).as_posix())
    shutil.copyfile(folder / _clean_rel(source["source"]), target)
    entry = {key: value for key, value in source.items() if key not in ("id", "label", "source", "output", "upload")}
    entry.update(id=new_id, label=label or (str(source.get("label") or doc_id) + " (copy)"), source=new_id + ".json")
    if source.get("output"):
        stem, dot, ext = str(source["output"]).rpartition(".")
        entry["output"] = "%s_%s.%s" % (stem or source["output"], new_id, ext or "pdf")
    entries.append(entry)
    data["documents"] = entries
    write_json(folder / "application.json", data)
    return load_application(root, slug)
