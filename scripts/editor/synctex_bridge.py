"""Bidirectional SyncTeX for LaTeX Runner.

The ``synctex`` command-line tool answers inverse queries from the deepest
record near a point. LuaLaTeX, however, stamps many glyph, kern and math
records with the input position that was current when the page was shipped
out, not with the line they came from. On a two-column page the tool then
reports the same (wrong) source line for every click. This module therefore
reads the ``.synctex.gz`` file itself:

* records whose link equals the page's shipout link are treated as untrusted,
  the interword glue that TeX tags reliably is preferred;
* forward search returns the line boxes (left edge, width and height) that
  belong to a source line, so a highlight never jumps into the other column;
* the rendered words around a PDF double-click refine the hit to the exact
  source column, and repair the rare stale or ambiguous index entry.

The ``synctex`` binary remains a fallback when the file cannot be parsed.
"""
from __future__ import annotations

import bisect
import gzip
import os
import pathlib
import re
import subprocess
import threading
import time
import unicodedata
from collections import OrderedDict
from typing import Any, Dict, Iterable, List, Optional, Tuple

from process_utils import hidden_subprocess_kwargs

SP_PER_BP = 65536 * 72.27 / 72.0  # TeX scaled points per PDF point
WORD_PATTERN = re.compile(r"[^\W_]+(?:['’][^\W_]+)*", re.UNICODE)
RECORD = re.compile(
    r"^([\[\(hvxkg$r])(\d+),(-?\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?"
)
POINT_KINDS = "xkg$r"
BOX_OPEN = "[("
VOID_BOXES = "hv"
_TOKEN_CACHE: "OrderedDict[Tuple[str, int, int], List[Dict[str, Any]]]" = OrderedDict()
_TOKEN_LOCK = threading.Lock()
_DATA_CACHE: Dict[str, "SyncData"] = {}
_DATA_LOCK = threading.Lock()

INVISIBLE_ARGUMENT_COMMANDS = {
    "addbibresource", "autocite", "autoref", "cite", "citeauthor", "citetitle",
    "citeyear", "cref", "crefrange", "eqref", "glslabel", "include", "input",
    "label", "nocite", "pageref", "parencite", "ref", "textcite", "url",
}


# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #

def normalize_repo_path(repo_root: pathlib.Path, target_path: str) -> str:
    """Normalize a SyncTeX path to be repository-relative with forward slashes.

    SyncTeX mixes separators and keeps "." segments, e.g.
    ``C:\\Projects\\Example\\./sections/01.tex``; pathlib collapses those.
    Paths outside the repository yield an empty string.
    """
    raw = (target_path or "").strip().strip('"')
    if not raw:
        return raw
    candidate = pathlib.Path(raw)
    try:
        resolved = candidate.resolve() if candidate.is_absolute() else (repo_root / raw).resolve()
        return resolved.relative_to(repo_root.resolve()).as_posix()
    except (ValueError, OSError):
        pass
    posix = candidate.as_posix().replace("/./", "/")
    repo_posix = repo_root.as_posix()
    if posix.lower().startswith(repo_posix.lower() + "/"):
        return posix[len(repo_posix):].lstrip("/")
    return ""


def synctex_file_for(pdf_path: pathlib.Path) -> Optional[pathlib.Path]:
    for candidate in (pdf_path.with_suffix(".synctex.gz"), pdf_path.with_suffix(".synctex")):
        if candidate.exists():
            return candidate
    return None


_synctex_data_path = synctex_file_for  # backwards-compatible name


# --------------------------------------------------------------------------- #
# Parser
# --------------------------------------------------------------------------- #

class Page:
    __slots__ = ("number", "boxes", "points", "shipout", "point_h")

    def __init__(self, number: int) -> None:
        self.number = number
        # box: [kind, tag, line, left, top, right, bottom, parent]
        self.boxes: List[List[Any]] = []
        # point: (kind, tag, line, h, v, box_index)
        self.points: List[Tuple[str, int, int, int, int, int]] = []
        self.shipout: Optional[Tuple[int, int]] = None


