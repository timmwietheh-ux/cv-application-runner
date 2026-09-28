"""Portal text fields: exact character counts and the copy-ready sheet.

Web forms count differently. A typical portal shows ``textarea.value.length``
(JavaScript, UTF-16 code units, one character per line break). A server that
validates the submitted bytes sees UTF-8 and CRLF line breaks instead. The
Runner shows both, so a text that fits the counter also survives a stricter
server check.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

MARKER = "<!-- portal-texts -->"


def count(text: Any) -> Dict[str, int]:
    value = str(text or "").replace("\r\n", "\n")
    return {
        "chars": len(value.encode("utf-16-le")) // 2,
        "bytes": len(value.replace("\n", "\r\n").encode("utf-8")),
        "words": len(value.split()),
        "lines": value.count("\n") + 1 if value else 0,
        "nonAscii": sum(1 for char in value if ord(char) > 127),
    }


def field_state(field: Dict[str, Any]) -> Dict[str, Any]:
    counts = count(field.get("text"))
    limit = field.get("limit")
    over = bool(limit) and counts["chars"] > limit
    strict_over = bool(limit) and counts["bytes"] > limit
    return {"counts": counts, "limit": limit, "over": over, "strictOver": strict_over,
            "empty": not str(field.get("text") or "").strip()}


def _fence(text: str) -> str:
    fence = "```"
    while fence in text:
        fence += "`"
    return "%stext\n%s\n%s" % (fence, text.rstrip("\n"), fence)


def export_markdown(doc: Dict[str, Any], checklist: Optional[str] = None, title: str = "") -> str:
    """The upload-ready sheet: checklist text with the counted fields inserted."""
    blocks: List[str] = []
    for field in doc.get("fields") or []:
        state = field_state(field)
        counts = state["counts"]
        limit = field.get("limit")
        head = "## %s" % (field.get("title") or field.get("id"))
        if limit:
            meta = "Character count: %s / %s (portal counter)" % (format(counts["chars"], ","), format(limit, ","))
            if counts["bytes"] != counts["chars"]:
                meta += ", %s UTF-8 bytes with CRLF line breaks" % format(counts["bytes"], ",")
        else:
            meta = "Character count: %s (no limit given)" % format(counts["chars"], ",")
        if state["over"]:
            meta += ". **Over the limit.**"
        status = field.get("status") or "draft"
        if status != "final":
            meta += " Status: %s." % status
        parts = [head, meta]
        if field.get("prompt"):
            parts.append("> " + field["prompt"].replace("\n", "\n> "))
        parts.append(_fence(field.get("text") or ""))
        blocks.append("\n\n".join(parts))
    generated = "\n\n".join(blocks)
    if checklist and MARKER in checklist:
        return checklist.replace(MARKER, generated).rstrip() + "\n"
    heading = "# %s\n\n" % (title or doc.get("title") or "Portal texts")
    intro = (doc.get("intro") + "\n\n") if doc.get("intro") else ""
    return heading + intro + generated + "\n"


def over_limit(doc: Dict[str, Any]) -> List[str]:
    return [field.get("title") or field.get("id") for field in doc.get("fields") or [] if field_state(field)["over"]]


def normalize_whitespace(text: str) -> str:
    """Trim trailing spaces per line, the way a careful paste would."""
    return re.sub(r"[ \t]+\n", "\n", str(text or "")).strip("\n")
