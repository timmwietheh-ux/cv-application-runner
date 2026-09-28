"""Checked PDF bundles for one application.

The caller builds the selected documents first. This module only combines
registered PDFs, so a portal text export can never enter a PDF by accident.
"""
from __future__ import annotations

import hashlib
import os
import pathlib
import re
import tempfile
from typing import Any, Dict, List

from . import apps


class PackageError(ValueError):
    """A PDF selection cannot be packaged safely."""


def selected_documents(root: pathlib.Path, slug: str, ids: Any) -> List[Dict[str, Any]]:
    if not isinstance(ids, list) or not 1 <= len(ids) <= 8:
        raise PackageError("Select between one and eight PDF documents")
    if any(not isinstance(item, str) or not apps.DOC_ID.fullmatch(item) for item in ids):
        raise PackageError("The selection contains an invalid document id")
    if len(ids) != len(set(ids)):
        raise PackageError("Select each PDF only once")
    app = apps.load_application(root, slug)
    registry = {doc["id"]: doc for doc in app["documents"] if doc["type"] in ("block", "tex")}
    missing = [item for item in ids if item not in registry]
    if missing:
        raise PackageError("These are not PDF documents in this application: " + ", ".join(missing))
    return [registry[item] for item in ids]


def _name(slug: str, ids: List[str]) -> str:
    digest = hashlib.sha256((slug + ":" + ",".join(ids)).encode("utf-8")).hexdigest()[:8]
    label = re.sub(r"[^A-Za-z0-9_-]+", "_", "_".join(ids))[:62].strip("_")
    return f"{slug[:28]}_{label}_{digest}.pdf"


def merge(root: pathlib.Path, slug: str, ids: Any) -> Dict[str, Any]:
    docs = selected_documents(root, slug, ids)
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError as exc:
        raise PackageError("PDF packaging needs pypdf. Install it with: python -m pip install pypdf") from exc
    app = apps.load_application(root, slug)
    output_dir = root / "output" / apps._clean_rel(app.get("outputDir") or slug) / "packages"
    output_dir.mkdir(parents=True, exist_ok=True)
    writer = PdfWriter()
    total_pages = 0
    for doc in docs:
        path = root / doc["pdf"]
        if not path.is_file() or b"%%EOF" not in path.read_bytes()[-2048:]:
            raise PackageError("Build %s before packaging it" % doc["label"])
        reader = PdfReader(str(path), strict=True)
        pages = len(reader.pages)
        if pages < 1:
            raise PackageError("%s has no pages" % doc["label"])
        writer.append(reader)
        total_pages += pages
    writer.add_metadata({"/Title": app["title"] + " application documents",
                         "/Author": str(apps.load_profile(root).get("name") or "")})
    filename = _name(slug, ids)
    target = output_dir / filename
    fd, tmp_name = tempfile.mkstemp(prefix=".package-", suffix=".pdf", dir=output_dir)
    try:
        with os.fdopen(fd, "wb") as handle:
            writer.write(handle)
        os.replace(tmp_name, target)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)
    return {"name": filename, "path": target.relative_to(root).as_posix(),
            "bytes": target.stat().st_size, "pages": total_pages,
            "documents": [{"id": doc["id"], "label": doc["label"]} for doc in docs]}


def package_file(root: pathlib.Path, slug: str, name: str) -> pathlib.Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,120}\.pdf", str(name or "")):
        raise PackageError("Invalid package name")
    app = apps.load_application(root, slug)
    path = root / "output" / apps._clean_rel(app.get("outputDir") or slug) / "packages" / name
    if not path.is_file():
        raise PackageError("Build this PDF package first")
    return path