class SyncData:
    """Parsed SyncTeX index of one PDF."""

    def __init__(self, repo_root: pathlib.Path, path: pathlib.Path) -> None:
        self.repo_root = repo_root.resolve()
        self.path = path
        # Generated inputs (.toc, .aux, .bbl in the output folder) are not
        # places an author can edit, so they never become a jump target.
        try:
            self.generated_prefix = path.resolve().parent.relative_to(self.repo_root).as_posix() + "/"
        except ValueError:
            self.generated_prefix = ""
        stat = path.stat()
        self.key = (stat.st_mtime_ns, stat.st_size)
        self.mtime = stat.st_mtime
        self.inputs: Dict[int, str] = {}
        self.relative: Dict[int, str] = {}
        self.pages: Dict[int, Page] = {}
        self.unit = 1.0
        self.magnification = 1000.0
        self.x_offset = 0.0
        self.y_offset = 0.0
        self.index: Dict[Tuple[int, int], List[Tuple[int, int]]] = {}
        self._parse()

    # ---------------------------------------------------------------- parse
    def _read_lines(self) -> List[str]:
        if self.path.suffix == ".gz":
            with gzip.open(self.path, "rb") as handle:
                raw = handle.read()
        else:
            raw = self.path.read_bytes()
        return raw.decode("utf-8", errors="replace").split("\n")

    def _parse(self) -> None:
        lines = self._read_lines()
        page: Optional[Page] = None
        stack: List[int] = []
        form_depth = 0
        in_content = False
        for line in lines:
            if not line:
                continue
            head = line[0]
            if head == "I" and line.startswith("Input:"):
                parts = line.split(":", 2)
                if len(parts) == 3 and parts[1].isdigit():
                    tag = int(parts[1])
                    self.inputs[tag] = parts[2]
                    relative = normalize_repo_path(self.repo_root, parts[2])
                    generated = self.generated_prefix not in ("", "./") and relative.startswith(self.generated_prefix)
                    if relative and not generated:
                        self.relative[tag] = relative
                continue
            if not in_content:
                if line.startswith("Content:"):
                    in_content = True
                elif line.startswith("Unit:"):
                    self.unit = _number(line[5:], 1.0)
                elif line.startswith("Magnification:"):
                    self.magnification = _number(line[14:], 1000.0)
                elif line.startswith("X Offset:"):
                    self.x_offset = _number(line[9:], 0.0)
                elif line.startswith("Y Offset:"):
                    self.y_offset = _number(line[9:], 0.0)
                continue
            if head == "{":
                number = _int(line[1:])
                page = Page(number) if number else None
                if page:
                    self.pages[number] = page
                stack = []
                continue
            if head == "}":
                page = None
                stack = []
                continue
            if head == "<":
                form_depth += 1
                continue
            if head == ">":
                form_depth = max(0, form_depth - 1)
                continue
            if page is None or form_depth:
                continue
            if head in "])":
                if stack:
                    stack.pop()
                continue
            match = RECORD.match(line)
            if not match:
                continue
            kind = match.group(1)
            tag = int(match.group(2))
            source_line = int(match.group(3))
            h = int(match.group(4))
            v = int(match.group(5))
            parent = stack[-1] if stack else -1
            if kind in BOX_OPEN or kind in VOID_BOXES:
                width = int(match.group(6) or 0)
                height = int(match.group(7) or 0)
                depth = int(match.group(8) or 0)
                left, right = (h, h + width) if width >= 0 else (h + width, h)
                box_kind = kind if kind in BOX_OPEN else ("(" if kind == "h" else "[")
                page.boxes.append([box_kind, tag, source_line, left, v - height, right, v + depth, parent])
                index = len(page.boxes) - 1
                if page.shipout is None and kind == "[":
                    page.shipout = (tag, source_line)
                if kind in BOX_OPEN:
                    stack.append(index)
                self.index.setdefault((tag, source_line), []).append((page.number, -1 - index))
                continue
            page.points.append((kind, tag, source_line, h, v, parent))
            self.index.setdefault((tag, source_line), []).append((page.number, len(page.points) - 1))

    # ----------------------------------------------------------- geometry
    def to_bp(self, value: float, offset: float = 0.0) -> float:
        return (value * self.unit * self.magnification / 1000.0 + offset) / SP_PER_BP

    def to_sp(self, value_bp: float) -> float:
        return value_bp * SP_PER_BP / (self.unit * self.magnification / 1000.0)

    def contaminated(self, page: Page, tag: int, line: int) -> bool:
        return page.shipout is not None and page.shipout == (tag, line)

    def line_box(self, page: Page, box_index: int) -> int:
        """Climb from a box to the outermost hbox directly inside a vbox."""
        current = box_index
        while current >= 0:
            parent = page.boxes[current][7]
            if parent < 0 or page.boxes[parent][0] != "(":
                break
            current = parent
        return current

    # ------------------------------------------------------------ inverse
    def inverse(self, page_number: int, x_bp: float, y_bp: float) -> Optional[Dict[str, Any]]:
        page = self.pages.get(page_number)
        if page is None or not page.boxes:
            return None
        x = self.to_sp(x_bp) - self.x_offset
        y = self.to_sp(y_bp) - self.y_offset
        tol_x = self.to_sp(0.6)
        tol_y = self.to_sp(1.2)
        containing = []
        for index, box in enumerate(page.boxes):
            kind, _tag, _line, left, top, right, bottom, _parent = box
            if kind != "(" or right <= left or bottom <= top:
                continue
            if left - tol_x <= x <= right + tol_x and top - tol_y <= y <= bottom + tol_y:
                containing.append(((right - left) * (bottom - top), index))
        containing.sort()
        order = [index for _area, index in containing]
        approximate = False
        if not order:
            nearest = self._nearest_line(page, x, y)
            if nearest is None:
                return None
            order = [nearest]
            approximate = True
        for index in order:
            hit = self._pick_record(page, page.boxes[index], x, page.boxes[self.line_box(page, index)])
            if hit:
                hit["approximate"] = approximate or hit.get("approximate", False)
                return hit
        # Every candidate line carries only untrusted records: use the box link.
        for index in order:
            box = page.boxes[index]
            relative = self.relative.get(box[1])
            if relative and box[2] > 0:
                return {"file": relative, "line": box[2], "approximate": True, "source": "box"}
        return None

    def _nearest_line(self, page: Page, x: float, y: float) -> Optional[int]:
        best = None
        best_distance = float("inf")
        limit = self.to_sp(40.0)
        for index, box in enumerate(page.boxes):
            kind, _tag, _line, left, top, right, bottom, _parent = box
            if kind != "(" or right <= left or bottom <= top:
                continue
            dx = 0.0 if left <= x <= right else min(abs(x - left), abs(x - right))
            dy = 0.0 if top <= y <= bottom else min(abs(y - top), abs(y - bottom))
            if dx > limit or dy > limit:
                continue
            distance = dx * 1.5 + dy
            if distance < best_distance:
                best_distance = distance
                best = index
        return best

    def _pick_record(self, page: Page, box: List[Any], x: float,
                     line_box: Optional[List[Any]] = None) -> Optional[Dict[str, Any]]:
        _kind, _tag, _line, left, top, right, bottom, _parent = box
        slack = self.to_sp(0.5)
        usable = []
        for kind, tag, line, h, v, _owner in page.points:
            if not (left - slack <= h <= right + slack and top - slack <= v <= bottom + slack):
                continue
            if line <= 0 or tag not in self.relative or self.contaminated(page, tag, line):
                continue
            usable.append((h, kind, tag, line))
        if not usable:
            return None
        # TeX tags every output line, and the few records it creates while
        # breaking the paragraph, with the line where the paragraph ended
        # (often the blank line after it). The words carry their own lines.
        if line_box is not None:
            words = [item for item in usable if (item[2], item[3]) != (line_box[1], line_box[2])]
            usable = words or usable
        usable.sort()
        positions = [item[0] for item in usable]
        # Records to the right of the click belong to the clicked word (its end
        # or the space after it); the space before a word can still carry the
        # previous source line when the word starts a new line of the file.
        right_index = bisect.bisect_left(positions, x - self.to_sp(0.25))
        chosen = usable[right_index] if right_index < len(usable) else usable[-1]
        h, kind, tag, line = chosen
        return {"file": self.relative[tag], "line": line, "record": kind,
                "approximate": right_index >= len(usable)}

    # ------------------------------------------------------------ forward
    def tags_for(self, relative: str) -> List[int]:
        wanted = relative.casefold()
        return [tag for tag, rel in self.relative.items() if rel.casefold() == wanted]

    def _is_artifact(self, page: Page, index: int) -> bool:
        """A record tagged like its own output line: paragraph-end bookkeeping."""
        kind, tag, line, _h, _v, owner = page.points[index]
        if owner < 0 or page.boxes[owner][0] != "(":
            return True
        box = page.boxes[self.line_box(page, owner)]
        if self.contaminated(page, tag, line) and (box[1], box[2]) == (tag, line):
            return True
        return (box[1], box[2]) == (tag, line) and kind != "g"

    def forward(self, relative: str, line: int, page_hint: int = 0,
                skip_line=None) -> Optional[Dict[str, Any]]:
        tags = self.tags_for(relative)
        if not tags:
            return None
        used_line = None
        records: List[Tuple[int, int]] = []
        for candidate in _line_search_order(line):
            if skip_line is not None and skip_line(candidate):
                continue
            points: List[Tuple[int, int]] = []
            artifacts: List[Tuple[int, int]] = []
            boxes: List[Tuple[int, int]] = []
            for tag in tags:
                for page_no, index in self.index.get((tag, candidate), []):
                    page = self.pages.get(page_no)
                    if page is None:
                        continue
                    if index < 0:
                        box = page.boxes[-1 - index]
                        if box[0] == "(" and box[5] > box[3] and box[6] > box[4]:
                            boxes.append((page_no, index))
                    elif self.contaminated(page, tag, candidate) and page.points[index][0] != "g":
                        continue
                    elif self._is_artifact(page, index):
                        artifacts.append((page_no, index))
                    else:
                        points.append((page_no, index))
            # Line boxes carry the line where TeX broke the paragraph; the glue
            # and glyph records inside them name the line each word came from.
            usable = points or boxes or artifacts
            if usable:
                used_line = candidate
                records = usable
                break
        if not records:
            return None
        pages = sorted({page_no for page_no, _ in records})
        page_no = page_hint if page_hint in pages else pages[0]
        page = self.pages[page_no]
        rects = self._line_rects(page, [index for number, index in records if number == page_no], tags, used_line)
        if not rects:
            return None
        first = rects[0]
        return {
            "success": True,
            "page": page_no,
            "x": first["x"], "y": first["y"] + first["height"],
            "width": first["width"], "height": first["height"],
            "rects": rects,
            "line": used_line,
            "approximate": used_line != line,
            "pages": pages,
        }

    def _line_rects(self, page: Page, indices: List[int], tags: List[int], line: int) -> List[Dict[str, float]]:
        groups: Dict[int, List[int]] = {}
        for index in indices:
            if index < 0:
                owner = self.line_box(page, -1 - index)
                groups.setdefault(owner, [])
                continue
            owner_box = page.points[index][5]
            if owner_box < 0 or page.boxes[owner_box][0] != "(":
                continue
            owner = self.line_box(page, owner_box)
            groups.setdefault(owner, []).append(index)
        rects = []
        tagset = set(tags)
        for owner, point_indices in groups.items():
            _kind, box_tag, box_line, left, top, right, bottom, _parent = page.boxes[owner]
            if right - left < self.to_sp(1) or bottom - top < self.to_sp(1):
                continue
            x1, x2 = left, right
            if point_indices:
                # Narrow the highlight to the part of the line this source line
                # produced, ignoring paragraph-end bookkeeping records.
                in_box = sorted(
                    (h, (tag in tagset and src == line))
                    for kind_, tag, src, h, v, _o in page.points
                    if left <= h <= right and top <= v <= bottom and src > 0
                    and not self.contaminated(page, tag, src)
                    and ((tag, src) != (box_tag, box_line) or (tag in tagset and src == line))
                )
                matched = [h for h, ok in in_box if ok]
                if matched:
                    start, stop = min(matched), max(matched)
                    following = [h for h, ok in in_box if not ok and h > stop]
                    preceding = [h for h, ok in in_box if not ok and h < start]
                    # The last record of a source line is the space after its
                    # last word; the one before its first word ends the
                    # previous line.
                    x1 = max(left, preceding[-1]) if preceding else left
                    x2 = min(right, stop + self.to_sp(2)) if following else right
                    if x2 - x1 < self.to_sp(6):
                        x1, x2 = left, right
            rects.append({
                "x": round(self.to_bp(x1, self.x_offset), 3),
                "y": round(self.to_bp(top, self.y_offset), 3),
                "width": round(self.to_bp(x2 - x1), 3),
                "height": round(self.to_bp(bottom - top), 3),
            })
        rects.sort(key=lambda r: (r["y"], r["x"]))
        if len(rects) > 30:
            # A figure: pgfplots tags every tick label with the same line.
            # One frame around all of them reads better than dozens of slivers.
            left = min(r["x"] for r in rects)
            top = min(r["y"] for r in rects)
            right = max(r["x"] + r["width"] for r in rects)
            bottom = max(r["y"] + r["height"] for r in rects)
            return [{"x": left, "y": top, "width": round(right - left, 3), "height": round(bottom - top, 3)}]
        return rects[:30]

    # ------------------------------------------------------------ sources
    def document_sources(self) -> List[str]:
        return sorted({rel for rel in self.relative.values() if rel.lower().endswith(".tex")})


