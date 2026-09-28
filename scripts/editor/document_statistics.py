"""Read-only, on-demand source estimates. No TeX execution or AI calls."""
from __future__ import annotations

import bisect
from datetime import datetime, timezone
import os
from pathlib import Path
import re
import statistics
import subprocess
import threading
import time

from outline_parser import LEVELS, extract_group, skip_space
from process_utils import hidden_subprocess_kwargs

MAX_SOURCE_BYTES = 4 * 1024 * 1024
MAX_EXPANDED_CHARS = 12 * 1024 * 1024
MATH_ENVS = set("equation align gather multline eqnarray flalign alignat dmath displaymath math".split())
FLOAT_ENVS = {"figure", "table", "longtable"}
IGNORE_ENVS = {"comment", "verbatim", "Verbatim", "lstlisting", "minted", "tikzpicture",
               "tabular", "tabularx", "tabulary"}
TOKEN = re.compile(r"\\([A-Za-z@]+\*?|.)|\$\$?|\n[ \t\r]*\n", re.DOTALL)
WORDS = re.compile(r"[^\W_]+(?:[’'\-][^\W_]+)*", re.UNICODE)
METRICS = ("words", "body_words", "heading_words", "caption_words", "paragraphs", "equations", "figures", "tables")


def roman_number(value):
    if not 0 < value < 4000:
        return str(value)
    numerals = ((1000, "M"), (900, "CM"), (500, "D"), (400, "CD"),
                (100, "C"), (90, "XC"), (50, "L"), (40, "XL"),
                (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"))
    result = []
    for amount, symbol in numerals:
        while value >= amount:
            result.append(symbol)
            value -= amount
    return "".join(result)


def printed_number(path, level):
    """Derive the printed unit from the canonical module filename."""
    name = Path(str(path).replace("\\", "/")).name
    # Appendices are lettered A, B, C, ... (``B_03_02_`` is B.3.2).
    appendix = re.match(r"^([A-Z])(?:_(\d{2}))?(?:_(\d{2}))?_", name)
    if appendix:
        parts = [appendix.group(1)] + [str(int(part)) for part in appendix.groups()[1:] if part]
        return ".".join(parts[:max(1, level - 1)])
    section = re.match(r"^(\d{2})(?:_(\d{2}))?(?:_(\d{2}))?_", name)
    if not section:
        return ""
    parts = [roman_number(int(section.group(1)))] + [str(int(part)) for part in section.groups()[1:] if part]
    return ".".join(parts[:max(1, level - 1)])
SKIP_ARGS = {
    "label": 1, "ref": 1, "eqref": 1, "pageref": 1, "autoref": 1, "cref": 1, "Cref": 1,
    "cite": 1, "citep": 1, "citet": 1, "parencite": 1, "textcite": 1, "nocite": 1,
    "url": 1, "href": 1, "color": 1, "textcolor": 1, "colorbox": 1,
    "setcounter": 2, "addtocounter": 2, "setlength": 2, "addtolength": 2,
    "vspace": 1, "hspace": 1, "rule": 2, "includegraphics": 1,
    "bibliography": 1, "bibliographystyle": 1, "addbibresource": 1,
    "graphicspath": 1, "input": 1, "include": 1, "subfile": 1,
    "patchcmd": 5, "definecolor": 3, "hypersetup": 1, "documentclass": 1,
    "usepackage": 1, "renewenvironment": 3, "newenvironment": 3,
}


def blank(text):
    return re.sub(r"[^\n]", " ", text)


def argument(text, pos):
    """Skip optional arguments and read one balanced mandatory argument."""
    pos = skip_space(text, pos)
    while pos < len(text) and text[pos] == "[":
        group = extract_group(text, pos, "[")
        if not group:
            break
        pos = skip_space(text, group[1])
    group = extract_group(text, pos)
    return group if group else ("", pos)


def skip_arguments(text, pos, count):
    for _ in range(count):
        _, pos = argument(text, pos)
    return pos


def prepare(text):
    # Preserve every offset so source links point at the original line.
    text = re.sub(r"\\.|%[^\n]*", lambda m: blank(m[0]) if m[0].startswith("%") else m[0], text)
    pattern = re.compile(
        r"\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator)\*?"
        r"|\\(?:def|gdef|edef|xdef)\b"
        r"|\\begin\s*\{(comment|verbatim|Verbatim|lstlisting|minted)\}"
        r"|\\iffalse\b")
    pos = 0
    pieces = []
    m = pattern.search(text, pos)
    while m:
        end = m.end()
        if m[1]:
            closing = re.search(r"\\end\s*\{" + re.escape(m[1]) + r"\}", text[end:])
            end = end + closing.end() if closing else len(text)
        elif m[0] == r"\iffalse":
            depth = 1
            for conditional in re.finditer(r"\\(?:if[A-Za-z@]*|fi)\b", text[end:]):
                depth += -1 if conditional[0] == r"\fi" else 1
                if depth == 0:
                    end += conditional.end()
                    break
            else:
                end = len(text)
        elif re.match(r"\\(?:def|gdef|edef|xdef)\b", m[0]):
            opening = text.find("{", end)
            group = extract_group(text, opening) if opening >= 0 else None
            end = group[1] if group else end
        else:
            start = skip_space(text, end)
            if start < len(text) and text[start] == "{":
                _, end = argument(text, start)
            else:
                command = re.match(r"\\[A-Za-z@]+", text[start:])
                end = start + len(command[0]) if command else start
            _, end = argument(text, end)
        pieces.extend((text[pos:m.start()], blank(text[m.start():end])))
        pos = end
        m = pattern.search(text, pos)
    pieces.append(text[pos:])
    return "".join(pieces)


def plain_text(text):
    """Flatten prose wrappers, dropping math, refs, layout arguments and keys."""
    out = []
    pos = 0
    while match := TOKEN.search(text, pos):
        out.append(text[pos:match.start()])
        pos = match.end()
        cmd = (match[1] or "").rstrip("*")
        if match[0].startswith("$") or cmd in ("(", "["):
            closing = {"(": r"\)", "[": r"\]"}.get(cmd, match[0])
            end = text.find(closing, pos)
            pos = end + len(closing) if end >= 0 else len(text)
            out.append(" ")
        elif cmd in SKIP_ARGS or "cite" in cmd:
            pos = skip_arguments(text, pos, SKIP_ARGS.get(cmd, 1))
        elif cmd in ("begin", "end"):
            _, pos = argument(text, pos)
        elif cmd in ("textls", "textbf", "textit", "emph"):
            start = skip_space(text, pos)
            optional = extract_group(text, start, "[")
            if optional:
                pos = optional[1]
        elif cmd in ("%", "&", "_", "#"):
            out.append(cmd)
        elif not cmd or cmd in ("par", "item", "\\", "newline", "linebreak"):
            out.append(" ")
    out.append(text[pos:])
    return re.sub(r"\s+", " ", "".join(out).translate(str.maketrans("{}~", "   "))).strip()


# Real TeX conditionals; the math relation \iff and the \iffalse block (removed
# in prepare) are not among them.
CONDITIONAL = re.compile(r"\\if(?!f\b|false\b)[A-Za-z@]*\b")


class DocumentScan:
    def __init__(self, root, overrides=None, main="main.tex", aux="build/main.aux", figure_dirs=("Figures",)):
        self.root = Path(root).resolve()
        self.overrides = overrides or {}
        self.main = main
        self.aux = aux
        self.figure_dirs = tuple(figure_dirs)
        # Problems that make counts incomplete, and neutral remarks about scope.
        self.warnings = []
        self.notes = []
        self.files = {}
        self.spans = []
        self.parts = []
        self.length = 0

    def resolve(self, raw, current, extensions=(".tex",)):
        for base in (self.root, current.parent, *(self.root / folder for folder in self.figure_dirs)):
            for suffix in ("",) + extensions:
                try:
                    candidate = (base / (raw.strip() + suffix)).resolve()
                    if candidate.is_relative_to(self.root) and candidate.is_file():
                        return candidate
                except (OSError, ValueError):
                    pass
        return None

    def append(self, text, file, start):
        if self.length + len(text) > MAX_EXPANDED_CHARS:
            raise ValueError("Document exceeds the 12 MiB statistics scan limit")
        if text:
            self.spans.append((self.length, file, start))
            self.parts.append(text)
            self.length += len(text)

    def expand(self, file, stack=()):
        file = file.resolve()
        if not file.is_relative_to(self.root):
            self.warnings.append("Input outside repository skipped")
            return
        if file in stack or len(stack) >= 60:
            self.warnings.append("Cyclic or overly deep input skipped: " + file.name)
            return
        key = file.relative_to(self.root).as_posix()
        try:
            if file.stat().st_size > MAX_SOURCE_BYTES:
                self.warnings.append("Source larger than 4 MiB skipped: " + key)
                return
            raw = self.overrides.get(key)
            if raw is None:
                raw = file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            self.warnings.append("Cannot read source: " + key)
            return
        text = prepare(raw)
        self.files[key] = {"line_starts": [0] + [m.end() for m in re.finditer("\n", raw)],
                           "bytes": len(raw.encode("utf-8")), "lines": len(raw.splitlines())}
        if CONDITIONAL.search(text):
            self.notes.append("Conditional TeX is not evaluated (both branches count): " + key)
        pos = 0
        for m in re.finditer(r"\\(?:input|include|subfile)\s*\{([^{}]+)\}", text):
            self.append(text[pos:m.start()], key, pos)
            target = self.resolve(m[1], file)
            if target:
                self.expand(target, stack + (file,))
            else:
                self.warnings.append("Unresolved input: " + m[1])
            pos = m.end()
        self.append(text[pos:], key, pos)

    def location(self, offset):
        if not self.spans:
            return {"file": self.main, "line": 1}
        index = max(0, bisect.bisect_right(self.offsets, offset) - 1)
        start, file, local = self.spans[index]
        line = bisect.bisect_right(self.files[file]["line_starts"], local + offset - start)
        return {"file": file, "line": line}

    def scan(self):
        entry = self.root / self.main
        if not entry.is_file():
            raise ValueError("%s was not found" % self.main)
        self.expand(entry)
        text = "".join(self.parts)
        self.offsets = [s[0] for s in self.spans]
        begin = re.search(r"\\begin\s*\{document\}", text)
        pos = begin.end() if begin else 0
        end_doc = re.search(r"\\end\s*\{document\}", text[pos:])
        if end_doc:
            text = text[:pos + end_doc.start()]
        sections = [{"id": 0, "parent": None, "level": -1, "title": "Document", "number": "", "children": [],
                     "own": dict.fromkeys(METRICS, 0), "file": self.main, "line": 1}]
        stack = [0]
        paragraphs, figures, tables = [], [], []
        buffer = []
        paragraph_start = pos

        def add(metric, amount):
            sections[stack[-1]]["own"][metric] += amount

        def flush():
            nonlocal buffer
            visible = plain_text("".join(buffer))
            count = len(WORDS.findall(visible))
            if count:
                paragraphs.append({"id": len(paragraphs), "section": stack[-1], "words": count,
                                   "preview": visible[:240], **self.location(paragraph_start)})
                add("body_words", count)
                add("words", count)
                add("paragraphs", 1)
            buffer = []

        while match := TOKEN.search(text, pos):
            chunk = text[pos:match.start()]
            if not buffer:
                paragraph_start = pos + len(chunk) - len(chunk.lstrip())
            buffer.append(chunk)
            pos = match.end()
            cmd = (match[1] or "").rstrip("*")
            if not cmd and match[0].startswith("\n"):
                flush()
                continue
            if cmd in LEVELS:
                flush()
                title, pos = argument(text, pos)
                level = LEVELS[cmd]
                while len(stack) > 1 and sections[stack[-1]]["level"] >= level:
                    stack.pop()
                location = self.location(match.start())
                node = {"id": len(sections), "parent": stack[-1], "level": level,
                        "title": plain_text(title), "number": printed_number(location["file"], level),
                        "children": [], "own": dict.fromkeys(METRICS, 0), **location}
                sections[stack[-1]]["children"].append(node["id"])
                sections.append(node)
                stack.append(node["id"])
                count = len(WORDS.findall(node["title"]))
                add("heading_words", count)
                add("words", count)
                continue
            if cmd == "begin":
                env, after = argument(text, pos)
                base = env.rstrip("*")
                if base in MATH_ENVS | FLOAT_ENVS | IGNORE_ENVS:
                    closing = re.search(r"\\end\s*\{" + re.escape(env) + r"\}", text[after:])
                    end = after + closing.start() if closing else len(text)
                    body = text[after:end]
                    pos = after + closing.end() if closing else len(text)
                    if not closing:
                        self.warnings.append("Unclosed environment: " + env)
                    if base in MATH_ENVS:
                        if base != "math":
                            add("equations", 1)
                        buffer.append(" ")
                    elif base in FLOAT_ENVS:
                        flush()
                        kind = "figures" if base == "figure" else "tables"
                        add(kind, 1)
                        captions = []
                        for cap in re.finditer(r"\\caption\*?(?=\s*[\[{])", body):
                            raw_caption, _ = argument(body, cap.end())
                            captions.append(plain_text(raw_caption))
                        caption = " ".join(captions)
                        count = len(WORDS.findall(caption))
                        add("caption_words", count)
                        add("words", count)
                        label = re.search(r"\\label\s*\{([^}]+)\}", body)
                        item = {"caption": caption[:400], "label": label[1] if label else "",
                                "section": stack[-1], **self.location(match.start())}
                        (figures if kind == "figures" else tables).append(item)
                    continue
                pos = after
                continue
            if match[0].startswith("$") or cmd in ("(", "["):
                closing = {"(": r"\)", "[": r"\]"}.get(cmd, match[0])
                end = text.find(closing, pos)
                if end < 0:
                    self.warnings.append("Unclosed math delimiter")
                pos = end + len(closing) if end >= 0 else len(text)
                if cmd == "[" or match[0] == "$$":
                    add("equations", 1)
                buffer.append(" ")
                continue
            if cmd in ("par", "item"):
                flush()
                if cmd == "item":
                    start = skip_space(text, pos)
                    optional = extract_group(text, start, "[")
                    if optional:
                        pos = optional[1]
                continue
            if cmd in SKIP_ARGS or "cite" in cmd:
                pos = skip_arguments(text, pos, SKIP_ARGS.get(cmd, 1))
            elif cmd == "end":
                _, pos = argument(text, pos)
            else:
                buffer.append(match[0])
        if not buffer:
            paragraph_start = pos
        buffer.append(text[pos:])
        flush()
        for section in reversed(sections):
            section["totals"] = dict(section["own"])
            for child in section["children"]:
                for key in METRICS:
                    section["totals"][key] += sections[child]["totals"][key]
        lengths = [p["words"] for p in paragraphs]
        bins = [("1–49", 1, 49), ("50–99", 50, 99), ("100–149", 100, 149),
                ("150–249", 150, 249), ("250+", 250, None)]
        aux = (self.root / self.aux).resolve()
        labels = {}
        if aux.is_relative_to(self.root) and aux.is_file() and aux.stat().st_size < MAX_SOURCE_BYTES:
            for m in re.finditer(r"\\newlabel\{([^}]+)\}\{\{([^{}]*)\}\{(\d+)\}", aux.read_text(encoding="utf-8", errors="replace")):
                labels[m[1]] = {"number": m[2], "page": int(m[3])}
        for collection in (figures, tables):
            for index, item in enumerate(collection):
                item["index"] = index + 1
                item["compiled"] = labels.get(item["label"])
        return {
            "totals": {**sections[0]["totals"], "sections": len(sections) - 1, "files": len(self.files)},
            "sections": sections, "paragraphs": paragraphs, "figures": figures, "tables": tables,
            "paragraph_summary": {"mean": round(statistics.mean(lengths), 1) if lengths else 0,
                                  "median": statistics.median(lengths) if lengths else 0,
                                  "max": max(lengths, default=0),
                                  "histogram": [{"label": label, "min": lo, "max": hi,
                                                 "count": sum(lo <= n and (hi is None or n <= hi) for n in lengths)}
                                                for label, lo, hi in bins]},
            "warnings": list(dict.fromkeys(self.warnings)),
            "notes": list(dict.fromkeys(self.notes)),
            "unsaved_files": sorted(set(self.overrides) & self.files.keys()),
        }


LANGUAGES = {
    "LaTeX": ".tex .sty .cls .ltx .def .bbx .cbx", "Bibliography": ".bib",
    "Python": ".py .pyw", "Julia": ".jl", "JavaScript": ".js .mjs .cjs",
    "TypeScript": ".ts .tsx", "HTML": ".html .htm", "CSS": ".css .scss",
    "Markdown": ".md .markdown", "PowerShell": ".ps1 .psm1 .psd1",
    "Shell / Batch": ".sh .bash .bat .cmd", "C / C++": ".c .cpp .h .hpp .cc",
    "Configuration / Data": ".json .yaml .yml .toml .csv .xml .ini .cfg .txt",
    "Images": ".png .jpg .jpeg .svg .webp .gif .eps .tiff", "PDF": ".pdf",
}
BINARY_GROUPS = {"Images", "PDF", "Other / Binary"}
EXCLUDED = {".git", "node_modules", "build", "OUT", ".venv", "venv", "env", "__pycache__", ".pytest_cache"}


def repository_composition(root):
    root = Path(root).resolve()
    warnings = []
    try:
        result = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                                cwd=root, capture_output=True, timeout=15, check=True,
                                **hidden_subprocess_kwargs())
        paths = sorted(set(result.stdout.decode("utf-8", errors="replace").split("\0")) - {""})
        scope = "Tracked + untracked, non-ignored files (generated/cache folders excluded)"
    except (OSError, subprocess.SubprocessError):
        paths = []
        for directory, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = [d for d in dirs if d not in EXCLUDED and not (Path(directory) / d).is_symlink()]
            paths.extend((Path(directory) / f).relative_to(root).as_posix() for f in files)
        scope = "Filesystem fallback; Git ignore rules unavailable (generated/cache folders excluded)"
    groups = {}
    for relative in paths:
        file = root / relative
        if any(part in EXCLUDED for part in Path(relative).parts):
            continue
        try:
            if not file.resolve().is_relative_to(root) or not file.is_file():
                continue
            size = file.stat().st_size
        except OSError:
            warnings.append("Cannot stat: " + relative)
            continue
        category = next((name for name, exts in LANGUAGES.items() if file.suffix.lower() in exts.split()), "Other / Binary")
        group = groups.setdefault(category, {"name": category, "files": 0, "bytes": 0, "source": category not in BINARY_GROUPS})
        group["files"] += 1
        group["bytes"] += size
    return {"scope": scope, "groups": sorted(groups.values(), key=lambda g: -g["bytes"]),
            "files": sum(g["files"] for g in groups.values()), "bytes": sum(g["bytes"] for g in groups.values()),
            "warnings": warnings}


_REPOSITORY_CACHE = {}
_REPOSITORY_LOCK = threading.Lock()


def cached_repository_composition(root, max_age=20.0):
    """Repository composition walks every file; reuse it for a few seconds."""
    root = Path(root).resolve()
    with _REPOSITORY_LOCK:
        cached = _REPOSITORY_CACHE.get(root)
        if cached and time.monotonic() - cached[0] < max_age:
            return cached[1]
    result = repository_composition(root)
    with _REPOSITORY_LOCK:
        _REPOSITORY_CACHE.clear()
        _REPOSITORY_CACHE[root] = (time.monotonic(), result)
    return result


def get_statistics(root, overrides=None, include_repository=True, main="main.tex", aux="build/main.aux",
                   figure_dirs=("Figures",)):
    if overrides is not None and (not isinstance(overrides, dict) or len(overrides) > 200):
        raise ValueError("overrides must be an object with at most 200 files")
    normalized = {}
    root = Path(root).resolve()
    for key, value in (overrides or {}).items():
        if not isinstance(key, str) or not isinstance(value, str) or len(value.encode("utf-8")) > MAX_SOURCE_BYTES:
            raise ValueError("Each override must be a text source of at most 4 MiB")
        candidate = (root / key).resolve()
        if not candidate.is_relative_to(root) or candidate.suffix.lower() != ".tex":
            raise ValueError("Statistics overrides must be .tex paths inside the repository")
        normalized[candidate.relative_to(root).as_posix()] = value
    started = time.perf_counter()
    document = DocumentScan(root, normalized, main=main, aux=aux, figure_dirs=figure_dirs).scan()
    result = {"generated_at": datetime.now(timezone.utc).isoformat(),
              "document": document,
              "method": {
                  "words": "Estimated prose words: body + headings + captions. Comments, math, references, macro definitions, table cells and generated bibliography/TOC excluded. Macros are not expanded.",
                  "equations": "Display-math blocks, including unnumbered blocks. A multiline align counts once; inline math is excluded.",
                  "paragraphs": "Prose blocks separated by blank lines, explicit paragraph breaks, headings or list items; captions counted separately.",
              }}
    if include_repository:
        result["repository"] = cached_repository_composition(root)
    result["elapsed_ms"] = round((time.perf_counter() - started) * 1000)
    return result
