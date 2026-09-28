"""Render, typeset, check and export application documents.

Shared by the command line (``scripts/cv.py``) and the Runner. Typesetting uses
latexmk with LuaLaTeX from the repository root, so local style paths resolve.
"""
from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
from typing import Any, Dict, List, Optional

from . import apps, inline, model, render, texts


def latexmk_path() -> str:
    candidates = []
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidates.append(pathlib.Path(local) / "Programs" / "MiKTeX" / "miktex" / "bin" / "x64" / "latexmk.exe")
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    found = shutil.which("latexmk")
    if not found:
        raise RuntimeError("latexmk was not found. Install MiKTeX or TeX Live, or add latexmk to PATH.")
    return found


def latexmk_args(doc: Dict[str, Any], halt_on_error: bool = False) -> List[str]:
    args = ["-lualatex", "-synctex=1", "-interaction=nonstopmode", "-file-line-error"]
    if halt_on_error:
        args.append("-halt-on-error")
    args += ["-outdir=" + doc["buildDir"], doc["main"]]
    return args


def compile_command(doc: Dict[str, Any]) -> str:
    """The latexmk call as one command line, as the Runner streams it."""
    return "latexmk " + " ".join('"%s"' % arg if " " in arg else arg for arg in latexmk_args(doc))


def make_resolver(root: pathlib.Path, source: str):
    """Resolve ``file.json#field`` links relative to the linking document."""
    folder = (root / source).parent

    def resolve(link: str) -> str:
        name, _, field_id = str(link).partition("#")
        if not name or not field_id or "/" in name or "\\" in name or ".." in name:
            raise model.DocumentError("Links take the form file.json#field inside the same application: %r" % link)
        target = folder / name
        if not target.is_file():
            raise model.DocumentError("The linked document %s does not exist" % name)
        linked = model.load(target)
        if linked["kind"] != "texts":
            raise model.DocumentError("%s is not a text document" % name)
        for field in linked["fields"]:
            if field["id"] == field_id:
                return field["text"]
        raise model.DocumentError("%s has no field %r" % (name, field_id))

    return resolve


def render_document(root: pathlib.Path, doc: Dict[str, Any]) -> Dict[str, Any]:
    """Write the generated LaTeX file and its line map for a block document."""
    if doc.get("type") != "block":
        return {"rendered": False}
    data = model.load(root / doc["source"])
    tex, tags = render.render(data, apps.load_profile(root), source=doc["source"],
                              resolver=make_resolver(root, doc["source"]))
    main = root / doc["main"]
    main.parent.mkdir(parents=True, exist_ok=True)
    changed = not main.is_file() or main.read_text(encoding="utf-8") != tex
    if changed:
        # Rewrite only on change: latexmk then skips documents that are current.
        main.write_text(tex, encoding="utf-8", newline="\n")
    (root / doc["map"]).write_text(json.dumps({"source": doc["source"], "tags": tags}), encoding="utf-8")
    return {"rendered": True, "changed": changed, "main": doc["main"],
            "placeholders": [where for where, text in model.iter_texts(data) if inline.has_placeholder(text)]}


def read_map(root: pathlib.Path, doc: Dict[str, Any]) -> Dict[str, Any]:
    path = root / doc.get("map", "")
    if not doc.get("map") or not path.is_file():
        return {"source": doc.get("source"), "tags": []}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return {"source": doc.get("source"), "tags": []}


def typeset(root: pathlib.Path, doc: Dict[str, Any], quiet: bool = False) -> subprocess.CompletedProcess:
    render_document(root, doc)
    (root / doc["buildDir"]).mkdir(parents=True, exist_ok=True)
    command = [latexmk_path()] + latexmk_args(doc, halt_on_error=True)
    return subprocess.run(command, cwd=str(root), capture_output=quiet, text=True)


def export_document(root: pathlib.Path, doc: Dict[str, Any]) -> Dict[str, Any]:
    """Copy the built PDF (or the text sheet) to its output name and check size."""
    if not doc.get("output"):
        raise apps.AppError("%s/%s has no output name" % (doc["app"], doc["id"]))
    target = root / doc["output"]
    target.parent.mkdir(parents=True, exist_ok=True)
    if doc["type"] == "texts":
        data = model.load(root / doc["source"])
        checklist = None
        if doc.get("checklist") and (root / doc["checklist"]).is_file():
            checklist = (root / doc["checklist"]).read_text(encoding="utf-8")
        target.write_text(texts.export_markdown(data, checklist), encoding="utf-8", newline="\n")
        return {"output": doc["output"], "bytes": target.stat().st_size, "overLimit": texts.over_limit(data)}
    pdf = root / doc["pdf"]
    if not pdf.is_file():
        raise apps.AppError("Build %s/%s before exporting it" % (doc["app"], doc["id"]))
    shutil.copyfile(pdf, target)
    size = target.stat().st_size
    limit = doc.get("maxBytes")
    if limit and size > int(limit):
        raise apps.AppError("%s is %d bytes, above the upload limit of %d bytes" % (doc["output"], size, int(limit)))
    return {"output": doc["output"], "bytes": size, "limit": limit}


def check_document(root: pathlib.Path, doc: Dict[str, Any]) -> List[str]:
    """Problems that must be solved before a document leaves the house."""
    problems: List[str] = []
    if doc["type"] in ("block", "texts"):
        try:
            data = model.load(root / doc["source"])
        except model.DocumentError as exc:
            return [str(exc)]
        for where, text in model.iter_texts(data):
            if inline.has_placeholder(text):
                problems.append("TODO marker in %s" % where)
        if data["kind"] == "texts":
            for field in data["fields"]:
                state = texts.field_state(field)
                if state["over"]:
                    problems.append("%s: %d characters, limit %d" % (field["title"], state["counts"]["chars"], field["limit"]))
                elif state["strictOver"]:
                    problems.append("%s: fits the counter but is %d bytes with CRLF line breaks (limit %d)"
                                    % (field["title"], state["counts"]["bytes"], field["limit"]))
                if field.get("required") and state["empty"]:
                    problems.append("%s: required field is empty" % field["title"])
        else:
            try:
                render.render(data, apps.load_profile(root), source=doc["source"],
                              resolver=make_resolver(root, doc["source"]))
            except model.DocumentError as exc:
                problems.append(str(exc))
    elif doc["type"] == "tex" and not (root / doc["main"]).is_file():
        problems.append("Missing LaTeX file %s" % doc["main"])
    return problems


def check_all(root: pathlib.Path, slug: Optional[str] = None) -> Dict[str, List[str]]:
    listing = apps.list_applications(root)
    result: Dict[str, List[str]] = {}
    for problem in listing["problems"]:
        result.setdefault("(register)", []).append(problem)
    for app in listing["applications"]:
        if slug and app["slug"] != slug:
            continue
        for doc in app["documents"]:
            found = check_document(root, doc)
            if found:
                result["%s/%s" % (app["slug"], doc["id"])] = found
    return result