def _number(text: str, fallback: float) -> float:
    try:
        return float(text.strip())
    except ValueError:
        return fallback


def _int(text: str) -> int:
    try:
        return int(text.strip())
    except ValueError:
        return 0


def _line_search_order(line: int, near: int = 30, far: int = 3000) -> Iterable[int]:
    """The line itself, then nearby earlier and later lines, then further away.

    Blank lines, comments and markup produce no typeset output of their own;
    pgfplots even stamps a whole figure with the line that closes the axis.
    """
    yield line
    for low, high in ((1, near), (near + 1, far)):
        for offset in range(low, high + 1):
            if line - offset >= 1:
                yield line - offset
        for offset in range(low, high + 1):
            yield line + offset


def load_synctex(repo_root: pathlib.Path, pdf_path: pathlib.Path) -> Optional[SyncData]:
    """Parse (or reuse) the SyncTeX index next to ``pdf_path``."""
    path = synctex_file_for(pdf_path)
    if path is None:
        return None
    key = str(path.resolve())
    try:
        stat = path.stat()
    except OSError:
        return None
    with _DATA_LOCK:
        cached = _DATA_CACHE.get(key)
        if cached and cached.key == (stat.st_mtime_ns, stat.st_size):
            return cached
        try:
            data = SyncData(repo_root, path)
        except (OSError, EOFError, ValueError):
            # A compile may be rewriting the file right now.
            return cached
        _DATA_CACHE.clear()
        _DATA_CACHE[key] = data
        return data


