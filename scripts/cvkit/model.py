"""The block-document model: kinds, block types, validation and defaults.

Three kinds of document exist, each a JSON file in an application folder:

* ``cv``      a header and sections, every section a list of typed blocks;
* ``letter``  a header, address fields and a list of paragraphs;
* ``texts``   plain-text fields with character limits (portal forms).

``SCHEMA`` describes every block type and field. The Runner builds its forms
from it and the generator validates against it, so a new block type needs one
entry here plus one branch in ``render.py``.
"""
from __future__ import annotations

import copy
import json
import pathlib
import secrets
from typing import Any, Dict, List, Optional, Tuple

KINDS = ("cv", "letter", "texts")

# Field types understood by the Runner's form builder:
#   text      one line          longtext  a growing text area
#   facts     one line, parts separated by "|" (rendered with centred dots)
#   list      a list of longtext items (bullets)
#   rows      a list of {label, text}
#   cards     a list of {title, items}
#   code      raw LaTeX in a monospace area
#   number, select, bool, date
BLOCK_TYPES: Dict[str, Dict[str, Any]] = {
    "summary": {
        "label": "Summary panel",
        "icon": "fa-quote-left",
        "hint": "A short profile in a soft panel with a blue edge.",
        "fields": [
            {"key": "text", "label": "Text", "type": "longtext",
             "placeholder": "Two to four sentences: who you are, what you work on, what drives you."},
        ],
    },
    "entry": {
        "label": "Dated entry",
        "icon": "fa-calendar-days",
        "hint": "Education, research or work: dates in the gutter, facts in red, optional bullets.",
        "fields": [
            {"key": "date", "label": "Dates", "type": "text", "placeholder": "2024 - present"},
            {"key": "title", "label": "Title", "type": "text", "placeholder": "M.Sc. Physics"},
            {"key": "org", "label": "Organisation", "type": "facts", "placeholder": "Example organisation"},
            {"key": "meta", "label": "Key facts", "type": "facts",
             "placeholder": "One verifiable result | another key fact (separate facts with |)"},
            {"key": "text", "label": "Description", "type": "longtext", "placeholder": "Optional sentence below the facts."},
            {"key": "items", "label": "Bullet points", "type": "list", "placeholder": "What you did, with a strong verb."},
        ],
    },
    "cards": {
        "label": "Card grid",
        "icon": "fa-table-cells-large",
        "hint": "Two cards per row, each with a title and short points.",
        "fields": [
            {"key": "cards", "label": "Cards", "type": "cards"},
        ],
    },
    "rows": {
        "label": "Label rows",
        "icon": "fa-list",
        "hint": "Compact lines with a label in the gutter: skills, languages, coursework.",
        "fields": [
            {"key": "rows", "label": "Rows", "type": "rows"},
        ],
    },
    "text": {
        "label": "Paragraph",
        "icon": "fa-paragraph",
        "hint": "Free text across the full width.",
        "fields": [
            {"key": "text", "label": "Text", "type": "longtext"},
        ],
    },
    "latex": {
        "label": "Raw LaTeX",
        "icon": "fa-code",
        "hint": "Escape hatch for anything the other blocks cannot express.",
        "fields": [
            {"key": "latex", "label": "LaTeX", "type": "code"},
        ],
    },
    "pagebreak": {
        "label": "Page break",
        "icon": "fa-scissors",
        "hint": "Starts a new page at this point.",
        "fields": [],
    },
}

# Letters hold paragraphs only; the kind of block stays extensible.
LETTER_BLOCK_TYPES: Dict[str, Dict[str, Any]] = {
    "paragraph": {
        "label": "Paragraph",
        "icon": "fa-paragraph",
        "hint": "One paragraph of the letter.",
        "fields": [{"key": "text", "label": "Text", "type": "longtext"}],
    },
    "latex": BLOCK_TYPES["latex"],
}

HEADER_FIELDS = [
    {"key": "name", "label": "Name", "type": "text", "placeholder": "Leave empty to use the profile name"},
    {"key": "headline", "label": "Headline", "type": "text", "placeholder": "Your professional headline"},
    {"key": "tagline", "label": "Tagline", "type": "facts", "placeholder": "Role | area of work"},
    {"key": "contacts", "label": "Contact lines", "type": "contacts"},
]

CV_FIELDS = [
    {"key": "footer", "label": "Footer label", "type": "text", "placeholder": "Curriculum Vitae (empty: no footer)"},
]

LETTER_FIELDS = [
    {"key": "recipient", "label": "Recipient", "type": "longtext", "placeholder": "One line per address line"},
    {"key": "place", "label": "Place", "type": "text", "placeholder": "Your city"},
    {"key": "date", "label": "Date", "type": "text", "placeholder": "Empty: today's date"},
    {"key": "subject", "label": "Subject", "type": "text"},
    {"key": "salutation", "label": "Salutation", "type": "text", "placeholder": "Dear Members of the Selection Committee,"},
    {"key": "closing", "label": "Closing", "type": "text", "placeholder": "Sincerely,"},
    {"key": "signature", "label": "Name under the letter", "type": "text", "placeholder": "Empty: profile name"},
    {"key": "enclosures", "label": "Enclosures", "type": "text", "placeholder": "Optional"},
    {"key": "bodyFrom", "label": "Take the body from", "type": "text",
     "placeholder": "Optional: portal.json#motivation keeps letter and portal field identical"},
]

