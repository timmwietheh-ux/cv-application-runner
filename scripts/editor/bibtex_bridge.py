"""BibTeX parser for citation hover previews and autocomplete."""
from __future__ import annotations

import pathlib
import re
from typing import Any, Dict, List, Optional


def parse_bib_file(bib_path: pathlib.Path) -> Dict[str, Dict[str, Any]]:
    """Parse a BibTeX file into a structured dictionary keyed by citation key."""
    if not bib_path.exists():
        return {}

    try:
        content = bib_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return {}

    entries: Dict[str, Dict[str, Any]] = {}

    # Match @type{key, ...}
    raw_entries = re.split(r"(?=@\w+\s*\{)", content)

    for chunk in raw_entries:
        chunk = chunk.strip()
        if not chunk.startswith("@"):
            continue

        header_match = re.match(r"@(\w+)\s*\{\s*([^,]+),", chunk)
        if not header_match:
            continue

        entry_type = header_match.group(1).lower()
        key = header_match.group(2).strip()

        fields: Dict[str, str] = {}
        # Parse fields: name = {value} or name = "value" or name = 2020
        field_pattern = re.finditer(
            r"(\w+)\s*=\s*(?:\{((?:[^{}]|\{[^{}]*\})*)\}|\"([^\"]*)\"|([0-9a-zA-Z_-]+))",
            chunk,
            re.DOTALL,
        )
        for m in field_pattern:
            fname = m.group(1).lower()
            fval = m.group(2) if m.group(2) is not None else (m.group(3) if m.group(3) is not None else m.group(4))
            if fval:
                clean_val = re.sub(r"\s+", " ", fval.strip())
                # clean inner braces
                clean_val = re.sub(r"[{}]", "", clean_val)
                fields[fname] = clean_val

        entries[key] = {
            "key": key,
            "type": entry_type,
            "title": fields.get("title", ""),
            "author": fields.get("author", ""),
            "year": fields.get("year", fields.get("date", "")),
            "journal": fields.get("journal", fields.get("journaltitle", fields.get("booktitle", ""))),
            "doi": fields.get("doi", ""),
            "volume": fields.get("volume", ""),
            "pages": fields.get("pages", ""),
            "abstract": fields.get("abstract", ""),
            "raw": chunk,
        }

    return entries


def get_bibtex_completions(bib_path: pathlib.Path) -> List[Dict[str, Any]]:
    """Return autocomplete items for Monaco Editor."""
    return completions_from(parse_bib_file(bib_path))


def completions_from(entries: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Autocomplete items for already parsed entries (several .bib files merged)."""
    completions: List[Dict[str, Any]] = []

    for key, data in entries.items():
        label = key
        detail = f"{data['author']} ({data['year']})" if data['author'] else data['year']
        doc = f"**{data['title']}**\n\n*{data['journal']}* ({data['year']})\n\nDOI: {data['doi']}" if data['doi'] else f"**{data['title']}**\n\n*{data['journal']}* ({data['year']})"

        completions.append({
            "label": label,
            "insertText": key,
            "detail": detail,
            "documentation": doc,
            "type": data["type"],
            "title": data["title"],
            "author": data["author"],
            "year": data["year"],
        })

    return completions