def warm(repo_root: pathlib.Path, pdf_path: pathlib.Path) -> None:
    """Parse the index in the background after a compile finished."""
    threading.Thread(target=load_synctex, args=(repo_root, pdf_path), daemon=True).start()


# --------------------------------------------------------------------------- #
# Text-context refinement
# --------------------------------------------------------------------------- #

def _fold(word):
    return unicodedata.normalize('NFKC', word).casefold().replace('’', "'")


def _cached_tokens(source):
    stat = source.stat()
    if stat.st_size > 4 * 1024 * 1024:
        return []
    key = (str(source), stat.st_mtime_ns, stat.st_size)
    with _TOKEN_LOCK:
        if key in _TOKEN_CACHE:
            _TOKEN_CACHE.move_to_end(key)
            return _TOKEN_CACHE[key]
    tokens = _source_tokens(source.read_text(encoding='utf-8', errors='replace'))
    with _TOKEN_LOCK:
        _TOKEN_CACHE[key] = tokens
        while len(_TOKEN_CACHE) > 400:
            _TOKEN_CACHE.popitem(last=False)
    return tokens


def refine_source_position(
    repo_root: pathlib.Path, hit: Dict[str, Any], word: str, reach: int = 3
) -> Dict[str, Any]:
    """Refine a line-level SyncTeX hit to the clicked plain-text word.

    SyncTeX engines frequently report no column. PDF.js tells us which rendered
    word received the double-click, so search a small source window around the
    SyncTeX line and return the exact column when that word occurs literally.
    Macros and transformed mathematics keep the line-level hit.
    """
    needle = (word or "").replace("\u00ad", "").strip()
    if not needle or len(needle) > 120 or not any(char.isalnum() for char in needle):
        hit["precision"] = "line"
        return hit
    try:
        source = (repo_root / hit["file"]).resolve()
        if repo_root.resolve() not in source.parents or not source.is_file():
            hit["precision"] = "line"
            return hit
        lines = source.read_text(encoding="utf-8", errors="replace").splitlines()
    except (OSError, ValueError, KeyError):
        hit["precision"] = "line"
        return hit

    anchor_line = max(1, int(hit.get("line", 1)))
    anchor_col = max(1, int(hit.get("column", 1)))
    best: Optional[Tuple[int, int, int]] = None
    start = max(1, anchor_line - reach)
    end = min(len(lines), anchor_line + reach)
    pattern = re.compile(r"(?<![\w\\])" + re.escape(needle) + r"(?!\w)", re.IGNORECASE)
    for line_number in range(start, end + 1):
        for match in pattern.finditer(lines[line_number - 1]):
            column = match.start() + 1
            score = abs(line_number - anchor_line) * 10_000 + abs(column - anchor_col)
            if best is None or score < best[0]:
                best = (score, line_number, column)
    if best is None:
        hit["precision"] = "line"
        return hit
    hit["line"] = best[1]
    hit["column"] = best[2]
    hit["precision"] = "word"
    hit["matchedWord"] = needle
    hit["length"] = len(needle)
    return hit