TEXT_FIELD_FIELDS = [
    {"key": "title", "label": "Field", "type": "text"},
    {"key": "prompt", "label": "Portal prompt", "type": "longtext"},
    {"key": "limit", "label": "Character limit", "type": "number"},
    {"key": "status", "label": "Status", "type": "select", "options": ["draft", "review", "final"]},
    {"key": "text", "label": "Text", "type": "longtext"},
    {"key": "notes", "label": "Notes (not exported)", "type": "longtext"},
]

STATUSES = ["idea", "preparing", "ready", "submitted", "interview", "offer", "declined", "archived"]

DEFAULT_CATEGORIES = [
    {"id": "phd", "label": "PhD & graduate schools", "icon": "fa-graduation-cap"},
    {"id": "academic", "label": "Academic positions", "icon": "fa-flask"},
    {"id": "industry", "label": "Industry", "icon": "fa-building"},
    {"id": "scholarship", "label": "Scholarships & programmes", "icon": "fa-award"},
    {"id": "general", "label": "General CVs", "icon": "fa-id-card"},
]


def schema() -> Dict[str, Any]:
    """Everything the Runner needs to build its forms."""
    return {
        "kinds": list(KINDS),
        "blockTypes": copy.deepcopy(BLOCK_TYPES),
        "letterBlockTypes": copy.deepcopy(LETTER_BLOCK_TYPES),
        "header": copy.deepcopy(HEADER_FIELDS),
        "cv": copy.deepcopy(CV_FIELDS),
        "letter": copy.deepcopy(LETTER_FIELDS),
        "textField": copy.deepcopy(TEXT_FIELD_FIELDS),
        "statuses": list(STATUSES),
        "categories": copy.deepcopy(DEFAULT_CATEGORIES),
    }


def new_id(prefix: str = "b") -> str:
    return "%s-%s" % (prefix, secrets.token_hex(3))


class DocumentError(ValueError):
    """A block document that cannot be rendered, with a readable reason."""


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return " | ".join(str(item) for item in value)
    return str(value)