def _strip_tex_comments(text: str) -> str:
    """Remove unescaped TeX comments while preserving newlines and columns."""
    lines: List[str] = []
    for line in text.splitlines(keepends=True):
        cut = len(line)
        for index, char in enumerate(line):
            if char != "%":
                continue
            backslashes = 0
            cursor = index - 1
            while cursor >= 0 and line[cursor] == "\\":
                backslashes += 1
                cursor -= 1
            if backslashes % 2 == 0:
                cut = index
                break
        if cut < len(line):
            suffix = "\n" if line.endswith("\n") else ""
            lines.append(line[:cut] + suffix)
        else:
            lines.append(line)
    return "".join(lines)


def _blank_invisible_arguments(text: str) -> str:
    """Blank references and other non-rendered command arguments in-place."""
    chars = list(text)
    command_pattern = re.compile(r"\\([A-Za-z@]+)\*?")
    for match in command_pattern.finditer(text):
        command = match.group(1).lower()
        for index in range(match.start(), match.end()):
            if chars[index] != "\n":
                chars[index] = " "
        if command not in INVISIBLE_ARGUMENT_COMMANDS:
            continue
        cursor = match.end()
        while cursor < len(text):
            while cursor < len(text) and text[cursor].isspace():
                cursor += 1
            if cursor >= len(text) or text[cursor] not in "[{":
                break
            opening = text[cursor]
            closing = "]" if opening == "[" else "}"
            depth = 0
            while cursor < len(text):
                char = text[cursor]
                if chars[cursor] != "\n":
                    chars[cursor] = " "
                if char == opening and (cursor == 0 or text[cursor - 1] != "\\"):
                    depth += 1
                elif char == closing and (cursor == 0 or text[cursor - 1] != "\\"):
                    depth -= 1
                    if depth == 0:
                        cursor += 1
                        break
                cursor += 1
    return "".join(chars)


def _source_tokens(text: str) -> List[Dict[str, Any]]:
    """Tokenise visible-ish TeX prose and retain exact source coordinates."""
    cleaned = _blank_invisible_arguments(_strip_tex_comments(text))
    tokens: List[Dict[str, Any]] = []
    line_starts = [0]
    for match in re.finditer("\n", cleaned):
        line_starts.append(match.end())
    line_index = 0
    for match in WORD_PATTERN.finditer(cleaned):
        while line_index + 1 < len(line_starts) and line_starts[line_index + 1] <= match.start():
            line_index += 1
        tokens.append({
            "value": _fold(match.group(0)),
            "line": line_index + 1,
            "column": match.start() - line_starts[line_index] + 1,
        })
    return tokens


def _context_tokens(text: str) -> List[Dict[str, Any]]:
    return [
        {"value": _fold(match.group(0)), "start": match.start(), "end": match.end()}
        for match in WORD_PATTERN.finditer((text or "").replace("\u00ad", ""))
    ]


def _manuscript_sources(repo_root: pathlib.Path, synctex: Optional[SyncData] = None) -> List[pathlib.Path]:
    """The document's own .tex sources: SyncTeX inputs, else a bounded scan."""
    root = repo_root.resolve()
    if synctex is not None:
        files = [root / rel for rel in synctex.document_sources()]
        return [path for path in files if path.is_file()]
    found: List[pathlib.Path] = []
    skip = {".git", "build", "OUT", "node_modules", "__pycache__", ".venv", "venv"}
    for directory, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in skip and not d.startswith("."))
        for name in sorted(files):
            if name.lower().endswith(".tex"):
                found.append(pathlib.Path(directory) / name)
                if len(found) >= 1500:
                    return found
    return found


def resolve_source_context(
    repo_root: pathlib.Path,
    context: str,
    context_offset: int,
    word: str = "",
    synctex_hit: Optional[Dict[str, Any]] = None,
    synctex: Optional[SyncData] = None,
) -> Optional[Dict[str, Any]]:
    """Map PDF.js text context to the corresponding token in authored TeX.

    Matching a short rendered phrase against visible source tokens gives the
    precise word column and survives edits made after the last compile. The
    SyncTeX result is the tie-breaker when the phrase occurs more than once.
    """
    pdf_tokens = _context_tokens((context or "")[:500])
    if not pdf_tokens:
        return None
    offset = max(0, min(int(context_offset or 0), len(context or "")))
    clicked = min(
        range(len(pdf_tokens)),
        key=lambda index: 0 if pdf_tokens[index]["start"] <= offset < pdf_tokens[index]["end"]
        else min(abs(pdf_tokens[index]["start"] - offset), abs(pdf_tokens[index]["end"] - offset)),
    )
    if word:
        word_value = next(iter(_context_tokens(word)), {}).get("value")
        matching = [index for index, token in enumerate(pdf_tokens) if token["value"] == word_value]
        if matching:
            clicked = min(matching, key=lambda index: abs(index - clicked))

    root = repo_root.resolve()
    source_data: List[Tuple[str, List[Dict[str, Any]]]] = []
    for source in _manuscript_sources(root, synctex):
        try:
            tokens = _cached_tokens(source)
            relative = source.resolve().relative_to(root).as_posix()
        except (OSError, ValueError):
            continue
        source_data.append((relative, tokens))

    # Long phrases are decisive. Shorter windows preserve useful matching for
    # text split across PDF spans or interrupted by presentational TeX macros.
    windows: List[Tuple[int, int]] = []
    maximum = min(14, len(pdf_tokens))
    for length in range(maximum, 2, -1):
        start_min = max(0, clicked - length + 1)
        start_max = min(clicked, len(pdf_tokens) - length)
        for start in range(start_min, start_max + 1):
            window = (start, length)
            if window not in windows:
                windows.append(window)

    hit_file = (synctex_hit or {}).get("file", "")
    hit_line = int((synctex_hit or {}).get("line", 1))
    target = pdf_tokens[clicked]["value"]
    candidates = [(relative, tokens, index) for relative, tokens in source_data
                  for index, token in enumerate(tokens) if token['value'] == target]
    for pdf_start, length in windows:
        needle = [token["value"] for token in pdf_tokens[pdf_start:pdf_start + length]]
        clicked_in_window = clicked - pdf_start
        matches: List[Tuple[int, int, str, Dict[str, Any]]] = []
        for relative, tokens, clicked_index in candidates:
            source_start = clicked_index - clicked_in_window
            if source_start >= 0 and [t['value'] for t in tokens[source_start:source_start + length]] == needle:
                token = tokens[source_start + clicked_in_window]
                same_file_penalty = 0 if relative == hit_file else 1
                line_distance = abs(token["line"] - hit_line) if relative == hit_file else 0
                matches.append((same_file_penalty, line_distance, relative, token))
        if matches:
            # Never choose an arbitrary occurrence of a short, repeated phrase.
            if len(matches) > 1 and not any(m[0] == 0 for m in matches):
                continue
            same_file_penalty, _distance, relative, token = min(
                matches, key=lambda item: (item[0], item[1], item[2].casefold(), item[3]["line"])
            )
            return {
                "success": True,
                "file": relative,
                "line": token["line"],
                "column": token["column"],
                "precision": "context",
                "matchedWord": pdf_tokens[clicked]["value"],
                "length": pdf_tokens[clicked]["end"] - pdf_tokens[clicked]["start"],
                "contextTokens": length,
                "unique": len(matches) == 1,
            }
    return None