def _strings(value: Any) -> List[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        value = [value]
    return [str(item) for item in value if item is not None]


def normalize_block(block: Any, types: Dict[str, Dict[str, Any]], where: str) -> Dict[str, Any]:
    if not isinstance(block, dict):
        raise DocumentError("%s must be an object" % where)
    kind = block.get("type")
    if kind not in types:
        raise DocumentError("%s has unknown type %r (known: %s)" % (where, kind, ", ".join(sorted(types))))
    out: Dict[str, Any] = {"id": str(block.get("id") or new_id()), "type": kind}
    if block.get("hidden"):
        out["hidden"] = True
    if block.get("note"):
        out["note"] = str(block["note"])
    for field in types[kind]["fields"]:
        key, ftype = field["key"], field["type"]
        value = block.get(key)
        if ftype in ("text", "longtext", "code", "facts"):
            out[key] = _text(value)
        elif ftype == "list":
            out[key] = _strings(value)
        elif ftype == "rows":
            rows = []
            for index, row in enumerate(value or []):
                if not isinstance(row, dict):
                    raise DocumentError("%s row %d must be an object" % (where, index + 1))
                rows.append({"label": _text(row.get("label")), "text": _text(row.get("text"))})
            out[key] = rows
        elif ftype == "cards":
            cards = []
            for index, card in enumerate(value or []):
                if not isinstance(card, dict):
                    raise DocumentError("%s card %d must be an object" % (where, index + 1))
                cards.append({"title": _text(card.get("title")), "items": _strings(card.get("items"))})
            out[key] = cards
        else:
            out[key] = value
    return out


def _normalize_header(header: Any) -> Dict[str, Any]:
    header = header if isinstance(header, dict) else {}
    contacts = header.get("contacts")
    if contacts is None:
        contacts = ["location", "email", "linkedin", "github"]
    return {
        "name": _text(header.get("name")),
        "headline": _text(header.get("headline")),
        "tagline": _text(header.get("tagline")),
        "contacts": [str(item) for item in contacts if item],
    }


def normalize(doc: Any) -> Dict[str, Any]:
    """Return a clean copy of ``doc`` with ids, defaults and checked types."""
    if not isinstance(doc, dict):
        raise DocumentError("A block document must be a JSON object")
    kind = doc.get("kind")
    if kind not in KINDS:
        raise DocumentError("Unknown document kind %r (expected one of %s)" % (kind, ", ".join(KINDS)))
    out: Dict[str, Any] = {"kind": kind, "title": _text(doc.get("title"))}
    if doc.get("pdf"):
        pdf = doc["pdf"] if isinstance(doc["pdf"], dict) else {}
        out["pdf"] = {key: _text(pdf.get(key)) for key in ("title", "subject", "keywords") if pdf.get(key)}
    if kind == "cv":
        out["header"] = _normalize_header(doc.get("header"))
        out["footer"] = _text(doc.get("footer", "Curriculum Vitae"))
        sections = []
        for s_index, section in enumerate(doc.get("sections") or []):
            if not isinstance(section, dict):
                raise DocumentError("Section %d must be an object" % (s_index + 1))
            clean = {"id": str(section.get("id") or new_id("s")), "title": _text(section.get("title"))}
            if section.get("hidden"):
                clean["hidden"] = True
            clean["blocks"] = [
                normalize_block(block, BLOCK_TYPES, "Section %r block %d" % (clean["title"], b_index + 1))
                for b_index, block in enumerate(section.get("blocks") or [])
            ]
            sections.append(clean)
        out["sections"] = sections
    elif kind == "letter":
        out["header"] = _normalize_header(doc.get("header"))
        for field in LETTER_FIELDS:
            out[field["key"]] = _text(doc.get(field["key"]))
        out["body"] = [
            normalize_block(block, LETTER_BLOCK_TYPES, "Paragraph %d" % (index + 1))
            for index, block in enumerate(doc.get("body") or [])
        ]
    else:
        out["portal"] = _text(doc.get("portal"))
        out["intro"] = _text(doc.get("intro"))
        fields = []
        for index, field in enumerate(doc.get("fields") or []):
            if not isinstance(field, dict):
                raise DocumentError("Text field %d must be an object" % (index + 1))
            limit = field.get("limit")
            try:
                limit = int(limit) if limit not in (None, "") else None
            except (TypeError, ValueError) as exc:
                raise DocumentError("Text field %d has a non-numeric limit" % (index + 1)) from exc
            status = str(field.get("status") or "draft")
            fields.append({
                "id": str(field.get("id") or new_id("f")),
                "title": _text(field.get("title")),
                "prompt": _text(field.get("prompt")),
                "limit": limit,
                "required": bool(field.get("required")),
                "status": status if status in ("draft", "review", "final") else "draft",
                "text": _text(field.get("text")),
                "notes": _text(field.get("notes")),
            })
        out["fields"] = fields
    return out


def load(path: pathlib.Path) -> Dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise DocumentError("Cannot read %s: %s" % (path, exc)) from exc
    except ValueError as exc:
        raise DocumentError("%s is not valid JSON: %s" % (path.name, exc)) from exc
    return normalize(data)


def dumps(doc: Dict[str, Any]) -> str:
    """Serialise a document the way the repository stores it."""
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def iter_texts(doc: Dict[str, Any]) -> List[Tuple[str, str]]:
    """(location, text) pairs of every visible text value, for checks and search."""
    found: List[Tuple[str, str]] = []
    header = doc.get("header") or {}
    for key in ("name", "headline", "tagline"):
        if header.get(key):
            found.append(("header." + key, header[key]))
    if doc["kind"] == "cv":
        for section in doc["sections"]:
            if section.get("hidden"):
                continue
            found.append(("%s.title" % section["id"], section["title"]))
            for block in section["blocks"]:
                if block.get("hidden"):
                    continue
                base = "%s.%s" % (section["id"], block["id"])
                for key, value in block.items():
                    if key in ("id", "type", "hidden", "note"):
                        continue
                    if isinstance(value, str) and value:
                        found.append((base + "." + key, value))
                    elif isinstance(value, list):
                        for index, item in enumerate(value):
                            if isinstance(item, str):
                                found.append(("%s.%s.%d" % (base, key, index), item))
                            elif isinstance(item, dict):
                                for sub, text in item.items():
                                    if isinstance(text, str) and text:
                                        found.append(("%s.%s.%d.%s" % (base, key, index, sub), text))
                                    elif isinstance(text, list):
                                        for j, entry in enumerate(text):
                                            found.append(("%s.%s.%d.%s.%d" % (base, key, index, sub, j), str(entry)))
    elif doc["kind"] == "letter":
        for field in LETTER_FIELDS:
            if doc.get(field["key"]):
                found.append((field["key"], doc[field["key"]]))
        for block in doc["body"]:
            if not block.get("hidden"):
                found.append((block["id"], block.get("text") or block.get("latex") or ""))
    else:
        for field in doc["fields"]:
            found.append((field["id"], field["text"]))
    return found


def find_block(doc: Dict[str, Any], block_id: str) -> Optional[Dict[str, Any]]:
    if doc["kind"] == "cv":
        for section in doc["sections"]:
            if section["id"] == block_id:
                return section
            for block in section["blocks"]:
                if block["id"] == block_id:
                    return block
    elif doc["kind"] == "letter":
        for block in doc["body"]:
            if block["id"] == block_id:
                return block
    return None