# --------------------------------------------------------------------------- #
# CLI fallback
# --------------------------------------------------------------------------- #

def _run_inverse_once(
    repo_root: pathlib.Path, pdf_path: pathlib.Path, page: int, x: float, y: float
) -> Optional[Dict[str, Any]]:
    """One `synctex edit` probe; None when SyncTeX reports no match."""
    cmd = ["synctex", "edit", "-o", f"{page}:{x:.2f}:{y:.2f}:{pdf_path.as_posix()}"]
    proc = subprocess.run(cmd, cwd=str(repo_root), capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=8,
                          **hidden_subprocess_kwargs())
    output = proc.stdout
    input_match = re.search(r"^Input:(.+)$", output, re.MULTILINE)
    line_match = re.search(r"^Line:(\d+)", output, re.MULTILINE)
    col_match = re.search(r"^Column:(-?\d+)", output, re.MULTILINE)
    if not (input_match and line_match):
        return None
    raw_file = input_match.group(1).strip()
    normalised = normalize_repo_path(repo_root, raw_file)
    if not normalised:
        return None
    column = int(col_match.group(1).strip()) if col_match else 1
    return {
        "success": True,
        "file": normalised,
        "line": max(1, int(line_match.group(1).strip())),
        "column": column if column >= 1 else 1,
        "raw_file": raw_file,
    }


def _run_forward_cli(repo_root: pathlib.Path, pdf_path: pathlib.Path, tex_path: pathlib.Path,
                     line: int, col: int) -> Optional[Dict[str, Any]]:
    proc = subprocess.run(
        ["synctex", "view", "-i", f"{line}:{col}:{tex_path.as_posix()}", "-o", pdf_path.as_posix()],
        cwd=str(repo_root), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=6,
        **hidden_subprocess_kwargs(),
    )
    output = proc.stdout
    match = re.search(r"^Page:(\d+)\s*^x:([0-9.]+)\s*^y:([0-9.]+)\s*^h:([0-9.]+)\s*^v:([0-9.]+)\s*"
                      r"^W:([0-9.]+)\s*^H:([0-9.]+)", output, re.MULTILINE)
    if not match:
        return None
    page, _x, _y, h, v, width, height = match.groups()
    rect = {"x": float(h), "y": float(v) - float(height), "width": float(width), "height": float(height)}
    return {"success": True, "page": int(page), "x": rect["x"], "y": float(v), "width": rect["width"],
            "height": rect["height"], "rects": [rect], "line": line, "approximate": False}


# --------------------------------------------------------------------------- #
# Public queries
# --------------------------------------------------------------------------- #

def _pdf(repo_root: pathlib.Path, pdf_rel_path: str) -> pathlib.Path:
    return (repo_root / pdf_rel_path).resolve()


def query_inverse_synctex(
    repo_root: pathlib.Path,
    page: int,
    x: float,
    y: float,
    pdf_rel_path: str = "build/main.pdf",
    word: str = "",
    context: str = "",
    context_offset: int = 0,
) -> Dict[str, Any]:
    """Inverse SyncTeX: PDF page + point (in PDF points, top-left origin) -> source."""
    repo_root = repo_root.resolve()
    pdf_path = _pdf(repo_root, pdf_rel_path)
    if repo_root not in pdf_path.parents:
        return {"success": False, "error": "PDF path escapes the repository.", "reason": "outside-root"}
    if not pdf_path.exists():
        return {"success": False, "error": "No compiled PDF yet. Press Recompile first.", "reason": "no-pdf"}

    started = time.perf_counter()
    data = load_synctex(repo_root, pdf_path)
    stale = False
    hit: Optional[Dict[str, Any]] = None
    if data is not None:
        try:
            stale = data.mtime + 2 < pdf_path.stat().st_mtime
        except OSError:
            stale = False
        hit = data.inverse(int(page), float(x), float(y))

    contextual = resolve_source_context(repo_root, context, context_offset, word=word,
                                        synctex_hit=hit, synctex=data)
    result: Optional[Dict[str, Any]] = None
    if contextual and hit:
        same_place = contextual["file"] == hit["file"] and abs(contextual["line"] - hit["line"]) <= 12
        decisive = contextual.get("unique") and contextual.get("contextTokens", 0) >= 6
        if same_place or decisive:
            result = contextual
    elif contextual and (contextual.get("unique") or data is None):
        result = contextual
    if result is None and hit:
        result = refine_source_position(repo_root, {"success": True, **hit, "column": 1}, word)
    if result is None and data is None:
        # No index at all: ask the synctex binary as a last resort.
        try:
            probe = _run_inverse_once(repo_root, pdf_path, int(page), float(x), float(y))
        except (FileNotFoundError, subprocess.SubprocessError, OSError):
            probe = None
        if probe:
            result = refine_source_position(repo_root, probe, word)
    if result is None:
        reason = "no-synctex" if data is None else "no-match"
        message = ("No SyncTeX data next to the PDF. Recompile once (SyncTeX is written by latexmk)."
                   if data is None else "No source found at that point. Double-click directly on a word.")
        return {"success": False, "error": message, "reason": reason, "stale": stale}
    result.setdefault("column", 1)
    result["success"] = True
    result["stale"] = stale
    result["approximate"] = bool(result.get("approximate"))
    result["elapsedMs"] = round((time.perf_counter() - started) * 1000)
    if hit:
        result["synctexFile"] = hit["file"]
        result["synctexLine"] = hit["line"]
    return result


def query_forward_synctex(
    repo_root: pathlib.Path,
    file_rel_path: str,
    line: int,
    col: int = 1,
    pdf_rel_path: str = "build/main.pdf",
    page_hint: int = 0,
) -> Dict[str, Any]:
    """Forward SyncTeX: source file + line -> PDF page and highlight rectangles."""
    repo_root = repo_root.resolve()
    pdf_path = _pdf(repo_root, pdf_rel_path)
    tex_path = (repo_root / file_rel_path).resolve()
    if repo_root not in pdf_path.parents or repo_root not in tex_path.parents:
        return {"success": False, "error": "SyncTeX paths must stay inside the repository."}
    if not pdf_path.exists():
        return {"success": False, "error": "No compiled PDF yet. Press Recompile first."}
    relative = tex_path.relative_to(repo_root).as_posix()
    data = load_synctex(repo_root, pdf_path)
    if data is not None:
        if not data.tags_for(relative):
            return {"success": False, "reason": "not-in-document",
                    "error": "%s is not part of the compiled document." % relative}
        try:
            source_lines = tex_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            source_lines = []

        def skip_line(number: int) -> bool:
            # Blank and comment-only lines typeset nothing of their own; TeX
            # merely tags the paragraph that ended there with them.
            if not 1 <= number <= len(source_lines):
                return False
            text = source_lines[number - 1].strip()
            return not text or text.startswith("%")

        result = data.forward(relative, max(1, int(line)), int(page_hint or 0), skip_line)
        if result:
            try:
                result["stale"] = data.mtime + 2 < pdf_path.stat().st_mtime
            except OSError:
                result["stale"] = False
            return result
        return {"success": False, "reason": "no-match",
                "error": "Nothing typeset near line %d of %s." % (line, relative)}
    try:
        result = _run_forward_cli(repo_root, pdf_path, tex_path, int(line), int(col))
    except FileNotFoundError:
        return {"success": False, "error": "No SyncTeX data and no 'synctex' program on PATH."}
    except (subprocess.SubprocessError, OSError) as exc:
        return {"success": False, "error": str(exc)}
    if result:
        return result
    return {"success": False, "error": "SyncTeX returned no page for that line. Recompile once."}
